/**
 * In-process BM25 search over Companion's user-guide markdown corpus.
 *
 * Why BM25 (and not embeddings)?
 *  - The corpus is tiny (~22 articles, ~50 KB total). Cosine over embeddings
 *    would mean a hard dependency on an embedding service (the Auto Router
 *    add-on, or shipping our own). BM25 needs zero external deps and works
 *    well at this scale.
 *  - Operators get /help out of the box — no embedding service to configure.
 *  - Keyword-driven help has a predictable model: typing a slug or feature
 *    name lands you on the right article.
 *
 * The corpus is loaded from `src/content/user-guide/*.md` (the same files
 * that used to feed the in-app User Guide page) at server boot, then cached
 * in memory. Articles can be re-loaded by calling reloadCorpus() — useful
 * for dev hot-reload; production restarts the server.
 *
 * BM25 implementation is minimal (no library, ~60 lines). Standard params
 * (k1=1.5, b=0.75) work fine at this corpus size.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────

export type WikiArticle = {
  /** Filename without extension or numeric prefix (e.g. `06-model-picker.md`
   *  → `model-picker`). Matches the slug used on the docs site, so the
   *  source chip can link to `/docs/companion/<slug>/`. */
  slug: string;
  /** First H1 in the file. Falls back to slug. */
  title: string;
  /** Full raw markdown body, H1 stripped. */
  body: string;
  /** Pre-tokenized terms for BM25 scoring. */
  terms: string[];
  /** Term frequency map: term → count in this article. */
  tf: Map<string, number>;
};

export type HelpHit = {
  slug: string;
  title: string;
  body: string;
  score: number;
};

// ── Tokenization ──────────────────────────────────────────────────────────

/**
 * Lowercase, strip punctuation, split on whitespace, drop tokens shorter
 * than 2 chars and a small English stopword set. Markdown syntax (backticks,
 * hashes, asterisks) gets stripped before tokenization so a query like
 * "model picker" matches "## Model picker".
 *
 * /help is English-only for v1: the wiki is in English and so are the
 * keyword matches. A multilingual story (LLM query translation, or swapping
 * BM25 for embedding search via the Auto Router add-on) is a future feature
 * — keeping the tokenizer language-neutral here so we don't bake any
 * locale-specific assumptions in for whoever installs Companion.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "is", "are", "be", "and",
  "or", "with", "by", "as", "at", "it", "that", "this", "from", "you", "your",
  "we", "our", "if", "but", "not", "no", "yes", "do", "does", "can", "will",
  "into", "out", "than", "then", "when", "where", "what", "who", "why", "how",
  "all", "any", "some", "more", "most", "less", "very", "so", "just",
]);

const STRIP_MD = /[`*_#>\[\]\(\)<>{}]/g;
const NON_WORD = /[^\p{L}\p{N}-]+/gu;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(STRIP_MD, " ")
    .split(NON_WORD)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// ── BM25 index ────────────────────────────────────────────────────────────

class Bm25Index {
  private articles: WikiArticle[] = [];
  private avgLen = 0;
  private df: Map<string, number> = new Map();
  private k1 = 1.5;
  private b = 0.75;

  build(articles: WikiArticle[]): void {
    this.articles = articles;
    this.df = new Map();
    let total = 0;
    for (const a of articles) {
      total += a.terms.length;
      const seen = new Set(a.terms);
      for (const t of seen) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
    this.avgLen = articles.length === 0 ? 0 : total / articles.length;
  }

  search(query: string, topK: number = 5): HelpHit[] {
    const qTerms = tokenize(query);
    if (qTerms.length === 0) return [];
    const N = this.articles.length;
    const scores: number[] = new Array(N).fill(0);
    for (const q of qTerms) {
      const df = this.df.get(q);
      if (!df) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < N; i++) {
        const a = this.articles[i];
        const tf = a.tf.get(q) ?? 0;
        if (tf === 0) continue;
        const dl = a.terms.length;
        const numerator = tf * (this.k1 + 1);
        const denominator =
          tf + this.k1 * (1 - this.b + (this.b * dl) / (this.avgLen || 1));
        scores[i] += idf * (numerator / denominator);
      }
    }
    const ranked = this.articles
      .map((a, i) => ({
        slug: a.slug,
        title: a.title,
        body: a.body,
        score: scores[i],
      }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return ranked;
  }

  size(): number {
    return this.articles.length;
  }
}

// ── Corpus loader ─────────────────────────────────────────────────────────

const CORPUS_DIR_CANDIDATES = [
  // Dev: repo root
  path.resolve(process.cwd(), "src/content/user-guide"),
  // Prod Docker build: /app/src/content/user-guide if shipped, else /app/wiki
  path.resolve(process.cwd(), "wiki"),
  path.resolve("/app/src/content/user-guide"),
  path.resolve("/app/wiki"),
];

function resolveCorpusDir(): string | null {
  const envDir = process.env.HELP_CORPUS_DIR;
  if (envDir && existsSync(envDir)) return envDir;
  for (const candidate of CORPUS_DIR_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function parseArticle(filePath: string, raw: string): WikiArticle {
  const file = path.basename(filePath);
  const slug = file.replace(/^[0-9]+[a-z]?-/, "").replace(/\.md$/, "");
  const lines = raw.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? titleLine.slice(2).trim() : slug;
  const body = titleLine
    ? raw.replace(titleLine, "").replace(/^\s*\n/, "")
    : raw;
  const indexText = `${title}\n${body}`;
  const terms = tokenize(indexText);
  const tf = new Map<string, number>();
  for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { slug, title, body, terms, tf };
}

const _index = new Bm25Index();
let _articles: WikiArticle[] = [];
let _loadedFrom: string | null = null;

export function loadCorpus(): void {
  const dir = resolveCorpusDir();
  if (!dir) {
    console.warn(
      "[help] no user-guide corpus directory found. Tried " +
        CORPUS_DIR_CANDIDATES.join(", ") +
        ". /help will return an empty result.",
    );
    _articles = [];
    _index.build([]);
    return;
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  const articles: WikiArticle[] = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const raw = readFileSync(p, "utf8");
      articles.push(parseArticle(p, raw));
    } catch (e) {
      console.warn(`[help] skipped ${f}: ${(e as Error).message}`);
    }
  }
  _articles = articles;
  _index.build(articles);
  _loadedFrom = dir;
  console.log(
    `[help] indexed ${articles.length} article(s) from ${dir}`,
  );
}

export async function reloadCorpus(): Promise<void> {
  // Async wrapper for symmetry with future async loaders (e.g. fetching
  // from a CDN). Today's loader is sync so we just delegate.
  return new Promise((resolve) => {
    loadCorpus();
    resolve();
  });
}

export function searchCorpus(query: string, topK: number = 5): HelpHit[] {
  if (_index.size() === 0 && _articles.length === 0) {
    // Lazy first load — handles the case where index.ts didn't pre-load.
    loadCorpus();
  }
  return _index.search(query, topK);
}

export function corpusInfo(): { count: number; loadedFrom: string | null } {
  return { count: _index.size(), loadedFrom: _loadedFrom };
}
