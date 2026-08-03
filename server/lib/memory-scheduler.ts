/**
 * Compile trigger orchestration. Two independent mechanisms:
 *
 * 1. **Time-scheduled slots** — 06:00 / 12:30 (global wiki) and 19:00
 *    (project memory) in the configured TZ. Fires `triggerCompile` for
 *    each user who had chat activity in the last 24h, catching quiet
 *    conversations (Hermes / Talk) and giving a baseline daily refresh.
 *
 * 2. **Inactivity-based** — when a chat conv goes quiet for
 *    `MEMORY_INACTIVITY_COMPILE_MS` (default 10 min), we fire one
 *    compile for that conv. Registered from `chat.ts` after each
 *    assistant message completes; the timer is reset by every new
 *    activity, so a chatty conv only triggers ONE compile after the
 *    user stops engaging (≈ "compile quand je quitte le chat").
 *
 * This replaces the previous per-message `triggerCompile` call in
 * chat.ts, which was hammering the local Inferencer and causing chat
 * latency contention.
 *
 * Safe vs KV cache: triggerCompile only writes to the wiki repo on the
 * memory service side — never to `conversations.memorySnapshot`. Existing
 * conversations keep their frozen prefix. Only NEW conversations created
 * after a refresh see the updated wiki.
 *
 * Per-user pick (time-scheduled global slots): we trigger against the
 * user's most-recently-touched conversation. The memory service uses
 * that conversation as the source context for the compile pass.
 */

import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/index";
import { conversations, users } from "../db/schema";
import { compileNow } from "./memory";
import {
  compileProject,
  listEligibleProjects,
} from "./project-compile";

// Memory is always RAG now: the compiler (Karpathy) turns conversations into
// structured memory that is then INGESTED into nemo (compileNow does both —
// compile + nemoSyncWiki). So every slot compiles; there is no wiki-backend
// gate any more. Compiles run sequentially per user — this is a background
// cron, latency is irrelevant, and serial keeps load off the extraction LLM.

const SCHEDULE_TZ = process.env.MEMORY_SCHEDULER_TZ ?? "UTC";
/** Local-clock targets. Order doesn't matter — we check all on every
 *  tick. `kind` selects which compile to fire: global wiki at 06:00 /
 *  12:30, project memory at 19:00. (User directive 2026-05-16: shift
 *  compile out of the chat hot-path; cron + inactivity replace the
 *  per-message trigger.) */
const SLOTS: Array<{ h: number; m: number; label: string; kind: "global" | "project" }> = [
  { h: 6, m: 0, label: "06:00", kind: "global" },
  { h: 12, m: 30, label: "12:30", kind: "global" },
  { h: 19, m: 0, label: "19:00", kind: "project" },
];
/** Polling cadence. Every 60s is enough — we only need ±1min accuracy. */
const TICK_MS = 60_000;
/** Activity window. Skip users idle for longer than this. */
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Idle duration after which a registered conv triggers a compile.
 *  Refreshed by every assistant turn — only fires once the user stops
 *  chatting. Default 10 min; bump via env if Inferencer is still
 *  contended. */
const INACTIVITY_COMPILE_MS = Number(
  process.env.MEMORY_INACTIVITY_COMPILE_MS ?? 10 * 60 * 1000,
);

let started = false;
/** Per-slot last-fired YYYY-MM-DD so we don't refire after a process restart
 *  that lands during the same minute. */
const lastFiredDate = new Map<string, string>();

/** Convs awaiting an inactivity compile.
 *  key = conversationId, value = { userId, lastActivityAt }.
 *  Refreshed by `registerInactivityCompile`, drained by `inactivityTick`. */
const pendingInactivity = new Map<
  string,
  { userId: string; lastActivityAt: number }
>();

/**
 * Mark a conversation as a candidate for inactivity-based compile.
 * Called by `chat.ts` after each assistant message persists. Idempotent
 * — calling repeatedly just resets the timer, so a chatty conv only
 * compiles after the user actually stops engaging.
 *
 * Lost on process restart (in-memory Map). Acceptable: the time-scheduled
 * slots (06/12:30/19) backstop any conv that escaped a restart.
 */
export function registerInactivityCompile(
  userId: string,
  conversationId: string,
): void {
  pendingInactivity.set(conversationId, {
    userId,
    lastActivityAt: Date.now(),
  });
}

/**
 * Returns the current `{ year, month, day, hour, minute }` parts in the
 * configured timezone. Built via Intl.DateTimeFormat — no extra deps.
 */
function nowInTz(): {
  date: string; // YYYY-MM-DD
  hour: number;
  minute: number;
} {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: SCHEDULE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour ?? "0", 10),
    minute: parseInt(parts.minute ?? "0", 10),
  };
}

async function runGlobalSlot(slotLabel: string): Promise<void> {
  const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
  const activeUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(gte(users.lastInteractionAt, since));
  if (activeUsers.length === 0) {
    console.log(
      `[memory-scheduler] slot=${slotLabel} (global) no active users`,
    );
    return;
  }
  const userIds = activeUsers.map((u) => u.id);

  // Latest ELIGIBLE conversation per active user in ONE round-trip via
  // DISTINCT ON (was N+1: a separate query per active user) (#7).
  // memoryEnabled/kind are filtered HERE too: the slot used to compile the
  // latest conv regardless of its memory toggle, silently bypassing every
  // registration-time guard — that's the hole through which a fiction
  // benchmark session entered the biographical wiki (2026-06-12).
  const latest = await db
    .selectDistinctOn([conversations.userId], {
      userId: conversations.userId,
      id: conversations.id,
    })
    .from(conversations)
    .where(
      and(
        inArray(conversations.userId, userIds),
        eq(conversations.memoryEnabled, true),
        eq(conversations.kind, "chat"),
        // v2.0: a sub-conversation NEVER compiles its own memory — its
        // content reaches the wiki only through the parent's task card
        // summary if at all.
        isNull(conversations.parentId),
      ),
    )
    .orderBy(conversations.userId, desc(conversations.updatedAt));

  let triggered = 0;
  for (const conv of latest) {
    await compileNow(conv.userId, conv.id); // compiles + ingests into nemo RAG
    triggered++;
  }
  console.log(
    `[memory-scheduler] slot=${slotLabel} (global) compiled ${triggered} users into RAG`,
  );
}

async function runProjectSlot(slotLabel: string): Promise<void> {
  const eligible = await listEligibleProjects(ACTIVE_WINDOW_MS);
  if (eligible.length === 0) {
    console.log(
      `[memory-scheduler] slot=${slotLabel} (project) no eligible projects`,
    );
    return;
  }
  let ok = 0;
  for (const p of eligible) {
    const status = await compileProject(p);
    console.log(
      `[memory-scheduler] slot=${slotLabel} (project) project=${p.id} ${status}`,
    );
    if (status.startsWith("wrote ")) ok++;
  }
  console.log(
    `[memory-scheduler] slot=${slotLabel} (project) ${ok}/${eligible.length} compiled`,
  );
}

function tick(): void {
  const now = nowInTz();
  for (const slot of SLOTS) {
    if (now.hour !== slot.h || now.minute !== slot.m) continue;
    if (lastFiredDate.get(slot.label) === now.date) continue;
    lastFiredDate.set(slot.label, now.date);
    const runner =
      slot.kind === "project"
        ? runProjectSlot(slot.label)
        : runGlobalSlot(slot.label);
    void runner.catch((err) => {
      console.error(
        `[memory-scheduler] slot=${slot.label} (${slot.kind}) failed:`,
        err,
      );
    });
  }
  void inactivityTick().catch((err) => {
    console.error("[memory-scheduler] inactivityTick failed:", err);
  });
}

/** Scan pendingInactivity and fire `triggerCompile` for convs idle
 *  beyond INACTIVITY_COMPILE_MS. Each conv fires exactly once per idle
 *  period — re-registers (next assistant turn) reset the clock. */
async function inactivityTick(): Promise<void> {
  const now = Date.now();
  for (const [convId, entry] of pendingInactivity) {
    if (now - entry.lastActivityAt < INACTIVITY_COMPILE_MS) continue;
    pendingInactivity.delete(convId);
    try {
      await compileNow(entry.userId, convId); // compiles + ingests into nemo RAG
      const idleS = Math.round((now - entry.lastActivityAt) / 1000);
      console.log(
        `[memory-scheduler] inactivity compiled conv=${convId} idle=${idleS}s into RAG`,
      );
    } catch (err) {
      console.error(
        `[memory-scheduler] inactivity compile failed conv=${convId}:`,
        err,
      );
    }
  }
}

/** Start the scheduler. Idempotent — calling twice is a no-op. */
// ── v2.0 retention purge ──────────────────────────────────────────────
// run_events + agent_spans keep 30 days. Batched deletes (LIMIT via
// id-subquery — Postgres DELETE has no LIMIT) so a backlog never takes a
// long lock; the BRIN index on created_at keeps the scan cheap. Runs
// every 6h; a missing table (pre-migration boot order) is ignored.
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PURGE_BATCH = 10_000;
const RETENTION_DAYS = 30;

async function purgeAgentTelemetry(): Promise<void> {
  const targets = [
    { table: "run_events", pk: "id" },
    { table: "agent_spans", pk: "span_id" },
  ] as const;
  for (const { table, pk } of targets) {
    try {
      // Loop batches until a pass deletes fewer than the batch size.
      for (let i = 0; i < 50; i++) {
        const res = await db.execute(sql`
          DELETE FROM ${sql.raw(table)} WHERE ${sql.raw(pk)} IN (
            SELECT ${sql.raw(pk)} FROM ${sql.raw(table)}
            WHERE created_at < now() - interval '${sql.raw(String(RETENTION_DAYS))} days'
            LIMIT ${PURGE_BATCH}
          )`);
        const n = (res as unknown as { rowCount?: number }).rowCount ?? 0;
        if (n > 0) console.log(`[purge] ${table}: deleted ${n}`);
        if (n < PURGE_BATCH) break;
      }
    } catch (err) {
      // Table absent (fresh install mid-migration) or transient — skip.
      console.warn(`[purge] ${table} skipped:`, (err as Error).message);
    }
  }

  // v3 turn_states: one durable row per conversation (cascade-deleted with
  // the conv, so already bounded), but a SETTLED row for a conversation
  // untouched for RETENTION_DAYS is dead weight — it is re-created on the
  // next turn. Purge terminal rows by updated_at; NEVER touch an active one.
  try {
    for (let i = 0; i < 50; i++) {
      const res = await db.execute(sql`
        DELETE FROM turn_states WHERE conversation_id IN (
          SELECT conversation_id FROM turn_states
          WHERE status <> 'active'
            AND updated_at < now() - interval '${sql.raw(String(RETENTION_DAYS))} days'
          LIMIT ${PURGE_BATCH}
        )`);
      const n = (res as unknown as { rowCount?: number }).rowCount ?? 0;
      if (n > 0) console.log(`[purge] turn_states: deleted ${n}`);
      if (n < PURGE_BATCH) break;
    }
  } catch (err) {
    console.warn(`[purge] turn_states skipped:`, (err as Error).message);
  }
}

export function startMemoryScheduler(): void {
  if (started) return;
  started = true;
  void purgeAgentTelemetry();
  setInterval(() => void purgeAgentTelemetry(), PURGE_INTERVAL_MS);
  console.log(
    `[memory-scheduler] started (tz=${SCHEDULE_TZ}, slots=${SLOTS.map(
      (s) => `${s.label}/${s.kind}`,
    ).join(", ")}, inactivity=${Math.round(INACTIVITY_COMPILE_MS / 1000)}s)`,
  );
  // Run once immediately so a restart within the firing minute doesn't
  // miss the slot.
  tick();
  setInterval(tick, TICK_MS);
}
