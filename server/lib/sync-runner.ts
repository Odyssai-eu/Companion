import { spawn, type ChildProcess } from "node:child_process";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { nodes, syncJobs, type Node, type SyncJob } from "../db/schema";
import { logAuthEvent } from "./auth-log";
import { ensureSshAgent, getOrchestratorKeyPath } from "./ssh";

/**
 * Sync runner — in-memory job manager + SSE bus for rsync orchestration.
 *
 * Single-process assumption: we run one container, so live state is held in
 * memory and persisted to `sync_jobs` only at terminal transitions (and at
 * "running" first-byte). The DB row is the cross-restart truth, the in-memory
 * state is the live truth while we're up.
 *
 * Strategy — DIRECT A→B via SSH agent forwarding (no orchestrator staging).
 * For each target T, we run on the orchestrator:
 *
 *   ssh -A -i orch_key src-user@SOURCE_IP \
 *       'rsync -avz --info=progress2 -e "ssh -o StrictHostKeyChecking=accept-new" \
 *        SOURCE_PATH/SUB/ tgt-user@TARGET_IP:TARGET_PATH/SUB/'
 *
 * The `-A` forwards the orchestrator's loaded ssh-agent down to SOURCE,
 * so the inner rsync's ssh-out to TARGET authenticates with the
 * orchestrator's key (which is already in TARGET's authorized_keys via
 * ssh-setup). No per-pair node keys, no transit through the orchestrator's
 * disk. Rsync streams source filesystem → SSH → target filesystem.
 *
 * Requires `AllowAgentForwarding yes` on each node's sshd. macOS default is
 * yes; Linux dev distros default yes too.
 *
 * v1 simplifications:
 *   - Targets run sequentially (one at a time). Cleaner progress, less IO.
 *   - We only track the percent of the *current target's rsync* in
 *     liveProgress. The DB `progress` column is also that single number.
 *   - We don't tail bytes-transferred; we look for `--info=progress2`'s
 *     "  XX%" pattern in stdout. If we never see one, progress stays at 0
 *     and the job still terminates correctly on rsync exit.
 */

// ── Types ────────────────────────────────────────────────────────────────

export type SyncEvent =
  | { type: "progress"; target: string; percent: number }
  | { type: "log"; target: string | null; line: string }
  | { type: "status"; status: SyncJob["status"] };

type Handler = (ev: SyncEvent) => void;

interface LiveJob {
  id: string;
  userId: string;
  sourceNodeId: string;
  targetNodeIds: string[];
  modelPath: string;
  groupId: string | null;
  status: SyncJob["status"];
  /** percent of the current rsync (0-100) */
  progress: number;
  /** Full log buffer (we truncate to 4KB when writing to DB). */
  logBuf: string;
  currentTarget: string | null;
  child: ChildProcess | null;
  canceled: boolean;
  subscribers: Set<Handler>;
}

// ── State ────────────────────────────────────────────────────────────────

const jobs = new Map<string, LiveJob>();
const TERMINAL: ReadonlyArray<SyncJob["status"]> = ["done", "failed", "canceled"];

// ── Public API ───────────────────────────────────────────────────────────

export interface StartSyncJobInput {
  userId: string;
  sourceNodeId: string;
  targetNodeIds: string[];
  modelPath: string;
  groupId?: string | null;
}

export async function startSyncJob(
  input: StartSyncJobInput,
): Promise<{ jobId: string }> {
  if (input.targetNodeIds.length === 0) {
    throw new Error("startSyncJob: at least one target required");
  }

  const [row] = await db
    .insert(syncJobs)
    .values({
      userId: input.userId,
      sourceNodeId: input.sourceNodeId,
      targetNodeIds: input.targetNodeIds,
      groupId: input.groupId ?? null,
      modelPath: input.modelPath,
      status: "queued",
      progress: 0,
    })
    .returning();

  const live: LiveJob = {
    id: row.id,
    userId: input.userId,
    sourceNodeId: input.sourceNodeId,
    targetNodeIds: input.targetNodeIds,
    modelPath: input.modelPath,
    groupId: input.groupId ?? null,
    status: "queued",
    progress: 0,
    logBuf: "",
    currentTarget: null,
    child: null,
    canceled: false,
    subscribers: new Set(),
  };
  jobs.set(row.id, live);

  // Fire-and-forget — runner reports back via DB + SSE.
  void runJob(live).catch((err) => {
    console.error("[sync-runner] runJob failed unexpectedly:", err);
  });

  return { jobId: row.id };
}

export async function getJob(jobId: string): Promise<
  | (SyncJob & {
      liveProgress?: number;
      liveLog?: string;
      currentTarget?: string | null;
    })
  | null
> {
  const [row] = await db
    .select()
    .from(syncJobs)
    .where(eq(syncJobs.id, jobId))
    .limit(1);
  if (!row) return null;

  const live = jobs.get(jobId);
  if (!live) return row;
  return {
    ...row,
    status: live.status,
    progress: live.progress,
    liveProgress: live.progress,
    liveLog: tail(live.logBuf, 4096),
    currentTarget: live.currentTarget,
  };
}

export interface ListJobsOpts {
  limit?: number;
  status?: SyncJob["status"];
}

export async function listJobs(
  userId: string,
  opts: ListJobsOpts = {},
): Promise<SyncJob[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = opts.status
    ? and(eq(syncJobs.userId, userId), eq(syncJobs.status, opts.status))
    : eq(syncJobs.userId, userId);

  return db
    .select()
    .from(syncJobs)
    .where(where)
    .orderBy(desc(syncJobs.createdAt))
    .limit(limit);
}

export function subscribe(jobId: string, handler: Handler): () => void {
  const live = jobs.get(jobId);
  if (!live) return () => undefined;
  live.subscribers.add(handler);
  return () => {
    live.subscribers.delete(handler);
  };
}

export async function cancelJob(
  jobId: string,
  userId: string,
): Promise<boolean> {
  const live = jobs.get(jobId);
  if (!live) {
    // Maybe already terminal in DB. Just check ownership and return false
    // to indicate we can't cancel it.
    const [row] = await db
      .select({ id: syncJobs.id, userId: syncJobs.userId, status: syncJobs.status })
      .from(syncJobs)
      .where(eq(syncJobs.id, jobId))
      .limit(1);
    return Boolean(row && row.userId === userId && !TERMINAL.includes(row.status));
  }
  if (live.userId !== userId) return false;
  if (TERMINAL.includes(live.status)) return false;
  live.canceled = true;
  if (live.child) {
    try {
      live.child.kill("SIGTERM");
    } catch {
      /* noop */
    }
  }
  return true;
}

/** Tracks running jobs so we can SIGTERM all children on container exit. */
export function killAllJobs(): void {
  for (const j of jobs.values()) {
    j.canceled = true;
    if (j.child) {
      try {
        j.child.kill("SIGTERM");
      } catch {
        /* noop */
      }
    }
  }
}

// ── Internals ────────────────────────────────────────────────────────────

async function runJob(live: LiveJob): Promise<void> {
  const keyPath = await getOrchestratorKeyPath();
  let agentSock: string;
  try {
    agentSock = await ensureSshAgent();
  } catch (err) {
    appendLog(live, null, `[sync] ssh-agent boot failed: ${(err as Error).message}`);
    await markStatus(live, "failed", "ssh-agent unavailable");
    return;
  }

  // Resolve nodes (validated at API layer, but we fetch them here too for
  // ip/sshUser/modelPath access).
  const [sourceNode] = await db
    .select()
    .from(nodes)
    .where(eq(nodes.id, live.sourceNodeId))
    .limit(1);
  // Fetch all target nodes in one query (was one round-trip per id), then
  // re-order to match targetNodeIds and drop any missing (#7).
  const fetchedNodes = live.targetNodeIds.length
    ? await db.select().from(nodes).where(inArray(nodes.id, live.targetNodeIds))
    : [];
  const nodeById = new Map(fetchedNodes.map((n) => [n.id, n]));
  const targetNodes: Node[] = live.targetNodeIds
    .map((tid) => nodeById.get(tid))
    .filter((n): n is Node => Boolean(n));

  if (!sourceNode || targetNodes.length === 0) {
    await markStatus(live, "failed", "source or targets not found");
    return;
  }
  if (!sourceNode.sshKeySetup) {
    await markStatus(live, "failed", `source ${sourceNode.name} has no SSH key — run setup first`);
    return;
  }

  let overallOk = true;

  try {
    await markStatus(live, "running");
    appendLog(
      live,
      null,
      `[sync] direct mode (A→B via agent forwarding); source=${sourceNode.name} (${sourceNode.ip}), targets=${targetNodes.length}`,
    );

    // ── Push from SOURCE directly to each TARGET ─────────────────────────
    for (const t of targetNodes) {
      if (live.canceled) break;
      if (!t.sshKeySetup) {
        appendLog(live, t.id, `[sync] skipping ${t.name}: SSH key not set up yet`);
        overallOk = false;
        continue;
      }
      appendLog(live, t.id, `[sync] ${sourceNode.name} → ${t.name} (${t.ip})`);
      live.progress = 0;
      emit(live, { type: "progress", target: t.id, percent: 0 });

      const ok = await runRsyncDirect(live, sourceNode, t, keyPath, agentSock);
      if (!ok) overallOk = false;
    }

    if (live.canceled) {
      await markStatus(live, "canceled");
    } else if (overallOk) {
      await markStatus(live, "done");
    } else {
      await markStatus(live, "failed");
    }
  } catch (err) {
    appendLog(live, null, `[sync] fatal: ${(err as Error).message}`);
    await markStatus(live, "failed", (err as Error).message);
  } finally {
    // Drop subscribers — SSE handler should have unwound already.
    live.subscribers.clear();
    // Keep the LiveJob entry around briefly so getJob can still merge live
    // state, then drop it 60s later.
    setTimeout(() => jobs.delete(live.id), 60_000).unref?.();
  }
}

/**
 * Runs:
 *   ssh -A -i orchKey src-user@source-ip 'rsync ... source-path/ user@target-ip:target-path/'
 *
 * Source needs to be able to ssh to target. With agent forwarding, source's
 * inner ssh authenticates via the orchestrator's forwarded agent (the
 * orchestrator key is in target's authorized_keys, installed by ssh-setup).
 * No data ever transits the orchestrator's disk.
 */
function runRsyncDirect(
  live: LiveJob,
  source: Node,
  target: Node,
  keyPath: string,
  agentSock: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sourcePath = joinRemote(source.modelPath, live.modelPath) + "/";
    const targetSpec = `${target.sshUser}@${target.ip}:${joinRemote(target.modelPath, live.modelPath)}/`;
    // The inner rsync runs ON source. Build it as a single shell snippet.
    //
    // macOS ships rsync 2.6.9 which doesn't know `--info=progress2`
    // (introduced in rsync 3.1). Pick the Homebrew rsync (modern) if
    // present on the source — otherwise fall back to the plain
    // `--progress` flag, which both old and new rsync understand. Less
    // smooth UX (per-file progress vs total %) but the regex parser
    // still picks up the `(\d+)%` token correctly.
    const innerSshOpts =
      "ssh -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15";
    // Pick the Homebrew rsync (3.x) if present, otherwise stock macOS
    // rsync (2.6.9). Old rsync doesn't know --info=progress2 OR
    // --no-inc-recursive — gate BOTH together. EXTRA carries any flags
    // that are only safe on rsync 3+.
    const pickRsync =
      '[ -x /opt/homebrew/bin/rsync ] && { RSYNC=/opt/homebrew/bin/rsync; PROG=--info=progress2; EXTRA=--no-inc-recursive; } || { RSYNC=rsync; PROG=--progress; EXTRA=; }';
    const innerRsync = [
      pickRsync,
      "&&",
      "$RSYNC",
      "-avz",
      "$PROG",
      "$EXTRA",
      "-e",
      shellQuote(innerSshOpts),
      shellQuote(sourcePath),
      shellQuote(targetSpec),
    ].join(" ");

    const sshArgs = [
      "-A", // agent forwarding — inner ssh on source uses our forwarded agent
      "-i",
      keyPath,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ForwardAgent=yes",
      `${source.sshUser}@${source.ip}`,
      innerRsync,
    ];

    let stdoutBuf = "";
    const child = spawn("ssh", sshArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SSH_AUTH_SOCK: agentSock } as NodeJS.ProcessEnv,
    });
    live.child = child;
    live.currentTarget = target.id;

    const consumeProgress = (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/[\r\n]/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        appendLog(live, target.id, line);
        const m = /(\d+)%/.exec(line);
        if (m) {
          const pct = Math.min(100, Math.max(0, parseInt(m[1], 10)));
          if (pct !== live.progress) {
            live.progress = pct;
            emit(live, { type: "progress", target: target.id, percent: pct });
          }
        }
      }
    };

    child.stdout?.on("data", (d: Buffer) => consumeProgress(d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendLog(live, target.id, line);
      }
    });

    child.on("error", (err) => {
      appendLog(live, target.id, `[sync] spawn error: ${err.message}`);
      live.child = null;
      resolve(false);
    });

    child.on("close", (code) => {
      if (stdoutBuf.trim()) appendLog(live, target.id, stdoutBuf);
      stdoutBuf = "";
      live.child = null;
      if (code === 0) {
        live.progress = 100;
        emit(live, { type: "progress", target: target.id, percent: 100 });
        resolve(true);
      } else {
        appendLog(live, target.id, `[sync] ssh/rsync exit ${code}`);
        resolve(false);
      }
    });
  });
}

/**
 * Single-quote a string for safe inclusion in a remote shell command.
 * Wraps in single quotes; escapes any embedded single quotes by closing
 * the quote, inserting `\'`, and reopening.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function markStatus(
  live: LiveJob,
  status: SyncJob["status"],
  errMsg?: string,
): Promise<void> {
  if (live.status === status) return;
  live.status = status;
  if (errMsg) appendLog(live, null, `[sync] ${errMsg}`);

  const set: Partial<typeof syncJobs.$inferInsert> = {
    status,
    progress: live.progress,
    log: tail(live.logBuf, 4096),
  };
  const now = new Date();
  if (status === "running") {
    set.startedAt = now;
  }
  if (TERMINAL.includes(status)) {
    set.finishedAt = now;
  }
  try {
    await db.update(syncJobs).set(set).where(eq(syncJobs.id, live.id));
  } catch (err) {
    console.error("[sync-runner] DB status update failed:", err);
  }
  emit(live, { type: "status", status });

  if (status === "done" || status === "failed") {
    logAuthEvent({
      userId: live.userId,
      event: status === "done" ? "sync.done" : "sync.failed",
      meta: {
        jobId: live.id,
        sourceNodeId: live.sourceNodeId,
        targetCount: live.targetNodeIds.length,
        modelPath: live.modelPath,
      },
    });
  }
}

function appendLog(
  live: LiveJob,
  target: string | null,
  line: string,
): void {
  const trimmed = line.replace(/\s+$/, "");
  if (!trimmed) return;
  live.logBuf += trimmed + "\n";
  // Cap in-memory buffer at 64KB (DB stores last 4KB).
  if (live.logBuf.length > 65_536) {
    live.logBuf = live.logBuf.slice(-65_536);
  }
  emit(live, { type: "log", target, line: trimmed });
}

function emit(live: LiveJob, ev: SyncEvent): void {
  for (const h of live.subscribers) {
    try {
      h(ev);
    } catch (err) {
      console.error("[sync-runner] subscriber threw:", err);
    }
  }
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(-max);
}

function joinRemote(base: string, sub: string): string {
  // Don't lstrip leading '~' — let the remote shell expand it.
  const b = base.replace(/\/+$/, "");
  const s = sub.replace(/^\/+/, "").replace(/\/+$/, "");
  return s ? `${b}/${s}` : b;
}

// ── Process exit hook (kill children to avoid zombies) ───────────────────

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const handler = () => {
    killAllJobs();
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  process.on("exit", handler);
}
installExitHook();

export function isTerminal(status: SyncJob["status"]): boolean {
  return TERMINAL.includes(status);
}
