/**
 * LLM tool registry.
 *
 * Two add-ons feed tools into the chat route:
 *   - "Web Search" (Tavily) → web_search, web_fetch
 *   - "Hermes Agent"        → hermes_quick, hermes_deep
 *
 * Each add-on lives in `addons` (kind=plugin) with its config stored in
 * `addons.config`. When enabled and the model is tool-capable, the chat
 * route exposes the matching tool schemas; when the LLM emits tool_calls,
 * `executeTool` dispatches by name.
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
      name: "hermes_quick",
      description:
        "Delegate a SHORT operational task to Hermes Agent. Use for things " +
        "like running a shell command on the cluster, reading a file from " +
        "the Obsidian vault, generating an image via ComfyUI, searching the " +
        "RAG, or any one-off action that should complete in under 2 minutes. " +
        "Returns the final result. Don't use for casual questions — use your " +
        "own knowledge or web_search for those.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "The task in natural language. Be specific about what to do " +
              "and what to return. Hermes will pick the right tool.",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "hermes_deep",
      description:
        "Delegate a LONG-RUNNING multi-step task to Hermes Agent. Use for " +
        "things that need 5+ minutes: code generation across multiple files, " +
        "iterative refinement, deep research with many tool calls, scheduled " +
        "background jobs. Returns a session_id immediately; the result lands " +
        "later. Tell the user explicitly that the task is running in the " +
        "background and they can come back to check.",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "The task description, detailed enough for autonomous execution.",
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
  selectedSkills?: string[];
  defaultModel?: string;
  autonomous?: boolean;
};

const HERMES_DEFAULT_BRIDGE = "http://192.168.86.44:8002";

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
  return (await getHermesConfig(userId)) !== null;
}

async function hermesRun(
  userId: string,
  args: ToolArgs,
  mode: "quick" | "deep",
): Promise<ToolResult> {
  const cfg = await getHermesConfig(userId);
  if (!cfg) {
    return { ok: false, error: "Hermes Agent add-on is not enabled." };
  }
  const url = (cfg.apiUrl ?? process.env.HERMES_BRIDGE_URL ?? HERMES_DEFAULT_BRIDGE).replace(
    /\/+$/,
    "",
  );
  const task = String(args.task ?? "");
  if (!task) return { ok: false, error: "missing 'task' argument" };

  const body = {
    prompt: task,
    mode,
    model: cfg.defaultModel ?? "claude-haiku",
    skills: cfg.selectedSkills ?? [],
    yolo: mode === "deep" ? !!cfg.autonomous : false,
  };

  try {
    const r = await fetch(`${url}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Quick is awaited end-to-end by the bridge (default 180s) — give the
      // upstream call generous slack. Deep returns immediately so this is
      // mostly the network round-trip.
      signal: AbortSignal.timeout(mode === "quick" ? 200_000 : 10_000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return {
        ok: false,
        error: `bridge ${r.status}: ${text.slice(0, 200)}`,
      };
    }
    const data = (await r.json()) as Record<string, unknown>;
    return { ok: true, data };
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
  if (name === "hermes_quick") return hermesRun(userId, args, "quick");
  if (name === "hermes_deep") return hermesRun(userId, args, "deep");
  return { ok: false, error: `unknown tool: ${name}` };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
