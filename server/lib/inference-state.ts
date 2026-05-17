/**
 * In-memory buffer of in-flight inferences. Survives client disconnection
 * — the chat pump writes both to the SSE writer (consumed by the active
 * browser tab) AND to this Map. If the user navigates away, refreshes,
 * or opens the same conv from another tab/device, the Map keeps the
 * generation buffered server-side until the upstream finishes.
 *
 * Lost on server restart. Acceptable trade-off: restarts are rare and
 * the client gracefully falls back to DB which has the last persisted
 * state from a prior turn. Avoid persisting this to Postgres — the row
 * would be hot-write per token and the volume of dead state would dwarf
 * the messages table.
 *
 * Keyed by conversationId (UUID — globally unique across users). userId
 * is stored INSIDE the entry so the polling endpoint can refuse foreign
 * lookups by UUID-obscurity alone (per D-defence-in-depth).
 *
 * Pattern lifted from ExoScopy / Starbase — see
 * exoscopy-starbase/docs/background-inference-comparison.md for the
 * comparative analysis. Distinct from `server/routes/inference.ts`
 * (which serves persisted user settings, not volatile stream state).
 */

export type InferenceEntry = {
  userId: string;
  /** Assistant text content as it streams. */
  content: string;
  /** Separate reasoning channel (Anthropic / Gemini thinking tokens, etc.). */
  reasoning: string;
  /** True once the pump finished (success OR error). */
  done: boolean;
  /** Non-null when the pump failed mid-stream — surfaced to the client. */
  error: string | null;
  startedAt: number;
  firstTokenAt: number | null;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
};

export type InferenceStatus =
  | { active: false; done?: undefined }
  | {
      active: boolean;
      done: boolean;
      content: string;
      reasoning: string;
      error: string | null;
    };

const _active = new Map<string, InferenceEntry>();

export function startInference(convId: string, userId: string): void {
  _active.set(convId, {
    userId,
    content: "",
    reasoning: "",
    done: false,
    error: null,
    startedAt: Date.now(),
    firstTokenAt: null,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
  });
}

export function appendInferenceContent(convId: string, chunk: string): void {
  const inf = _active.get(convId);
  if (!inf) return;
  if (!inf.firstTokenAt) inf.firstTokenAt = Date.now();
  inf.content += chunk;
}

export function appendInferenceReasoning(convId: string, chunk: string): void {
  const inf = _active.get(convId);
  if (!inf) return;
  if (!inf.firstTokenAt) inf.firstTokenAt = Date.now();
  inf.reasoning += chunk;
}

export function recordInferenceUsage(
  convId: string,
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null | undefined,
): void {
  const inf = _active.get(convId);
  if (!inf || !usage) return;
  // mlx-vlm uses input_tokens/output_tokens; LiteLLM forwards both shapes.
  if (usage.prompt_tokens) inf.promptTokens = usage.prompt_tokens;
  else if (usage.input_tokens) inf.promptTokens = usage.input_tokens;
  if (usage.completion_tokens) inf.completionTokens = usage.completion_tokens;
  else if (usage.output_tokens) inf.completionTokens = usage.output_tokens;
  if (usage.completion_tokens_details?.reasoning_tokens) {
    inf.reasoningTokens = usage.completion_tokens_details.reasoning_tokens;
  }
}

export function markInferenceError(convId: string, error: string): void {
  const inf = _active.get(convId);
  if (!inf) return;
  inf.error = error;
}

/**
 * Mark the inference done and run a persistence callback with the final
 * buffer. The caller controls WHERE the message lands (DB row, message
 * table, etc.) — this module never imports the DB layer.
 *
 * If `error` is set or `content` is empty, the persistence callback is
 * NOT called. The entry stays in the Map (done=true, error set) so a
 * late-arriving client can still read the failure status.
 */
export async function finishInference(
  convId: string,
  persist: (
    content: string,
    reasoning: string,
    stats: {
      ttftMs: number | null;
      totalMs: number;
      promptTokens: number;
      completionTokens: number;
      reasoningTokens: number;
    },
  ) => Promise<void>,
  error?: string | null,
): Promise<void> {
  const inf = _active.get(convId);
  if (!inf) return;
  inf.done = true;
  if (error) inf.error = error;
  if (inf.content && !inf.error) {
    const ttftMs = inf.firstTokenAt ? inf.firstTokenAt - inf.startedAt : null;
    const totalMs = Date.now() - inf.startedAt;
    try {
      await persist(inf.content, inf.reasoning, {
        ttftMs,
        totalMs,
        promptTokens: inf.promptTokens,
        completionTokens: inf.completionTokens,
        reasoningTokens: inf.reasoningTokens,
      });
    } catch (e) {
      console.error("[inference-state] persist failed:", (e as Error).message);
    }
  }
}

/**
 * Read the current state of an inference. Returns `{active:false}` when
 * either there's no entry OR the entry belongs to another user. Use this
 * as the only read path — never expose the raw Map.
 */
export function getInferenceStatus(
  convId: string,
  userId: string,
): InferenceStatus {
  const inf = _active.get(convId);
  if (!inf) return { active: false };
  if (inf.userId !== userId) return { active: false };
  return {
    active: !inf.done,
    done: inf.done,
    content: inf.content,
    reasoning: inf.reasoning,
    error: inf.error,
  };
}

/**
 * Drop the entry. Called by the client after consuming a finished stream.
 *
 * Race-safety: we ONLY delete when `done=true`. The browser fires this
 * route as soon as it sees `data: [DONE]` on the SSE wire, but the
 * server-side `finishInference()` (which persists the assistant message)
 * runs slightly later (after writer.close()). If we deleted the entry
 * unconditionally, finishInference would find `inf=null` and skip persist
 * entirely — observed as "ghost answer" : the stream visibly arrived in
 * the UI, then the message vanished on reload because it was never
 * inserted in the DB. Guarding on `done=true` keeps the entry alive
 * during the persist window; a follow-up clear (or the 60s deferred
 * delete inside chat.ts) removes it later.
 */
export function clearInference(convId: string, userId: string): boolean {
  const inf = _active.get(convId);
  if (!inf || inf.userId !== userId) return false;
  if (!inf.done) return false;
  _active.delete(convId);
  return true;
}

/**
 * Drop without auth check — used by the chat route's own cleanup paths.
 *
 * Race-safety: same constraint as clearInference. The 60s deferred GC
 * inside chat.ts is scheduled by the persist callback of TURN N. If
 * the user starts TURN N+1 before the timer fires, `startInference()`
 * replaces the map entry with a fresh (done=false) one. When the
 * stale timer eventually fires, it would otherwise delete N+1's
 * still-streaming buffer → ghost answer #3. Gate on `done=true` so
 * the timer is a no-op when a new inference is in flight.
 */
export function deleteInference(convId: string): void {
  const inf = _active.get(convId);
  if (!inf || !inf.done) return;
  _active.delete(convId);
}

/** List conversationIds with active streams for a user. Drives the
 *  sidebar / NavBar parallel-stream badge. */
export function listActiveForUser(userId: string): string[] {
  const out: string[] = [];
  for (const [id, inf] of _active) {
    if (inf.userId === userId && !inf.done) out.push(id);
  }
  return out;
}

/**
 * Background sweep: drop entries older than `maxAgeMs` regardless of
 * status. Guards against unbounded growth when streams die without a
 * proper `finishInference` (e.g. uncaught throw in pump). Called from a
 * setInterval in the server boot path.
 */
export function sweepStaleInferences(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  let dropped = 0;
  for (const [id, inf] of _active) {
    if (inf.startedAt < cutoff) {
      _active.delete(id);
      dropped++;
    }
  }
  return dropped;
}
