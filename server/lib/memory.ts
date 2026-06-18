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

import { and, eq, like } from "drizzle-orm";
import { db } from "../db/index";
import { memoryArticles, users } from "../db/schema";
import { getCompanyRagUrl } from "./global-settings";
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

/** User identity for the system prompt, injected independently of the
 *  persona/talk bypass (so a persona never says "I can't identify you").
 *
 *  TWO tiers, gated by the conversation memory toggle:
 *   - ALWAYS (even memory OFF): a minimal one-liner — just WHO the assistant is
 *     talking to (the user's name). Identity ≠ memory.
 *   - ONLY when memory ON: the rich curated `profile/*` articles (preferences,
 *     infrastructure, expertise…). With memory OFF the assistant must NOT recite
 *     the profile — that is memory, and the toggle controls it
 *     (#fix 2026-06-18: memory-off was still reciting the infra/profile). */
export async function getUserIdentityBlock(
  userId: string,
  memoryEnabled: boolean,
): Promise<string> {
  let name = "";
  try {
    const [u] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    name = (u?.name || "").trim();
  } catch {
    /* ignore */
  }
  const head = name ? `You are talking with ${name}.` : "";

  // Memory OFF → identity is JUST the name (or nothing). No profile recitation.
  if (!memoryEnabled) {
    return head ? `## About the user\n\n${head}` : "";
  }

  // Memory ON → append the curated profile/* articles. Injected here (not via
  // the RAG/wiki path) so it survives the persona/talk bypass.
  try {
    const rows = await db
      .select({ body: memoryArticles.body })
      .from(memoryArticles)
      .where(
        and(
          eq(memoryArticles.userId, userId),
          like(memoryArticles.path, "profile/%"),
        ),
      )
      .orderBy(memoryArticles.path);
    const profile = rows
      .map((r) => (r.body || "").trim())
      .filter((s) => s.length > 0)
      .join("\n\n");
    if (profile) {
      const body = [head, profile].filter(Boolean).join("\n\n");
      return capMarkdown(`## About the user\n\n${body}`, 6144);
    }
  } catch (err) {
    console.warn("[memory] getUserIdentityBlock profile failed:", (err as Error).message);
  }
  return head ? `## About the user\n\n${head}` : "";
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
// User/team memory is the bundled custom nemo service (MLX embeddings, per-user
// graphs) — a single internal endpoint for the whole instance, NOT a per-user
// editable link. Its URL/top_k/timeout come from env. (Company memory is the
// separate, editable HKUDS LightRAG — see getCompanyRagUrl.)
const NEMO_MEMORY_URL = (process.env.NEMO_MEMORY_URL || "").replace(/\/$/, "");
const NEMO_TOP_K = Number(process.env.NEMO_TOP_K ?? "5");
const NEMO_TIMEOUT_MS = Number(process.env.NEMO_TIMEOUT_MS ?? "3000");
const NEMO_RAG: { url: string; topK: number; timeoutMs: number } | null =
  NEMO_MEMORY_URL
    ? { url: NEMO_MEMORY_URL, topK: NEMO_TOP_K, timeoutMs: NEMO_TIMEOUT_MS }
    : null;

export function isNemoAvailable(): boolean {
  return Boolean(NEMO_MEMORY_URL);
}

// Company tier: a dedicated standard-API LightRAG (:8766) serving ONE shared
// "company" graph. Different wire protocol from nemo (:8765) — POST /query
// with only_need_context returns the retrieved context in `.response`.
const COMPANY_TIMEOUT_MS = Number(process.env.COMPANY_RAG_TIMEOUT_MS ?? "4000");

async function _companyQueryOne(
  companyUrl: string,
  question: string,
): Promise<string> {
  try {
    const res = await fetch(`${companyUrl}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: question,
        mode: "hybrid",
        only_need_context: true,
      }),
      signal: AbortSignal.timeout(COMPANY_TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as { response?: string };
    const text = (data.response ?? "").trim();
    // An EMPTY tier answers with an apology string tagged [no-context]
    // (even with only_need_context) — that's "nothing", not context.
    // Without this, every prompt would carry a "## Company memory" block
    // containing "Sorry, I'm not able to…" (seen 2026-06-12 when the
    // company tier was drained of its misplaced corpus).
    if (!text || text.includes("[no-context]")) return "";
    return text;
  } catch {
    return "";
  }
}

/** Single-collection nemo query (internal helper). */
async function _nemoQueryOne(
  rag: { url: string; topK: number; timeoutMs: number },
  collectionId: string,
  question: string,
  projectId?: string | null,
): Promise<string> {
  try {
    const res = await fetch(`${rag.url}/query/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: collectionId,
        text: question,
        top_k: rag.topK,
        project_id: projectId ?? null,
      }),
      signal: AbortSignal.timeout(rag.timeoutMs),
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
  // When the project has dedicated memory, its compiled notes live in a nemo
  // collection keyed by projectId (same pattern as team) — pass it here to
  // add the "## Project memory" tier.
  dedicatedProjectId?: string | null,
): Promise<string> {
  if (!question.trim()) return "";

  const companyUrl = await getCompanyRagUrl();
  const rag = NEMO_RAG;

  // All tiers in parallel, each labelled. Personal/team/project hit the
  // bundled nemo (:8765, collection = userId/teamId/projectId); company hits
  // the dedicated shared-graph LightRAG (:8766) that everyone reads.
  const tasks: Promise<{ label: string; text: string }>[] = [];
  if (rag) {
    tasks.push(
      _nemoQueryOne(rag, userId, question, projectId).then((text) => ({
        label: "## Personal memory",
        text,
      })),
    );
    if (teamId) {
      tasks.push(
        _nemoQueryOne(rag, teamId, question, projectId).then((text) => ({
          label: "## Team memory",
          text,
        })),
      );
    }
    if (dedicatedProjectId) {
      tasks.push(
        _nemoQueryOne(rag, dedicatedProjectId, question, null).then((text) => ({
          label: "## Project memory",
          text,
        })),
      );
    }
  }
  if (companyUrl) {
    tasks.push(
      _companyQueryOne(companyUrl, question).then((text) => ({
        label: "## Company memory",
        text,
      })),
    );
  }

  const blocks = (await Promise.all(tasks)).filter((b) => b.text.trim());
  if (blocks.length === 0) return "";
  const merged = blocks
    .map((b) => `${b.label}\n\n${b.text.replace(/^# Relevant memory\n\n/, "")}`)
    .join("\n\n---\n\n");
  return `# Relevant memory\n\n${merged}`;
}

/** Ingest a memory article into nemo-memory (fire-and-forget).
 *  Called after Karpathy compiles a new wiki snapshot. */
export function nemoIngest(
  collectionId: string,
  articleId: string,
  text: string,
  source: string = "wiki",
  projectId?: string | null,
): void {
  if (!text.trim() || !NEMO_RAG) return;
  void (async () => {
    try {
      await fetch(`${NEMO_RAG.url}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: collectionId,
          article_id: articleId,
          text,
          source,
          project_id: projectId ?? null,
        }),
      });
    } catch (err) {
      console.warn("[memory] nemoIngest failed:", (err as Error).message);
    }
  })();
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

// triggerCompile (async fire-and-forget) was retired with the wiki backend.
// The scheduler now calls compileNow, which compiles AND ingests into the RAG
// (see memory-scheduler.ts). Karpathy is purely the RAG ingestion pipeline.

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
