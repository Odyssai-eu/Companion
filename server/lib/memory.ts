/**
 * Memory context client. Two operations matter to the chat path:
 *
 *   - getMemoryContext(userId, projectId?)  → call before each chat to
 *     inject "what I remember about you" into the system prompt. Composes
 *     two sources: the user-curated vault (DB import + linked external
 *     path, see server/lib/user-memory.ts) and the Karpathy auto-compiled
 *     wiki (FastAPI sidecar at MEMORY_SERVICE_URL).
 *   - triggerCompile(userId, conversationId) → fire-and-forget after each
 *     assistant message completes, so the auto-wiki stays fresh.
 *
 * Both are best-effort. If either source is down/empty, chat still works —
 * we log and continue. When the user has flipped `auto_memory_enabled`
 * off, the Karpathy half is skipped entirely (vault becomes single source
 * of truth).
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema";
import { getMemoryBackend } from "./global-settings";
import { getUserMemoryContext } from "./user-memory";

// `??` only catches null/undefined — `MEMORY_SERVICE_URL=""` (the compose
// default for fresh installs without the memory service) would fall through
// as an empty string and crash `new URL("/context/...", "")` on every chat
// creation. Treat any falsy value as unset and short-circuit the calls
// instead. The compose comment already promises "Companion runs fine"
// without this service; honor that.
const MEMORY_BASE_URL = process.env.MEMORY_SERVICE_URL || "";
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

/** Returns the Markdown block to prepend to the system prompt, or "" on failure.
 *
 *  Composition (when both sources are populated) :
 *    1. User vault (DB-imported + external_vault_path live read)
 *    2. Karpathy auto-wiki (the FastAPI memory service)
 *
 *  Both blocks are independently capped at MEMORY_MAX_BYTES so a huge vault
 *  can't blow up the prompt. The user can disable the Karpathy half via
 *  `users.auto_memory_enabled = false` — useful when they want to pilot the
 *  memory manually (vault only, no auto-compile drift).
 */
export async function getMemoryContext(
  userId: string,
  projectId: string | null,
): Promise<string> {
  // Load both sources in parallel — vault is local DB + disk, Karpathy is
  // an HTTP round-trip to the FastAPI sidecar. Slowest wins, but we don't
  // sequentialise them.
  const [vault, autoEnabled, karpathyRaw] = await Promise.all([
    getUserVaultBlock(userId),
    isAutoMemoryEnabled(userId),
    fetchKarpathyMemory(userId, projectId),
  ]);
  // fetchKarpathyMemory returns "" immediately when MEMORY_BASE_URL is unset
  // (the common case), so fetching it inside the Promise.all adds no cost there
  // and removes a serial round-trip when the memory service IS configured (#7).
  const karpathy = autoEnabled ? karpathyRaw : "";

  if (!vault && !karpathy) return "";
  if (!vault) return karpathy;
  if (!karpathy) return vault;
  return `${vault}\n\n---\n\n${karpathy}`;
}

/** Fetch the Karpathy auto-compiled wiki block. Returns "" on failure or
 *  when the memory service URL isn't configured. */
async function fetchKarpathyMemory(
  userId: string,
  projectId: string | null,
): Promise<string> {
  if (!MEMORY_BASE_URL) return "";
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
    console.warn("[memory] fetchKarpathyMemory failed:", (err as Error).message);
    return "";
  }
}

/** Read user-curated vault content (DB import + linked external path),
 *  cap to MEMORY_MAX_BYTES to match the Karpathy treatment. */
async function getUserVaultBlock(userId: string): Promise<string> {
  try {
    const raw = await getUserMemoryContext(userId);
    if (!raw) return "";
    return capMarkdown(raw, MEMORY_MAX_BYTES);
  } catch (err) {
    console.warn("[memory] getUserVaultBlock failed:", (err as Error).message);
    return "";
  }
}

async function isAutoMemoryEnabled(userId: string): Promise<boolean> {
  try {
    const [u] = await db
      .select({ autoMemoryEnabled: users.autoMemoryEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    // Default to true if the row doesn't surface a value (legacy users
    // who pre-date the column see the prior behaviour).
    return u?.autoMemoryEnabled ?? true;
  } catch {
    return true;
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

// ── nemo-memory service (Phase 2 — smart RAG injection) ──────────────────
// When NEMO_MEMORY_URL is set, we replace the full-wiki injection with a
// per-turn semantic query: embed the user's message, retrieve top-K relevant
// chunks (~2-4k tokens) instead of the raw wiki (~12k tokens).
// Falls back to the legacy full-wiki path when the service is unavailable.
const NEMO_MEMORY_URL = (process.env.NEMO_MEMORY_URL || "").replace(/\/$/, "");
const NEMO_TOP_K = Number(process.env.NEMO_TOP_K ?? "5");
const NEMO_TIMEOUT_MS = Number(process.env.NEMO_TIMEOUT_MS ?? "3000");

export function isNemoAvailable(): boolean {
  return Boolean(NEMO_MEMORY_URL);
}

/** Whether LightRAG should actually serve this turn: it must be both
 *  deployed (NEMO_MEMORY_URL set) AND selected as the active backend in
 *  the global settings. When the admin flips the backend to 'wiki', this
 *  returns false even though the service is up, so chat reads the wiki. */
export async function nemoActive(): Promise<boolean> {
  if (!isNemoAvailable()) return false;
  return (await getMemoryBackend()) === "lightrag";
}

/** Single-collection nemo query (internal helper). */
async function _nemoQueryOne(
  collectionId: string,
  question: string,
  projectId?: string | null,
): Promise<string> {
  try {
    const res = await fetch(`${NEMO_MEMORY_URL}/query/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: collectionId,
        text: question,
        top_k: NEMO_TOP_K,
        project_id: projectId ?? null,
      }),
      signal: AbortSignal.timeout(NEMO_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { context?: string };
    return data.context ?? "";
  } catch {
    return "";
  }
}

/**
 * Query nemo-memory across up to 3 collections in parallel:
 *   1. user   — personal knowledge graph
 *   2. team   — shared team knowledge (optional)
 *   3. company — org-wide knowledge (optional, future)
 *
 * Results are merged into a single markdown block. Empty collections are
 * silently skipped. Falls back to "" if all fail.
 */
export async function nemoQuery(
  userId: string,
  question: string,
  projectId?: string | null,
  teamId?: string | null,
  companyId?: string | null,
): Promise<string> {
  if (!NEMO_MEMORY_URL || !question.trim()) return "";

  const queries: Promise<string>[] = [_nemoQueryOne(userId, question, projectId)];
  if (teamId) queries.push(_nemoQueryOne(teamId, question, projectId));
  if (companyId) queries.push(_nemoQueryOne(companyId, question, projectId));

  const results = await Promise.all(queries);
  const blocks = results.filter((r) => r.trim());

  if (blocks.length === 0) return "";
  if (blocks.length === 1) return blocks[0];

  // Merge with section labels when multiple collections respond
  const labels = ["## Personal memory", "## Team memory", "## Company memory"];
  const merged = blocks
    .map((b, i) => `${labels[i] ?? "## Context"}\n\n${b.replace(/^# Relevant memory\n\n/, "")}`)
    .join("\n\n---\n\n");
  return `# Relevant memory\n\n${merged}`;
}

/** Ingest a memory article into nemo-memory (fire-and-forget).
 *  Called after Karpathy compiles a new wiki snapshot. */
export function nemoIngest(
  userId: string,
  articleId: string,
  text: string,
  source: string = "wiki",
  projectId?: string | null,
): void {
  if (!NEMO_MEMORY_URL || !text.trim()) return;
  fetch(`${NEMO_MEMORY_URL}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: userId,
      article_id: articleId,
      text,
      source,
      project_id: projectId ?? null,
    }),
  }).catch((err: Error) => {
    console.warn("[memory] nemoIngest failed:", err.message);
  });
}

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
  if (!MEMORY_BASE_URL) return;
  // Fire-and-forget off the hot path. Skip entirely when LightRAG is the
  // active backend — there is no wiki to keep fresh, so a compile would be
  // wasted work (the "fire into the void" the scheduler used to log).
  void (async () => {
    if ((await getMemoryBackend()) !== "wiki") return;
    const url = new URL(`/compile/async`, MEMORY_BASE_URL);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          conversation_id: conversationId,
        }),
      });
    } catch (err) {
      console.warn("[memory] triggerCompile failed:", (err as Error).message);
    }
  })();
}

/** Synchronous compile — waits for the LLM pass to finish. Used by
 *  "Remember now" so the UI can immediately show the refreshed snapshot. */
export async function compileNow(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  if (!MEMORY_BASE_URL) return false;
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
    if (res.ok) {
      // After a successful compile, sync the fresh wiki into nemo-memory
      // so the next turn benefits from semantic retrieval on the new content.
      void nemoSyncWiki(userId);
    }
    return res.ok;
  } catch (err) {
    console.warn("[memory] compileNow failed:", (err as Error).message);
    return false;
  }
}

/** After a Karpathy compile, refetch the user's wiki and ingest it into
 *  nemo-memory so semantic retrieval picks up the fresh content. Fire-and-forget. */
async function nemoSyncWiki(userId: string): Promise<void> {
  if (!NEMO_MEMORY_URL || !MEMORY_BASE_URL) return;
  try {
    const url = new URL(`/context/${userId}`, MEMORY_BASE_URL);
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return;
    const data = (await res.json()) as { markdown?: string };
    const text = stripWikilinks(data.markdown ?? "");
    if (!text.trim()) return;
    nemoIngest(userId, `wiki:${userId}`, text, "wiki");
  } catch (err) {
    console.warn("[memory] nemoSyncWiki failed:", (err as Error).message);
  }
}
