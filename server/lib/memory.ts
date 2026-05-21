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
// Hard cap on the wiki dump size we inject into the system prompt. The
// Python service returns the whole Obsidian corpus unbounded; at 35 k+
// tokens (~140 KB) it dominates prefill cost (cf. Hy3 TTFT 280s on
// 38 k-tok prompt). 50 KB ≈ 12 k tokens is a reasonable budget that
// still gives the model meaningful context without nuking latency.
// Set MEMORY_MAX_BYTES=0 to disable the cap.
const MEMORY_MAX_BYTES = Number(process.env.MEMORY_MAX_BYTES ?? 50_000);

/** The memory budget we enforce. Exported so other code paths (e.g.
 *  re-reading a frozen snapshot from the DB) can apply the same cap. */
export const MEMORY_CAP_BYTES = MEMORY_MAX_BYTES;

/** Truncate a markdown block at a byte boundary that doesn't split a
 *  paragraph (we cut at the last `\n\n` before the limit, so the model
 *  never sees a half-sentence). Appends a visible marker so the model
 *  knows context was elided. */
export function capMarkdown(md: string, maxBytes: number = MEMORY_MAX_BYTES): string {
  if (maxBytes <= 0 || md.length <= maxBytes) return md;
  const slice = md.slice(0, maxBytes);
  const lastBreak = slice.lastIndexOf("\n\n");
  const cut = lastBreak > maxBytes * 0.5 ? lastBreak : maxBytes;
  return (
    md.slice(0, cut).trimEnd() +
    `\n\n---\n_[memory truncated: ${md.length - cut} bytes elided of ${md.length} total. ` +
    `Raise MEMORY_MAX_BYTES if you need more context here.]_\n`
  );
}

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
    const stripped = stripWikilinks(data.markdown ?? "");
    return capMarkdown(stripped, MEMORY_MAX_BYTES);
  } catch (err) {
    console.warn("[memory] getMemoryContext failed:", (err as Error).message);
    return "";
  }
}

/**
 * Strip Obsidian-style wikilink syntax from the memory markdown before
 * injecting it into the model's system prompt.
 *
 * Why: the wiki is rendered with `[[tools/litellm]]`, `[[concepts/foo|alias]]`
 * etc. The model picks up the pattern and starts emitting wikilinks in its
 * own answers, polluting the chat output. We replace:
 *   `[[a/b/c|alias]]`  → `alias`
 *   `[[a/b/c]]`        → `c` (the leaf name — most readable, retains semantics)
 *
 * This change is invisible to the wiki itself (Obsidian sync still gets the
 * raw markdown). It only affects what the LLM sees.
 */
function stripWikilinks(md: string): string {
  return md.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => {
    if (alias) return alias.trim();
    const leaf = String(target).split("/").pop() ?? target;
    return leaf;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// RAG retrieval — per-turn semantic search against the Obsidian wiki
// indexed in Qdrant (bge-m3 embeddings). Replaces the legacy "frozen
// snapshot" approach that injected ~12 KB of wiki into every chat body
// regardless of the question.
//
// Architecture:
//   chat.ts asks ragRetrieve(question, k=5) → embedding round-trip to
//   :8082, Qdrant search on :6333, returns top-K chunks. Each chunk is
//   ~150 tokens, so K=5 ≈ 750 tokens — 16× lighter than the snapshot.
//
// Cache placement: the caller must inject these chunks as a system-role
// message IMMEDIATELY BEFORE the latest user message. That keeps the
// system prompt + earlier history byte-stable across turns (prefix-cache
// hit), and only the (RAG block + user msg) tail re-prefills.
// ──────────────────────────────────────────────────────────────────────────

const RAG_QDRANT_URL = process.env.RAG_QDRANT_URL ?? "";
const RAG_EMBED_URL = process.env.RAG_EMBED_URL ?? "";
const RAG_COLLECTION = process.env.RAG_COLLECTION ?? "obsidian-context";

export type RagHit = {
  score: number;
  path: string;
  title: string;
  snippet: string;
};

export function isRagAvailable(): boolean {
  return Boolean(RAG_QDRANT_URL && RAG_EMBED_URL && RAG_COLLECTION);
}

export async function ragRetrieve(
  query: string,
  limit: number = 5,
): Promise<RagHit[]> {
  if (!isRagAvailable() || !query.trim()) return [];
  const k = Math.max(1, Math.min(limit, 10));
  const t0 = Date.now();
  try {
    const embedResp = await fetch(`${RAG_EMBED_URL}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: [query] }),
      // 20s — embed service can be slow on first request after idle
      // (model warm-up). 8s was too tight and aborted real workloads.
      signal: AbortSignal.timeout(20_000),
    });
    if (!embedResp.ok) {
      console.warn(`[memory] embed ${embedResp.status} on /embed`);
      return [];
    }
    const embedJson = (await embedResp.json()) as { embeddings?: number[][] };
    const vector = embedJson.embeddings?.[0];
    if (!vector || vector.length === 0) {
      console.warn("[memory] embed: empty vector");
      return [];
    }
    const tEmbed = Date.now() - t0;

    const searchResp = await fetch(
      `${RAG_QDRANT_URL}/collections/${encodeURIComponent(RAG_COLLECTION)}/points/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vector, limit: k, with_payload: true }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!searchResp.ok) {
      console.warn(`[memory] qdrant ${searchResp.status}`);
      return [];
    }
    const searchJson = (await searchResp.json()) as {
      result?: Array<{ score?: number; payload?: Record<string, unknown> }>;
    };
    const rawHits = (searchJson.result ?? []).map((r) => {
      const payload = r.payload ?? {};
      const text =
        (payload.text as string | undefined) ??
        (payload.content as string | undefined) ??
        "";
      const path =
        (payload.path as string | undefined) ??
        (payload.source as string | undefined) ??
        (payload.filepath as string | undefined) ??
        "(unknown)";
      const title =
        (payload.title as string | undefined) ??
        path.split("/").pop() ??
        "";
      return {
        score: r.score ?? 0,
        path,
        title,
        snippet: text.slice(0, 600),
      };
    });

    // Quality filters — Qdrant always returns top-K even when nothing in
    // the index is actually relevant to the query. Without filtering, the
    // model receives noise (e.g. emoji-only chunks from a feature-matrix
    // file) and concludes "I have no memory" because the chunks make no
    // sense. We apply three guards:
    //
    //  1. SCORE_FLOOR : drop hits below cosine similarity threshold.
    //     0.55 is the empirical bge-m3 sweet spot — above it, hits are
    //     usually genuinely related; below it, they're random.
    //  2. MIN_SNIPPET_CHARS : drop tiny payloads. The "✅"/"❌" cells
    //     that result from over-chunked tables score artificially well
    //     but carry no information.
    //  3. If after filtering we have 0 hits, return [] — no memory
    //     injection at all, which is honest: the wiki has nothing
    //     relevant to this question.
    const SCORE_FLOOR = Number(process.env.RAG_SCORE_FLOOR ?? 0.55);
    const MIN_SNIPPET_CHARS = Number(process.env.RAG_MIN_SNIPPET_CHARS ?? 50);
    const hits = rawHits.filter(
      (h) =>
        h.score >= SCORE_FLOOR &&
        h.snippet.replace(/\s+/g, " ").trim().length >= MIN_SNIPPET_CHARS,
    );

    const tTotal = Date.now() - t0;
    const droppedFor = rawHits.length - hits.length;
    const uniqSources = new Set(hits.map((h) => h.path)).size;
    console.log(
      `[memory] ragRetrieve: query=${JSON.stringify(query).slice(0, 60)} ` +
        `hits=${hits.length}/${rawHits.length}` +
        (droppedFor > 0 ? ` dropped=${droppedFor}(score<${SCORE_FLOOR} or trivial)` : "") +
        ` srcs=${uniqSources} embed=${tEmbed}ms total=${tTotal}ms`,
    );
    if (hits.length > 0 && uniqSources === 1) {
      console.warn(
        `[memory] all ${hits.length} hits come from a single source ` +
          `(${hits[0].path}) — wiki may not contain anything else relevant ` +
          `to this query, or chunking is too narrow`,
      );
    }
    return hits;
  } catch (err) {
    console.warn(
      `[memory] ragRetrieve failed after ${Date.now() - t0}ms:`,
      (err as Error).message,
    );
    return [];
  }
}

/** Format RAG hits into a Markdown block ready to drop into a system
 *  message. Stable formatting (sorted by score descending, path-first
 *  headers) so the byte layout is predictable for any cache hit on
 *  identical queries. */
export function formatRagBlock(hits: RagHit[]): string {
  if (hits.length === 0) return "";
  const sections = hits.map((h, i) => {
    const head = h.title || h.path;
    return `### [${i + 1}] ${head}\n_(source: ${h.path}, score ${h.score.toFixed(3)})_\n\n${h.snippet}`;
  });
  return [
    "# Relevant context (top-K retrieval from your wiki for the latest question)",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
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
