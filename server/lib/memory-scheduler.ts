/**
 * Scheduled memory-wiki refresh.
 *
 * Three times a day (07:00 / 12:30 / 20:00 in the configured TZ) we fire
 * `triggerCompile` for each user who had chat activity in the last 24h.
 * This catches users whose only recent conversations are Talk or Hermes
 * (which skip the per-turn trigger), and provides a routine baseline
 * refresh even on quiet days.
 *
 * Safe vs KV cache: triggerCompile only writes to the wiki repo on the
 * memory service side — never to `conversations.memorySnapshot`. Existing
 * conversations keep their frozen prefix. Only NEW conversations created
 * after a refresh see the updated wiki.
 *
 * Per-user pick: we trigger against the user's most-recently-touched
 * conversation. The memory service uses that conversation as the source
 * context for the compile pass.
 */

import { desc, eq, gte } from "drizzle-orm";
import { db } from "../db/index";
import { conversations, users } from "../db/schema";
import { triggerCompile } from "./memory";

const SCHEDULE_TZ = process.env.MEMORY_SCHEDULER_TZ ?? "Europe/Brussels";
/** Local-clock targets. Order doesn't matter — we check all on every tick. */
const SLOTS = [
  { h: 7, m: 0, label: "07:00" },
  { h: 12, m: 30, label: "12:30" },
  { h: 20, m: 0, label: "20:00" },
];
/** Polling cadence. Every 60s is enough — we only need ±1min accuracy. */
const TICK_MS = 60_000;
/** Activity window. Skip users idle for longer than this. */
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

let started = false;
/** Per-slot last-fired YYYY-MM-DD so we don't refire after a process restart
 *  that lands during the same minute. */
const lastFiredDate = new Map<string, string>();

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

async function runSlot(slotLabel: string): Promise<void> {
  const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
  // Users with activity in the last 24h.
  const activeUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(gte(users.lastInteractionAt, since));

  let triggered = 0;
  for (const u of activeUsers) {
    // Pick the user's most recently touched conversation as the compile
    // source. Skip if they have none.
    const [conv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.userId, u.id))
      .orderBy(desc(conversations.updatedAt))
      .limit(1);
    if (!conv) continue;
    triggerCompile(u.id, conv.id);
    triggered++;
  }
  console.log(
    `[memory-scheduler] slot=${slotLabel} fired triggerCompile for ${triggered} users`,
  );
}

function tick(): void {
  const now = nowInTz();
  for (const slot of SLOTS) {
    if (now.hour !== slot.h || now.minute !== slot.m) continue;
    if (lastFiredDate.get(slot.label) === now.date) continue;
    lastFiredDate.set(slot.label, now.date);
    // Don't await — runSlot can be slow on a big user table.
    void runSlot(slot.label).catch((err) => {
      console.error(
        `[memory-scheduler] slot=${slot.label} runSlot failed:`,
        err,
      );
    });
  }
}

/** Start the scheduler. Idempotent — calling twice is a no-op. */
export function startMemoryScheduler(): void {
  if (started) return;
  started = true;
  console.log(
    `[memory-scheduler] started (tz=${SCHEDULE_TZ}, slots=${SLOTS.map((s) => s.label).join(", ")})`,
  );
  // Run once immediately so a restart within the firing minute doesn't
  // miss the slot.
  tick();
  setInterval(tick, TICK_MS);
}
