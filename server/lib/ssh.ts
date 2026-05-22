import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Orchestrator SSH helpers.
 *
 * - Lazily generates an ed25519 keypair the first time it's needed.
 * - Wraps `ssh` (and `sshpass` for password bootstrap) with a small
 *   spawn-based interface that returns stdout/stderr/code.
 *
 * Assumes `ssh` and `ssh-keygen` exist on the host. `sshpass` may not be
 * present — we surface a clear error in that case.
 */

const KEY_DIR = process.getuid && process.getuid() === 0
  ? "/root/.companion"
  : join(homedir(), ".companion");

const KEY_PATH = join(KEY_DIR, "orchestrator_ed25519");
const PUB_KEY_PATH = `${KEY_PATH}.pub`;

let keygenPromise: Promise<void> | null = null;

async function ensureKey(): Promise<void> {
  if (existsSync(KEY_PATH) && existsSync(PUB_KEY_PATH)) return;
  if (keygenPromise) return keygenPromise;
  keygenPromise = (async () => {
    await mkdir(dirname(KEY_PATH), { recursive: true, mode: 0o700 });
    await runProc(
      "ssh-keygen",
      [
        "-t", "ed25519",
        "-N", "",
        "-f", KEY_PATH,
        "-C", "companion-orchestrator",
      ],
      30_000,
    );
  })();
  try {
    await keygenPromise;
  } finally {
    keygenPromise = null;
  }
}

export async function getOrchestratorPubkey(): Promise<string> {
  await ensureKey();
  const buf = await readFile(PUB_KEY_PATH, "utf8");
  return buf.trim();
}

export async function getOrchestratorKeyPath(): Promise<string> {
  await ensureKey();
  return KEY_PATH;
}

/**
 * Boots a singleton ssh-agent process inside the container, loads the
 * orchestrator key into it, and returns the SSH_AUTH_SOCK path so callers
 * can spawn ssh/rsync with `-A` (agent forwarding).
 *
 * This is what enables direct A→B rsync without per-node key distribution
 * and without staging through the orchestrator's disk: ssh-A forwards the
 * orchestrator's loaded key down to source A; A's rsync invokes ssh to
 * target B; that ssh authenticates via the forwarded agent (which has the
 * orchestrator's key); B accepts because the orchestrator's pubkey is in
 * B's authorized_keys (installed during ssh-setup).
 *
 * Requires `AllowAgentForwarding yes` on each node's sshd. macOS default
 * is yes; Linux dev distros default yes too.
 */
let agentSock: string | null = null;
let agentBootPromise: Promise<string> | null = null;

export async function ensureSshAgent(): Promise<string> {
  if (agentSock) return agentSock;
  if (agentBootPromise) return agentBootPromise;
  agentBootPromise = (async () => {
    const keyPath = await getOrchestratorKeyPath();
    // Start ssh-agent and capture SSH_AUTH_SOCK from its stdout.
    const out = await runProc("ssh-agent", ["-s"], 5_000);
    if (out.code !== 0) {
      throw new Error(`ssh-agent failed: ${out.stderr || out.stdout}`);
    }
    const sockMatch = /SSH_AUTH_SOCK=([^;]+);/.exec(out.stdout);
    if (!sockMatch) {
      throw new Error(`ssh-agent malformed output: ${out.stdout}`);
    }
    const sock = sockMatch[1];
    // Load the orchestrator key into the agent. Pass SSH_AUTH_SOCK in env
    // so ssh-add talks to the freshly-started agent.
    const add = await runProc(
      "ssh-add",
      [keyPath],
      5_000,
      { env: { ...process.env, SSH_AUTH_SOCK: sock } as NodeJS.ProcessEnv },
    );
    if (add.code !== 0) {
      throw new Error(`ssh-add failed: ${add.stderr || add.stdout}`);
    }
    agentSock = sock;
    return sock;
  })();
  try {
    return await agentBootPromise;
  } finally {
    agentBootPromise = null;
  }
}


export interface SshNode {
  ip: string;
  sshUser: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunSshOpts {
  /** Use sshpass + plaintext password instead of key-based auth. */
  usePassword?: boolean;
  /** Decrypted password — required when usePassword is true. */
  password?: string;
  /** Override default 60s timeout (ms). */
  timeoutMs?: number;
}

/**
 * Run a single command on a remote node over SSH. Resolves with stdout/stderr
 * and exit code; rejects only on spawn-level failures (e.g. binary missing).
 */
export async function runSsh(
  node: SshNode,
  command: string,
  opts: RunSshOpts = {},
): Promise<RunResult> {
  const target = `${node.sshUser}@${node.ip}`;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  if (opts.usePassword) {
    if (!opts.password) {
      throw new Error("runSsh: usePassword=true but no password provided");
    }
    // Force password auth: macOS sshd advertises both `password` AND
    // `keyboard-interactive`, and sshpass sometimes fails to feed its
    // password into the keyboard-interactive flow. We also disable
    // pubkey + GSSAPI explicitly so ssh doesn't burn time trying them
    // first when the orchestrator key isn't yet on the node.
    const args = [
      "-p", opts.password,
      "ssh",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=15",
      "-o", "PreferredAuthentications=password",
      "-o", "PubkeyAuthentication=no",
      "-o", "GSSAPIAuthentication=no",
      "-o", "NumberOfPasswordPrompts=1",
      "-T",
      target,
      command,
    ];
    try {
      return await runProc("sshpass", args, timeoutMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "sshpass missing — install on the orchestrator host " +
            "(`apt-get install sshpass` on Debian/Ubuntu) to bootstrap " +
            "nodes via password.",
        );
      }
      throw err;
    }
  }

  const keyPath = await getOrchestratorKeyPath();
  const args = [
    "-i", keyPath,
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "-T",
    target,
    command,
  ];
  return runProc("ssh", args, timeoutMs);
}

/**
 * Install the orchestrator's pubkey on a remote's authorized_keys via
 * `ssh-copy-id`. The canonical bootstrap path: ssh-copy-id handles
 * ~/.ssh creation, mode bits, dedup, and the right authentication
 * negotiation that bare ssh + echo gets wrong on macOS sshd
 * (which advertises both `password` and `keyboard-interactive`).
 *
 * Mirrors what Starbase does and ships in production on the Companion host.
 */
export async function runSshCopyId(
  node: SshNode,
  password: string,
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const keyPath = await getOrchestratorKeyPath();
  const target = `${node.sshUser}@${node.ip}`;
  const args = [
    "-p", password,
    "ssh-copy-id",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    "-i", `${keyPath}.pub`,
    target,
  ];
  try {
    return await runProc("sshpass", args, timeoutMs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "sshpass missing — install on the orchestrator host to bootstrap nodes via password.",
      );
    }
    throw err;
  }
}

function runProc(
  bin: string,
  args: string[],
  timeoutMs: number,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      resolve({
        stdout,
        stderr: stderr + `\n[timeout after ${timeoutMs}ms]`,
        code: 124,
      });
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1 });
    });
  });
}
