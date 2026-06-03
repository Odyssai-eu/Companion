/**
 * Semantic router — picks the right model for a user message based on
 * embedding similarity to per-bucket anchors.
 *
 * Why: not all models are good at everything. Code-tuned models
 * sometimes loop on conversational prompts — emitting confident
 * multi-paragraph rambles instead of a short reply. Mid-size
 * conversational models are perfect for chat but lighter on deep
 * analysis. The biggest reasoner has the quality but is slow. We
 * pick per-message instead of forcing one global choice.
 *
 * How: a small embedding model (Qwen3-Embedding-0.6B-mxfp8 by default)
 * runs on the cluster. At config time we embed a dozen anchor
 * sentences per bucket (chat/deep/code) and average them into
 * centroids. At route time we embed the latest user message, cosine
 * vs the three centroids, pick the closest. ~6ms per message.
 *
 * The embedding service is an add-on. If it's not configured, "Auto"
 * just falls back to the user's last manual choice or 400s — never
 * implicit, never silent.
 */

export type RouterLabel = "chat" | "deep" | "code";

export interface RouterPolicy {
  chat: string;
  deep: string;
  code: string;
}

export interface RouterConfig {
  /** OpenAI-compat embedding endpoint, e.g.
   * `http://<embedding-host>:<port>/v1/embeddings`. */
  embeddingsUrl?: string;
  /** Optional override; the service serves one model so this is mostly cosmetic. */
  embeddingsModel?: string;
  policy: RouterPolicy;
  /** Cached anchor centroids — populated on first use or via /rebuild. */
  anchorCentroids?: Record<RouterLabel, number[]>;
  /** ISO timestamp of last centroid build (for cache invalidation in UI). */
  anchorsBuiltAt?: string;
}

export interface RouteResult {
  label: RouterLabel;
  model: string;
  score: number;
  scores: Record<RouterLabel, number>;
  ms: number;
}

/**
 * Anchor sentences. A dozen-ish per bucket, mixing FR/EN and
 * covering the three dominant intent shapes:
 *  - chat: small talk, identity questions, light creative prompts,
 *    conversational openings
 *  - deep: long-form analysis, comparison, essays, "explain in depth"
 *  - code: write/refactor/debug/test/implement
 *
 * Care taken: keep "écris-moi un poème" out of code (creative !=
 * code). Keep "explique X" in deep, not chat (analysis intent).
 */
const ANCHORS: Record<RouterLabel, string[]> = {
  chat: [
    "discutons un peu, comment vas-tu",
    "raconte-moi une histoire amusante",
    "quel personnage de série te ressemble",
    "parlons de la pluie et du beau temps",
    "have a casual conversation with me",
    "tu te sens comment aujourd'hui",
    "comment était ta journée",
    "écris-moi un petit poème",
    "bonjour, comment vas-tu",
    "raconte-moi une blague",
  ],
  deep: [
    "explique en détail les implications du capitalisme tardif",
    "fais une analyse approfondie de cette situation",
    "compare et contraste ces deux philosophies",
    "explore les nuances de ce concept complexe",
    "write a thoughtful essay analyzing the trade-offs",
    "analyse les causes de la révolution française",
    "what are the philosophical implications of consciousness",
    "détaille les arguments pour et contre",
    "explore les conséquences à long terme",
    "explique-moi en profondeur la théorie",
  ],
  code: [
    "écris une fonction Python pour trier une liste",
    "debug ce code qui ne compile pas",
    "refactor this function to be more efficient",
    "implement a binary search tree in TypeScript",
    "corrige le bug dans cette fonction async",
    "ajoute des tests unitaires pour cette fonction",
    "fix this bug: undefined is not a function",
    "écris un endpoint REST en Hono",
    "optimize this SQL query",
    "implement a React hook for data fetching",
  ],
};

const LABELS: RouterLabel[] = ["chat", "deep", "code"];

// ── Tool intent anchors ─────────────────────────────────────────────────────
//
// Orthogonal to the chat/deep/code model routing: a message can be "code"
// AND need a tool (fix the bug in app.py → fs_read+fs_edit), or "chat" with
// no tool at all. We reuse the SAME message embedding (computed once for
// model routing) and compare it against per-tool centroids.
//
// The "none" bucket is the guard against false positives: a pure
// conversational message scores highest on "none", so we only inject a tool
// when its score beats "none". Relative comparison > brittle absolute
// threshold. FR + EN anchors because Nemo is talked to in both.
const TOOL_ANCHORS: Record<string, string[]> = {
  none: [
    "bonjour comment vas-tu",
    "raconte-moi une histoire",
    "explique-moi ce concept en détail",
    "qu'en penses-tu",
    "merci c'est parfait",
    "écris un poème sur la mer",
    "what do you think about this",
    "summarize our conversation",
    "donne-moi ton avis",
    "continue",
  ],
  fs_read: [
    "lis le fichier config.json",
    "montre-moi le contenu de ce fichier",
    "ouvre le fichier app.py et affiche-le",
    "read the file server.ts",
    "cat the contents of package.json",
    "affiche ce que contient ce fichier",
  ],
  fs_write: [
    "écris ce texte dans un fichier",
    "crée un nouveau fichier notes.md",
    "sauvegarde ça dans un fichier",
    "write this to a file",
    "create a file called readme",
    "enregistre le résultat dans output.txt",
  ],
  fs_list: [
    "liste les fichiers du dossier",
    "qu'est-ce qu'il y a dans ce répertoire",
    "montre-moi les fichiers disponibles",
    "list the files in this directory",
    "what files are in the project",
    "ls le dossier src",
  ],
  fs_edit: [
    "modifie le fichier et corrige le bug",
    "remplace cette ligne dans le fichier",
    "édite la fonction dans app.py",
    "edit the file to change this",
    "replace this string in the config",
    "change cette valeur dans le fichier",
  ],
  bash: [
    "exécute git log",
    "lance la commande npm install",
    "fais un git status",
    "run this shell command",
    "execute grep to find the pattern",
    "build le projet avec make",
    "vérifie l'état du dépôt git",
  ],
  web_search: [
    "cherche sur le web les dernières nouvelles",
    "recherche en ligne des informations sur",
    "trouve-moi des infos récentes à propos de",
    "search the web for this topic",
    "look up the latest version online",
    "google ce sujet pour moi",
  ],
  web_read: [
    "lis cette page web et résume-la",
    "récupère le contenu de cette url",
    "ouvre ce lien et dis-moi ce qu'il contient",
    "read this webpage for me",
    "fetch the content of this url",
    "scrape les infos de cette page",
  ],
};

const TOOL_NAMES = Object.keys(TOOL_ANCHORS).filter((t) => t !== "none");

// ── Math helpers ──────────────────────────────────────────────────────────

function l2norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function normalize(v: number[]): number[] {
  const n = l2norm(v);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function mean(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vectors.length;
  return out;
}

// ── Embedding service client ──────────────────────────────────────────────

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
}

export class EmbeddingServiceError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingServiceError";
  }
}

async function embed(
  url: string,
  texts: string[],
  model?: string,
): Promise<number[][]> {
  if (!url) {
    throw new EmbeddingServiceError("embeddings URL not configured");
  }
  const body: Record<string, unknown> = { input: texts };
  if (model) body.model = model;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Short-ish timeout — embeddings should be <100ms even for batches.
      // We give 5s to absorb cold start when the service was idle.
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) {
    throw new EmbeddingServiceError(
      `embeddings fetch failed: ${(e as Error).message}`,
      e,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EmbeddingServiceError(
      `embeddings HTTP ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as EmbeddingsResponse;
  if (!data?.data || !Array.isArray(data.data)) {
    throw new EmbeddingServiceError("malformed embeddings response");
  }
  // Sort by index to be safe — most servers preserve order but we don't trust.
  data.data.sort((a, b) => a.index - b.index);
  return data.data.map((d) => d.embedding);
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Embed all anchors and build per-bucket centroids (mean, normalized).
 * Call once when the add-on is configured, or when the user clicks
 * "Rebuild" in Settings. The result is stored in config.anchorCentroids.
 */
export async function buildAnchorCentroids(
  embeddingsUrl: string,
  embeddingsModel?: string,
): Promise<Record<RouterLabel, number[]>> {
  // Flatten in stable order
  const flat: string[] = [];
  const ranges: Record<RouterLabel, [number, number]> = {} as never;
  let cursor = 0;
  for (const label of LABELS) {
    const arr = ANCHORS[label];
    ranges[label] = [cursor, cursor + arr.length];
    flat.push(...arr);
    cursor += arr.length;
  }

  const all = await embed(embeddingsUrl, flat, embeddingsModel);
  if (all.length !== flat.length) {
    throw new EmbeddingServiceError(
      `expected ${flat.length} embeddings, got ${all.length}`,
    );
  }

  const centroids: Record<RouterLabel, number[]> = {} as never;
  for (const label of LABELS) {
    const [start, end] = ranges[label];
    const slice = all.slice(start, end).map(normalize);
    centroids[label] = normalize(mean(slice));
  }
  return centroids;
}

/**
 * Route a user message: embed it, cosine-sim against each centroid,
 * return the winning label + the mapped model from the policy table.
 *
 * Throws EmbeddingServiceError if the embedding service is unreachable
 * or returns malformed data — caller decides how to fallback.
 */
export async function routeMessage(
  text: string,
  config: RouterConfig,
): Promise<RouteResult> {
  if (!config.embeddingsUrl) {
    throw new EmbeddingServiceError("router not configured (no embeddings URL)");
  }
  if (!config.anchorCentroids) {
    throw new EmbeddingServiceError("router not configured (no anchor centroids)");
  }

  const t0 = Date.now();
  const [vec] = await embed(
    config.embeddingsUrl,
    [text],
    config.embeddingsModel,
  );
  const q = normalize(vec);

  const scores: Record<RouterLabel, number> = {} as never;
  let best: RouterLabel = "chat";
  let bestScore = -Infinity;
  for (const label of LABELS) {
    const s = dot(q, config.anchorCentroids[label]);
    scores[label] = s;
    if (s > bestScore) {
      bestScore = s;
      best = label;
    }
  }
  return {
    label: best,
    model: config.policy[best],
    score: bestScore,
    scores,
    ms: Date.now() - t0,
  };
}

/**
 * Default policy — empty by design so the user makes the call. The
 * Settings UI shows the user's available model ids as helpers; we don't
 * pre-pick to avoid silently routing to something they don't want.
 */
export const DEFAULT_POLICY: RouterPolicy = {
  chat: "",
  deep: "",
  code: "",
};

/**
 * Default embeddings URL. Read from `ROUTER_EMBEDDINGS_URL_DEFAULT` env
 * var at server-start so a deployment can pre-fill the field for its
 * users without baking a URL into the source. Empty otherwise — the
 * Settings UI shows the field empty with a hint.
 */
export const DEFAULT_EMBEDDINGS_URL =
  process.env.ROUTER_EMBEDDINGS_URL_DEFAULT ?? "";

/** Exposed for the test endpoint — read-only snapshot of the anchors. */
export function getAnchors(): Record<RouterLabel, string[]> {
  return ANCHORS;
}

// ── Tool intent detection ───────────────────────────────────────────────────
//
// Reuses the router's embedding service. Tool centroids are deterministic
// from the anchors + embedding model, so we cache them per-embeddings-URL in
// process memory (rebuilt on restart — one batch embed call). No config
// schema change, no migration.

interface ToolCentroids {
  centroids: Record<string, number[]>; // includes "none"
  builtAt: number;
}
const _toolCentroidCache = new Map<string, ToolCentroids>();
let _toolBuildInflight: Map<string, Promise<ToolCentroids>> = new Map();

async function getToolCentroids(
  embeddingsUrl: string,
  embeddingsModel?: string,
): Promise<ToolCentroids> {
  const cached = _toolCentroidCache.get(embeddingsUrl);
  if (cached) return cached;

  // Deduplicate concurrent builds for the same URL.
  const inflight = _toolBuildInflight.get(embeddingsUrl);
  if (inflight) return inflight;

  const build = (async (): Promise<ToolCentroids> => {
    const labels = ["none", ...TOOL_NAMES];
    const flat: string[] = [];
    const ranges: Record<string, [number, number]> = {};
    let cursor = 0;
    for (const label of labels) {
      const arr = TOOL_ANCHORS[label];
      ranges[label] = [cursor, cursor + arr.length];
      flat.push(...arr);
      cursor += arr.length;
    }
    const all = await embed(embeddingsUrl, flat, embeddingsModel);
    const centroids: Record<string, number[]> = {};
    for (const label of labels) {
      const [start, end] = ranges[label];
      centroids[label] = normalize(mean(all.slice(start, end).map(normalize)));
    }
    const result = { centroids, builtAt: Date.now() };
    _toolCentroidCache.set(embeddingsUrl, result);
    _toolBuildInflight.delete(embeddingsUrl);
    return result;
  })();

  _toolBuildInflight.set(embeddingsUrl, build);
  return build;
}

export interface ToolIntentResult {
  tools: string[];                       // tool names to inject (may be empty)
  scores: Record<string, number>;        // per-tool cosine (incl. "none")
  ms: number;
}

/**
 * Detect which tools a message needs via the SAME embedding the router
 * computes for model selection. Pass the precomputed message embedding to
 * avoid a second round-trip; otherwise it embeds the text itself.
 *
 * A tool is selected when its centroid score beats the "none" centroid by
 * `margin` (default 0.02). This makes detection relative — conversational
 * messages land on "none" and inject nothing, no brittle absolute threshold.
 */
export async function detectToolIntent(
  text: string,
  config: RouterConfig,
  opts?: { embedding?: number[]; margin?: number; maxTools?: number },
): Promise<ToolIntentResult> {
  if (!config.embeddingsUrl) {
    return { tools: [], scores: {}, ms: 0 };
  }
  const margin = opts?.margin ?? 0.02;
  const maxTools = opts?.maxTools ?? 3;
  const t0 = Date.now();

  const tc = await getToolCentroids(config.embeddingsUrl, config.embeddingsModel);

  let q: number[];
  if (opts?.embedding && opts.embedding.length) {
    q = normalize(opts.embedding);
  } else {
    const [vec] = await embed(config.embeddingsUrl, [text], config.embeddingsModel);
    q = normalize(vec);
  }

  const scores: Record<string, number> = {};
  for (const label of Object.keys(tc.centroids)) {
    scores[label] = dot(q, tc.centroids[label]);
  }
  const noneScore = scores["none"] ?? 0;

  // Tools beating "none" by the margin, best first, capped.
  const winners = TOOL_NAMES
    .map((t) => ({ t, s: scores[t] ?? -Infinity }))
    .filter((x) => x.s > noneScore + margin)
    .sort((a, b) => b.s - a.s)
    .slice(0, maxTools)
    .map((x) => x.t);

  return { tools: winners, scores, ms: Date.now() - t0 };
}

/** Read-only snapshot of tool anchors (for a UI/test endpoint). */
export function getToolAnchors(): Record<string, string[]> {
  return TOOL_ANCHORS;
}
