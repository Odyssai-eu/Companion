// Run events — the live-narration rail of the v2.0 agent runtime.
//
// Two halves:
//  1. Persistence: append-only inserts into `run_events` (30-day
//     retention, purged by the memory-scheduler job). Replay source for
//     a page that reloads mid-task.
//  2. Broker: an in-process pub/sub keyed by ROOT conversation id. The
//     task-runner publishes under the root key; the parent's SSE stream
//     subscribes and relays. FIFO per key (single process, synchronous
//     fan-out). No writer sharing — producer and consumer are decoupled,
//     so a closed parent stream never crashes a running task.
//
// Event types: task_started, step, tool_call, tool_result, heartbeat,
// task_done, task_error. Payloads are small JSON objects — the UI routes
// them to the right task card via payload.sub_conversation_id.

import { db } from "../db/index";
import { runEvents } from "../db/schema";

export type RunEvent = {
  conversationId: string; // ROOT conversation (the key the UI listens on)
  type:
    | "task_started"
    | "step"
    | "tool_call"
    | "tool_result"
    | "heartbeat"
    | "task_done"
    | "task_error";
  payload: Record<string, unknown>;
};

type Listener = (ev: RunEvent & { createdAt: string }) => void;

const listeners = new Map<string, Set<Listener>>();

/** Subscribe to the live events of a root conversation. AUTH IS THE
 *  CALLER'S JOB — the SSE route must verify the conversation belongs to
 *  the session user before subscribing (PLAN.md rd4 pt 10). */
export function subscribeRunEvents(
  rootConversationId: string,
  fn: Listener,
): () => void {
  let set = listeners.get(rootConversationId);
  if (!set) {
    set = new Set();
    listeners.set(rootConversationId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(rootConversationId);
  };
}

/** Emit an event: persist (except heartbeats — pure liveness, no replay
 *  value) and fan out to live subscribers. Never throws — a failed
 *  insert must not kill a running task. */
export async function emitRunEvent(ev: RunEvent): Promise<void> {
  const live = { ...ev, createdAt: new Date().toISOString() };
  const set = listeners.get(ev.conversationId);
  if (set) {
    for (const fn of set) {
      try {
        fn(live);
      } catch {
        /* subscriber's problem */
      }
    }
  }
  if (ev.type === "heartbeat") return;
  try {
    await db.insert(runEvents).values({
      conversationId: ev.conversationId,
      type: ev.type,
      payload: ev.payload,
    });
  } catch (err) {
    console.warn("[run-events] insert failed:", (err as Error).message);
  }
}
