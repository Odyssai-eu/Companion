/**
 * LLM tool registry.
 *
 * Three categories of tools feed into the chat route:
 *   - Always-on: fs_list / fs_read / fs_write / fs_edit (workspace files)
 *   - "Web Search" addon (Tavily) → web_search, web_fetch
 *   - "Hermes Agent" addon (renamed Cluster Operations) → cluster_action
 *
 * Workspace fs tools are not gated by an addon: they're a core capability
 * of the agentic UX. Tool calls always operate on the user's own scope.
 *
 * Hermes Agent talks to the native Hermes Gateway (NousResearch hermes-agent
 * v0.12+) on `:8642` — OpenAI-compatible chat completions with mandatory
 * Bearer auth. Repositioned in v0.2 from generic agent delegate to
 * cluster-specific operations (RAG / ComfyUI / Obsidian vault / rsync).
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index";
import { addons } from "../db/schema";
import { fsEdit, fsList, fsRead, fsWrite, WorkspaceError } from "./workspace";

const ADDON_NAME = "Web Search";
const HERMES_ADDON_NAME = "Hermes Agent";

// ── OpenAI-compat tool schemas ────────────────────────────────────────────

const WEB_SEARCH_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description:
        "Search the web for up-to-date information. Returns a list of " +
        "relevant pages, each with title, URL, and a short snippet. Use this " +
        "when the user asks about recent events, current state of a project, " +
        "real-time data, or anything you wouldn't reliably know.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query, in natural language.",
          },
          max_results: {
            type: "integer",
            description: "How many results to return (1–10).",
            default: 5,
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_fetch",
      description:
        "Fetch the contents of a single URL and return clean extracted text " +
        "(typically Markdown). Use this after web_search to read a specific " +
        "page in depth, or when the user gives you a URL directly.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch.",
          },
        },
        required: ["url"],
      },
    },
  },
];

// HERMES_TOOLS removed — cluster_action is no longer exposed to regular
// chat models. Users access Hermes directly via 'New Hermes' conversations
// (kind='hermes'), which route to the gateway and use its native tool
// layer. The hermesRun() helper below is still used internally by the
// `cluster_action` / `hermes_agent` dispatcher names for any in-flight
// conversation that might call them, but the tool isn't advertised.

// ── rag_search (always on when RAG_QDRANT_URL is set) ────────────────────

const RAG_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "rag_search",
      description:
        "Semantic search over the user's personal knowledge base (Qdrant + " +
        "bge-m3 embeddings). Use this for questions about anything the user " +
        "has previously written, ingested or curated — papers, notes, project " +
        "docs, web crawls. Returns top-K passages with their source path and " +
        "similarity score. Faster than cluster_action for the same job " +
        "(direct Qdrant query, no Hermes loop).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Natural language query.",
          },
          limit: {
            type: "integer",
            description: "Max number of passages (1–10).",
            default: 5,
          },
        },
        required: ["query"],
      },
    },
  },
];

// ── fs tools (always on, no addon gating) ─────────────────────────────────

const FS_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "fs_list",
      description:
        "List files in the user's workspace. Returns an array of " +
        "{path, sizeBytes, mimeType, updatedAt}. Use this to discover " +
        "what's available before reading.",
      parameters: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description:
              "Optional path prefix to filter, e.g. 'notes/' to list everything " +
              "under notes/. Omit for full listing.",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fs_read",
      description:
        "Read the full text content of a file from the user's workspace.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative path, e.g. 'notes/meeting.md'.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fs_write",
      description:
        "Create a new file or fully overwrite an existing one in the user's " +
        "workspace. For modifying parts of an existing file, prefer fs_edit.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fs_edit",
      description:
        "Replace an exact string in an existing file. Fails if old_string " +
        "is not found or matches multiple locations — in that case, pass more " +
        "context in old_string to make it unique. Use this for surgical edits " +
        "instead of rewriting the entire file with fs_write.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: {
            type: "string",
            description: "Exact string to replace. Must be unique in the file.",
          },
          new_string: {
            type: "string",
            description: "Replacement string.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
];

export const TOOL_SCHEMAS = WEB_SEARCH_TOOLS;  // legacy export for places that still reference it

/** All tools exposed to the model.
 *  - fs_* are always on (workspace files, scoped per user).
 *  - rag_search is always on when RAG_QDRANT_URL is reachable (env-gated).
 *  - web_* require the Web Search addon (Tavily key).
 *  - cluster_action requires the Hermes Agent addon (gateway + key).
 */
export async function toolsForUser(userId: string): Promise<unknown[]> {
  const out: unknown[] = [...FS_TOOLS];
  if (isRagConfigured()) out.push(...RAG_TOOLS);
  if (await isWebSearchEnabled(userId)) out.push(...WEB_SEARCH_TOOLS);
  // cluster_action (Hermes) is intentionally NOT exposed to regular chat
  // models anymore. Users who want Hermes pick a 'New Hermes' conversation
  // from the sidebar — that routes directly to the Hermes gateway, which
  // runs its own native tool layer. This avoids the double-orchestration
  // (chat model deciding when to call cluster_action vs. talking to
  // Hermes directly) which empirically gave mediocre results.
  return out;
}

// ── Tavily client ────────────────────────────────────────────────────────

const TAVILY_BASE = "https://api.tavily.com";

type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  score?: number;
};

async function tavilySearch(
  apiKey: string,
  query: string,
  maxResults = 5,
): Promise<{
  query: string;
  answer?: string;
  results: TavilySearchResult[];
}> {
  const r = await fetch(`${TAVILY_BASE}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      max_results: clamp(maxResults, 1, 10),
      include_answer: "basic",
      search_depth: "basic",
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`tavily_search ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = (await r.json()) as {
    query: string;
    answer?: string;
    results?: TavilySearchResult[];
  };
  return {
    query: data.query,
    answer: data.answer,
    results: data.results ?? [],
  };
}

async function tavilyExtract(
  apiKey: string,
  url: string,
): Promise<{ url: string; content: string; raw?: string }> {
  const r = await fetch(`${TAVILY_BASE}/extract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      urls: [url],
      format: "markdown",
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`tavily_extract ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = (await r.json()) as {
    results?: Array<{ url: string; raw_content?: string; content?: string }>;
  };
  const first = data.results?.[0];
  if (!first) throw new Error("tavily_extract: empty results");
  return {
    url: first.url,
    content: first.raw_content ?? first.content ?? "",
  };
}

// ── Add-on lookup ─────────────────────────────────────────────────────────

type WebSearchConfig = { apiKey?: string };

export async function getWebSearchKey(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ enabled: addons.enabled, config: addons.config })
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as WebSearchConfig;
  return cfg.apiKey ?? null;
}

export async function isWebSearchEnabled(userId: string): Promise<boolean> {
  const k = await getWebSearchKey(userId);
  return Boolean(k);
}

// ── Hermes add-on lookup ──────────────────────────────────────────────────

type HermesConfig = {
  apiUrl?: string;
  apiKey?: string;
  defaultModel?: string;
};

const HERMES_DEFAULT_GATEWAY = "http://192.168.86.50:8642";

/**
 * Resolve the Hermes Agent gateway target for a user. Used both by the
 * `cluster_action` tool inside regular chats AND by the chat route when
 * a conversation has kind='hermes' and we route directly to the Hermes
 * gateway instead of LiteLLM.
 *
 * Returns null when the addon is missing/disabled. The caller is
 * responsible for surfacing a useful error.
 */
export async function resolveHermesTarget(userId: string): Promise<{
  baseUrl: string;
  apiKey: string | null;
  model: string;
} | null> {
  const cfg = await getHermesConfig(userId);
  if (!cfg) return null;
  const baseUrl = (
    cfg.apiUrl ?? process.env.HERMES_GATEWAY_URL ?? HERMES_DEFAULT_GATEWAY
  ).replace(/\/+$/, "");
  return {
    baseUrl,
    apiKey: cfg.apiKey ?? null,
    model: cfg.defaultModel ?? "hermes-agent",
  };
}

async function getHermesConfig(
  userId: string,
): Promise<HermesConfig | null> {
  const [row] = await db
    .select({ enabled: addons.enabled, config: addons.config })
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, HERMES_ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  return (row.config ?? {}) as HermesConfig;
}

export async function isHermesEnabled(userId: string): Promise<boolean> {
  const cfg = await getHermesConfig(userId);
  // Need both enabled AND an api key — the gateway always rejects unauth.
  return cfg !== null && Boolean(cfg.apiKey);
}

/**
 * Call the Hermes Gateway as an OpenAI-compatible chat completion.
 * Hermes itself decides which internal tool to use and returns the final
 * assistant message text. We surface that text as the tool result so the
 * caller LLM can integrate it into its reply.
 */
async function hermesRun(
  userId: string,
  args: ToolArgs,
): Promise<ToolResult> {
  const cfg = await getHermesConfig(userId);
  if (!cfg) {
    return { ok: false, error: "Hermes Agent add-on is not enabled." };
  }
  if (!cfg.apiKey) {
    return {
      ok: false,
      error: "Hermes Agent: missing API key. Configure it in Settings → Add-ons → Hermes Agent.",
    };
  }
  const url = (cfg.apiUrl ?? process.env.HERMES_GATEWAY_URL ?? HERMES_DEFAULT_GATEWAY).replace(
    /\/+$/,
    "",
  );
  const task = String(args.task ?? "");
  if (!task) return { ok: false, error: "missing 'task' argument" };

  const body = {
    model: cfg.defaultModel ?? "hermes-agent",
    messages: [{ role: "user", content: task }],
    stream: false,
  };

  try {
    const r = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      // Hermes can chain many internal tool calls; allow generous slack.
      // Hermes can chain many internal tool calls; 5 min was too tight on
      // long Qwen 397B loops. 15 min is more realistic for vault reads /
      // RAG queries / deep agent runs.
      signal: AbortSignal.timeout(900_000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return {
        ok: false,
        error: `hermes ${r.status}: ${text.slice(0, 200)}`,
      };
    }
    const data = (await r.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    return {
      ok: true,
      data: {
        content,
        usage: data.usage,
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Executor ──────────────────────────────────────────────────────────────

type ToolArgs = Record<string, unknown>;

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

async function executeWebTool(
  name: string,
  args: ToolArgs,
  userId: string,
): Promise<ToolResult> {
  const apiKey = await getWebSearchKey(userId);
  if (!apiKey) {
    return {
      ok: false,
      error: "Web Search add-on is not enabled or no Tavily API key is set.",
    };
  }
  try {
    if (name === "web_search") {
      const query = String(args.query ?? "");
      const maxResults =
        typeof args.max_results === "number" ? args.max_results : 5;
      if (!query) return { ok: false, error: "missing 'query' argument" };
      const data = await tavilySearch(apiKey, query, maxResults);
      return { ok: true, data };
    }
    if (name === "web_fetch") {
      const url = String(args.url ?? "");
      if (!url) return { ok: false, error: "missing 'url' argument" };
      const data = await tavilyExtract(apiKey, url);
      return { ok: true, data };
    }
    return { ok: false, error: `unknown web tool: ${name}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Public dispatcher — routes by tool name to the right backend. */
// ── RAG (Qdrant + bge-m3) ─────────────────────────────────────────────────

const RAG_QDRANT_URL = process.env.RAG_QDRANT_URL ?? "http://192.168.86.44:6333";
const RAG_EMBED_URL = process.env.RAG_EMBED_URL ?? "http://192.168.86.44:8082";
const RAG_COLLECTION = process.env.RAG_COLLECTION ?? "obsidian-context";

function isRagConfigured(): boolean {
  return Boolean(RAG_QDRANT_URL && RAG_EMBED_URL && RAG_COLLECTION);
}

async function ragSearch(
  query: string,
  limit: number,
): Promise<ToolResult> {
  if (!isRagConfigured()) {
    return { ok: false, error: "rag not configured" };
  }
  const k = clamp(limit, 1, 10);
  try {
    // 1. Embed the query
    const embedResp = await fetch(`${RAG_EMBED_URL}/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: [query] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!embedResp.ok) {
      const t = await embedResp.text().catch(() => "");
      return {
        ok: false,
        error: `embed ${embedResp.status}: ${t.slice(0, 160)}`,
      };
    }
    const embedJson = (await embedResp.json()) as {
      embeddings?: number[][];
    };
    const vector = embedJson.embeddings?.[0];
    if (!vector || vector.length === 0) {
      return { ok: false, error: "embed: empty vector" };
    }

    // 2. Qdrant search
    const searchResp = await fetch(
      `${RAG_QDRANT_URL}/collections/${encodeURIComponent(RAG_COLLECTION)}/points/search`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vector,
          limit: k,
          with_payload: true,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!searchResp.ok) {
      const t = await searchResp.text().catch(() => "");
      return {
        ok: false,
        error: `qdrant ${searchResp.status}: ${t.slice(0, 160)}`,
      };
    }
    const searchJson = (await searchResp.json()) as {
      result?: Array<{
        score?: number;
        payload?: Record<string, unknown>;
        id?: number | string;
      }>;
    };
    const hits = (searchJson.result ?? []).map((r) => {
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
    return { ok: true, data: { query, hits } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function executeFsTool(
  name: string,
  args: ToolArgs,
  userId: string,
): Promise<ToolResult> {
  try {
    if (name === "fs_list") {
      const data = await fsList(
        userId,
        typeof args.prefix === "string" ? args.prefix : undefined,
      );
      return { ok: true, data };
    }
    if (name === "fs_read") {
      const data = await fsRead(userId, String(args.path ?? ""));
      return { ok: true, data };
    }
    if (name === "fs_write") {
      const data = await fsWrite(
        userId,
        String(args.path ?? ""),
        String(args.content ?? ""),
      );
      return { ok: true, data };
    }
    if (name === "fs_edit") {
      const data = await fsEdit(
        userId,
        String(args.path ?? ""),
        String(args.old_string ?? ""),
        String(args.new_string ?? ""),
      );
      return { ok: true, data };
    }
    return { ok: false, error: `unknown fs tool: ${name}` };
  } catch (err) {
    if (err instanceof WorkspaceError) {
      return { ok: false, error: `${err.code}: ${err.message}` };
    }
    return { ok: false, error: (err as Error).message };
  }
}

export async function executeTool(
  name: string,
  args: ToolArgs,
  userId: string,
): Promise<ToolResult> {
  if (name.startsWith("fs_")) return executeFsTool(name, args, userId);
  if (name === "rag_search") {
    const q = String(args.query ?? "");
    const limit = typeof args.limit === "number" ? args.limit : 5;
    if (!q) return { ok: false, error: "missing 'query' argument" };
    return ragSearch(q, limit);
  }
  if (name === "web_search" || name === "web_fetch") {
    return executeWebTool(name, args, userId);
  }
  // `hermes_agent` kept as alias for in-flight conversations created
  // before the rename to `cluster_action` (v0.2).
  if (name === "cluster_action" || name === "hermes_agent") {
    return hermesRun(userId, args);
  }
  return { ok: false, error: `unknown tool: ${name}` };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
