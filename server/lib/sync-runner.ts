import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index";
import { nodes, syncJobs, type Node, type SyncJob } from "../db/schema";
import { logAuthEvent } from "./auth-log";
import { getOrchestratorKeyPath } from "./ssh";

/**
 * Sync runner — in-memory job manager + SSE bus for rsync orchestration.
 *
 * Single-process assumption: we run one container, so live state is held in
 * memory and persisted to `sync_jobs` only at terminal transitions (and at
 * "running" first-byte). The DB row is the cross-restart truth, the in-memory
 * state is the live truth while we're up.
 *
 * Strategy: orchestrator is the relay. We pull source -> /tmp/sync-staging/
 * <jobId>/, then push to each target sequentially. Two-hop, slower than a
 * direct A->B but it avoids needing per-node trust pairs (the orchestrator's
 * pubkey is already in source AND target's authorized_keys via ssh-setup).
 *
 * NOTE: rpi-dev has limited disk. /tmp staging is cleaned up in the finally
 * block of every job. If a model is bigger than free /tmp space the rsync
 * will fail with "no space left on device" — that's surfaced in the log.
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
  stagingDir: string;
}

// ── State ────────────────────────────────────────────────────────────────

const jobs = new Map<string, LiveJob>();
const TERMINAL: ReadonlyArray<SyncJob["status"]> = ["done", "failed", "canceled"];

const STAGING_ROOT = join(tmpdir(), "thecompai-sync-staging");

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

  const stagingDir = join(STAGING_ROOT, row.id);

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
    stagingDir,
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

  // Resolve nodes (validated at API layer, but we fetch them here too for
  // ip/sshUser/modelPath access).
  const [sourceNode] = await db
    .select()
    .from(nodes)
    .where(eq(nodes.id, live.sourceNodeId))
    .limit(1);
  const targetNodes: Node[] = [];
  for (const tid of live.targetNodeIds) {
    const [n] = await db.select().from(nodes).where(eq(nodes.id, tid)).limit(1);
    if (n) targetNodes.push(n);
  }

  if (!sourceNode || targetNodes.length === 0) {
    await markStatus(live, "failed", "source or targets not found");
    return;
  }

  await mkdir(live.stagingDir, { recursive: true, mode: 0o700 });
  let overallOk = true;

  try {
    // ── Pull source -> staging ───────────────────────────────────────────
    await markStatus(live, "running");
    appendLog(live, null, `[sync] pulling ${live.modelPath} from ${sourceNode.name} (${sourceNode.ip})`);

    const pullOk = await runRsync(
      live,
      sourceNode.id,
      [
        "-avz",
        "--info=progress2",
        "--no-inc-recursive",
        "-e",
        sshArg(keyPath),
        `${sourceNode.sshUser}@${sourceNode.ip}:${joinRemote(sourceNode.modelPath, live.modelPath)}/`,
        `${live.stagingDir}/`,
      ],
    );
    if (!pullOk) {
      overallOk = false;
    } else {
      // ── Push staging -> each target sequentially ─────────────────────
      for (const t of targetNodes) {
        if (live.canceled) break;
        appendLog(live, t.id, `[sync] pushing to ${t.name} (${t.ip})`);
        live.progress = 0;
        emit(live, { type: "progress", target: t.id, percent: 0 });

        const pushOk = await runRsync(
          live,
          t.id,
          [
            "-avz",
            "--info=progress2",
            "--no-inc-recursive",
            "-e",
            sshArg(keyPath),
            `${live.stagingDir}/`,
            `${t.sshUser}@${t.ip}:${joinRemote(t.modelPath, live.modelPath)}/`,
          ],
        );
        if (!pushOk) overallOk = false;
      }
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
    // Best-effort staging cleanup. Failure here is logged but not fatal.
    try {
      await rm(live.stagingDir, { recursive: true, force: true });
    } catch (err) {
      console.error("[sync-runner] staging cleanup failed:", err);
    }
    // Drop subscribers — SSE handler should have unwound already.
    live.subscribers.clear();
    // Keep the LiveJob entry around briefly so getJob can still merge live
    // state, then drop it 60s later.
    setTimeout(() => jobs.delete(live.id), 60_000).unref?.();
  }
}

/**
 * Spawn rsync, stream stdout/stderr. Resolves to true on exit code 0,
 * false otherwise. `targetId` is only for tagging emitted events — for the
 * pull phase we use the source's id.
 */
function runRsync(
  live: LiveJob,
  targetId: string,
  args: string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    let stdoutBuf = "";
    const child = spawn("rsync", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    live.child = child;
    live.currentTarget = targetId;

    const consumeProgress = (chunk: string) => {
      stdoutBuf += chunk;
      // rsync --info=progress2 emits lines/CRs like:
      //   "      4,194,304  12%   12.34MB/s    0:00:42"
      // We split on \r and \n to catch both forms.
      const lines = stdoutBuf.split(/[\r\n]/);
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        appendLog(live, targetId, line);
        const m = /(\d+)%/.exec(line);
        if (m) {
          const pct = Math.min(100, Math.max(0, parseInt(m[1], 10)));
          if (pct !== live.progress) {
            live.progress = pct;
            emit(live, { type: "progress", target: targetId, percent: pct });
          }
        }
      }
    };

    child.stdout?.on("data", (d: Buffer) => consumeProgress(d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) appendLog(live, targetId, line);
      }
    });

    child.on("error", (err) => {
      appendLog(live, targetId, `[sync] spawn error: ${err.message}`);
      live.child = null;
      resolve(false);
    });

    child.on("close", (code) => {
      // Flush any tail buffered without a newline.
      if (stdoutBuf.trim()) appendLog(live, targetId, stdoutBuf);
      stdoutBuf = "";
      live.child = null;
      if (code === 0) {
        live.progress = 100;
        emit(live, { type: "progress", target: targetId, percent: 100 });
        resolve(true);
      } else {
        appendLog(live, targetId, `[sync] rsync exit ${code}`);
        resolve(false);
      }
    });
  });
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

function sshArg(keyPath: string): string {
  // -e value passed as a single arg; rsync re-parses with shell-style quoting.
  return `ssh -i ${keyPath} -o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=15`;
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
