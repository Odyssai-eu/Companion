/**
 * LLM tool registry.
 *
 * Two add-ons feed tools into the chat route:
 *   - "Web Search" (Tavily) → web_search, web_fetch
 *   - "Hermes Agent"        → hermes_agent
 *
 * Each add-on lives in `addons` (kind=plugin) with its config stored in
 * `addons.config`. When enabled and the model is tool-capable, the chat
 * route exposes the matching tool schemas; when the LLM emits tool_calls,
 * `executeTool` dispatches by name.
 *
 * Hermes Agent talks to the native Hermes Gateway (NousResearch hermes-agent
 * v0.12+) on `:8642` — OpenAI-compatible chat completions with mandatory
 * Bearer auth. Tools/skills are owned by Hermes itself, not selectable
 * from our side.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../db/index";
import { addons } from "../db/schema";

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

const HERMES_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "hermes_agent",
      description:
        "Delegate an operational task to the Hermes Agent. Hermes runs on " +
        "the user's cluster with its own toolset (terminal, file ops, RAG " +
        "search, ComfyUI, Obsidian, etc.). Use this when the task requires " +
        "real action on the cluster, not just reasoning — e.g. 'run this " +
        "command', 'read this file from the vault', 'generate an image', " +
        "'search the personal knowledge base'. Hermes will pick the right " +
        "internal tool and return the final result. For pure reasoning or " +
        "casual chat, use your own knowledge or web_search instead.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The task in natural language. Be specific about what to do " +
              "and what you expect back. Hermes handles tool selection.",
          },
        },
        required: ["task"],
      },
    },
  },
];

export const TOOL_SCHEMAS = WEB_SEARCH_TOOLS;  // legacy export for places that still reference it

/** All tools exposed to the model, filtered by which add-ons are enabled. */
export async function toolsForUser(userId: string): Promise<unknown[]> {
  const out: unknown[] = [];
  if (await isWebSearchEnabled(userId)) out.push(...WEB_SEARCH_TOOLS);
  if (await isHermesEnabled(userId)) out.push(...HERMES_TOOLS);
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
export async function executeTool(
  name: string,
  args: ToolArgs,
  userId: string,
): Promise<ToolResult> {
  if (name === "web_search" || name === "web_fetch") {
    return executeWebTool(name, args, userId);
  }
  if (name === "hermes_agent") return hermesRun(userId, args);
  return { ok: false, error: `unknown tool: ${name}` };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
