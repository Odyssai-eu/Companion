/**
 * Client for the thecompai-memory Python service (FastAPI).
 *
 * Two operations matter to the backend:
 *   - getMemoryContext(userId, projectId?)  → call before each chat to inject
 *     "what I remember about you" into the system prompt.
 *   - triggerCompile(userId, conversationId) → fire-and-forget after each
 *     assistant message completes, so the wiki stays fresh.
 *
 * Both are best-effort. If the memory service is down, chat still works —
 * we log and continue.
 */

const MEMORY_BASE_URL =
  process.env.MEMORY_SERVICE_URL ?? "http://127.0.0.1:8001";
const MEMORY_TIMEOUT_MS = Number(process.env.MEMORY_TIMEOUT_MS ?? 1500);

/** Returns the Markdown block to prepend to the system prompt, or "" on failure. */
export async function getMemoryContext(
  userId: string,
  projectId: string | null,
): Promise<string> {
  const url = new URL(`/context/${userId}`, MEMORY_BASE_URL);
  if (projectId) url.searchParams.set("project_id", projectId);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MEMORY_TIMEOUT_MS);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return "";
    const data = (await res.json()) as { markdown?: string };
    return data.markdown ?? "";
  } catch (err) {
    console.warn("[memory] getMemoryContext failed:", (err as Error).message);
    return "";
  }
}

/** Fire-and-forget compile trigger. Resolves immediately; the LLM call
 *  happens in the Python service. */
export function triggerCompile(
  userId: string,
  conversationId: string,
): void {
  const url = new URL(`/compile/async`, MEMORY_BASE_URL);
  // No await — we want this off the hot path.
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      conversation_id: conversationId,
    }),
  }).catch((err: Error) => {
    console.warn("[memory] triggerCompile failed:", err.message);
  });
}

/** Synchronous compile — waits for the LLM pass to finish. Used by
 *  "Remember now" so the UI can immediately show the refreshed snapshot. */
export async function compileNow(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const url = new URL(`/compile`, MEMORY_BASE_URL);
  try {
    const ctrl = new AbortController();
    // Compile can take 30-90s on a long conversation; give it generous time.
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        conversation_id: conversationId,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch (err) {
    console.warn("[memory] compileNow failed:", (err as Error).message);
    return false;
  }
}
