/**
 * LLM tool registry.
 *
 * Three categories of tools feed into the chat route:
 *   - Always-on: fs_list / fs_read / fs_write / fs_edit (workspace files)
 *   - "Web Search" addon (Tavily) → web_search, web_fetch
 *   - MCP servers (per-user, dynamic)
 *
 * Workspace fs tools are not gated by an addon: they're a core capability
 * of the agentic UX. Tool calls always operate on the user's own scope.
 *
 * The Hermes Agent integration (cluster_action / hermes_agent tool) was
 * retired 2026-05-19. Stubs remain in the executor to gracefully reject
 * any in-flight tool calls from old conversations.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isLocalAgentConnected, localAgentExecute } from "../routes/local-agent";
import { db } from "../db/index";
import { addons, agentSkills, mcpServers } from "../db/schema";
import {
  callTool as callMcpTool,
  fetchTools as fetchMcpTools,
  parseMcpToolName,
  type McpToolSpec,
} from "./mcp-client";
import { parseSkillMd, SkillParseError } from "./skill-format";
import { fsEdit, fsList, fsRead, fsWrite, WorkspaceError } from "./workspace";

const execFileAsync = promisify(execFile);

const ADDON_NAME = "Web Search";

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

// cluster_action / hermes_agent tools are retired (2026-05-19). The
// executor still recognises the names so legacy conversations get a
// clean error rather than a crash.

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
        "similarity score.",
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

// ── Native web + bash tools (no addon, no API key) ───────────────────────

const NATIVE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description:
        "Search the web using DuckDuckGo. Returns title, URL and snippet " +
        "for each result. Use when the user asks about current events, " +
        "projects, real-time data, or anything you wouldn't reliably know. " +
        "No API key required.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          num_results: {
            type: "integer",
            description: "Number of results to return (1–20, default 5).",
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
      name: "web_read",
      description:
        "Fetch a URL and return clean text (scripts/styles stripped). " +
        "Paginated via start_pos + max_length. Use after web_search to " +
        "read a specific page, or when given a direct URL. Results cached " +
        "24 h.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch." },
          start_pos: {
            type: "integer",
            description: "Start reading from this character offset (default 0).",
            default: 0,
          },
          max_length: {
            type: "integer",
            description: "Max characters to return (default 8000).",
            default: 8000,
          },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_read_full",
      description:
        "Fetch a URL and return the complete text content (no pagination). " +
        "WARNING: can return very large amounts of text. Prefer web_read " +
        "with pagination unless you need the full document. Cached 24 h.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "bash",
      description:
        "Run a shell command on the server. Runs in a sandboxed working " +
        "directory, timeout 30 s, no network-modifying commands. Use for " +
        "git, grep, find, build commands, file transformations. Returns " +
        "stdout + stderr. For file read/write prefer fs_read/fs_write.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to run, e.g. 'git log --oneline -10'.",
          },
        },
        required: ["command"],
      },
    },
  },
];

// Agent skills — markdown instruction packages the model loads on
// demand. Distinct from `prompt_skills` (saved system-prompt presets
// the user picks from the chat panel dropdown). The chat model
// curates these itself: when the user says "save this as a skill",
// "use the X skill", "list my skills", etc., the model invokes the
// relevant tool below. The product brief: "le skill c'est D … et il doit
// pouvoir créér lui meme un skill si je le demande."
const SKILL_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "skill_list",
      description:
        "List the user's saved agent skills. Returns an array of " +
        "{name, description, tags, source, bodyLength}. Use this to " +
        "discover what skills are already available before creating " +
        "a new one (avoid duplicates).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "skill_get",
      description:
        "Fetch the full body of a saved agent skill by name (case-" +
        "insensitive). Call this when the user asks you to 'use the X " +
        "skill', and apply the body as part of your reasoning for the " +
        "current turn (don't replace your entire system prompt — treat " +
        "the body as instructions for THIS task).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Skill name to load." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "skill_create",
      description:
        "Persist a new agent skill (agentskills.io format). Call this " +
        "when the user explicitly asks you to save a skill ('save this " +
        "as a skill named X', 'crée une skill X qui …'). Name must be " +
        "lowercase a-z/0-9/hyphen, 1-64 chars. Description (when to " +
        "invoke) capped at 1024 chars. Fails on name collision — use " +
        "skill_update instead in that case.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Slug-style identifier, lowercase a-z/0-9/hyphen, e.g. 'code-review-strict'.",
          },
          body: {
            type: "string",
            description: "Markdown body of SKILL.md (instructions).",
          },
          description: {
            type: "string",
            description: "When to invoke this skill (the trigger). ≤1024 chars.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Free-form categories.",
          },
          license: {
            type: "string",
            description: "Optional license name or file reference.",
          },
          compatibility: {
            type: "string",
            description: "Optional environment/runtime requirements (≤500 chars).",
          },
          files: {
            type: "object",
            description:
              "Optional supporting files: map of relative path (e.g. 'scripts/foo.py', 'references/notes.md') to file content as string. Keeps the skill package self-contained.",
            additionalProperties: { type: "string" },
          },
          metadata: {
            type: "object",
            description: "Arbitrary frontmatter extensions (version, author, …).",
          },
        },
        required: ["name", "body"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "skill_update",
      description:
        "Edit an existing skill by name. Provide only the fields you " +
        "want to change. Use this instead of skill_create when the " +
        "user refines an existing skill or fixes a typo.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          body: { type: "string" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          license: { type: "string" },
          compatibility: { type: "string" },
          files: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          metadata: { type: "object" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "skill_delete",
      description:
        "Remove a skill by name. Use only when the user explicitly " +
        "asks ('drop the X skill', 'supprime la skill Y').",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "skill_import_md",
      description:
        "Parse a SKILL.md document (YAML frontmatter + markdown body, " +
        "agentskills.io spec) and persist it as a new skill. Use this " +
        "when the user pastes a SKILL.md or asks you to load one from " +
        "an external library. Fails on name collision.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "Full SKILL.md content including --- frontmatter.",
          },
        },
        required: ["content"],
      },
    },
  },
];

export const TOOL_SCHEMAS = WEB_SEARCH_TOOLS;  // legacy export for places that still reference it

/** Compact agent-skills catalog — progressive-disclosure tier 1
 *  per agentskills.io. We emit one line per skill (name + description)
 *  capped at ~32 entries so the prompt overhead stays ≤2KB even for
 *  power users. The model uses `skill_get` (or `companion_get_skill`)
 *  to load the full body of any skill that looks relevant.
 *
 *  Returns null when the user has no skills (so we don't emit an
 *  empty section header that would just add noise to the prompt). */
export async function buildSkillsIndex(userId: string): Promise<string | null> {
  const rows = await db
    .select({
      name: agentSkills.name,
      description: agentSkills.description,
    })
    .from(agentSkills)
    .where(eq(agentSkills.userId, userId))
    .orderBy(asc(agentSkills.name))
    .limit(32);
  if (rows.length === 0) return null;
  const lines = rows.map((r) =>
    r.description ? `- ${r.name}: ${r.description}` : `- ${r.name}`,
  );
  return [
    "## Agent skills available",
    "",
    "Use `skill_get` to load the full body of a skill when its description matches the user's request. Don't replace your system prompt — apply the body as task-specific instructions.",
    "",
    ...lines,
  ].join("\n");
}

/** Skill tools — always on (per product brief 2026-05-20).
 *  The model needs to be able to list/load/create/update/delete skills
 *  on any turn, regardless of agentMode. Tiny schema (~5 tools, no
 *  large enums) — adds <500 tokens to the prompt and doesn't force
 *  non-streaming on jaccl. */
export function alwaysOnTools(): unknown[] {
  return [...SKILL_TOOLS];
}

/** Agent-mode tools exposed to the model.
 *  - fs_* (workspace files, scoped per user).
 *  - rag_search when RAG_QDRANT_URL is reachable (env-gated).
 *  - web_* require the Web Search addon (Tavily key).
 *  - MCP servers are per-user (dynamic, see collectMcpTools).
 *  Note: SKILL_TOOLS are NOT here — see alwaysOnTools(). */
export async function toolsForUser(userId: string): Promise<unknown[]> {
  const out: unknown[] = [...FS_TOOLS, ...NATIVE_TOOLS];
  if (isRagConfigured()) out.push(...RAG_TOOLS);
  if (await isWebSearchEnabled(userId)) out.push(...WEB_SEARCH_TOOLS);

  // MCP tools — third-party servers the user registered. Read the cache
  // and refresh entries older than the TTL in the background; the cached
  // shape is good enough for the immediate response. New servers (no
  // cache yet) get a synchronous fetch — first chat after adding a
  // server pays the round-trip, subsequent turns are instant.
  out.push(...(await collectMcpTools(userId)));

  return out;
}

const MCP_CACHE_TTL_MS = 5 * 60 * 1000;

async function collectMcpTools(userId: string): Promise<unknown[]> {
  const rows = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, userId), eq(mcpServers.enabled, true)));
  const out: unknown[] = [];
  for (const row of rows) {
    let tools = row.toolsCache;
    const stale =
      !row.toolsCacheAt ||
      Date.now() - new Date(row.toolsCacheAt).getTime() > MCP_CACHE_TTL_MS;
    // Synchronous refresh only when we have nothing at all to show.
    // Stale caches get returned now and refreshed in the background so
    // the chat turn doesn't wait on a 3rd-party server.
    if (!tools || tools.length === 0) {
      try {
        tools = await fetchMcpTools(row);
        await db
          .update(mcpServers)
          .set({
            toolsCache: tools,
            toolsCacheAt: new Date(),
            lastError: null,
          })
          .where(eq(mcpServers.id, row.id));
      } catch (e) {
        await db
          .update(mcpServers)
          .set({ lastError: (e as Error).message })
          .where(eq(mcpServers.id, row.id));
        continue;
      }
    } else if (stale) {
      // Fire-and-forget refresh. Don't block the chat turn.
      void fetchMcpTools(row)
        .then((fresh) =>
          db
            .update(mcpServers)
            .set({
              toolsCache: fresh,
              toolsCacheAt: new Date(),
              lastError: null,
            })
            .where(eq(mcpServers.id, row.id)),
        )
        .catch((e) =>
          db
            .update(mcpServers)
            .set({ lastError: (e as Error).message })
            .where(eq(mcpServers.id, row.id)),
        );
    }
    for (const t of tools) {
      out.push(toOpenAiTool(row.slug, t));
    }
  }
  return out;
}

/**
 * Wrap an MCP tool spec into the OpenAI tool format the chat loop
 * expects. Tool name is namespaced `mcp_<slug>_<tool>` so the same
 * underlying name can come from multiple servers without collision.
 *
 * The MCP `inputSchema` is a JSON Schema, which is exactly what
 * OpenAI's `parameters` field wants — pass through verbatim. When the
 * server didn't ship a schema, fall back to a permissive "any object"
 * shape so the model can still pass arbitrary args.
 */
function toOpenAiTool(serverSlug: string, t: McpToolSpec): unknown {
  // MCP inputSchema is already JSON Schema = exactly what OpenAI's
  // `parameters` wants. Pass it through verbatim.
  //
  // We used to run it through a sanitizer that stripped `default: null`
  // and `{type: "null"}` anyOf branches, because Telemak Swift's Jinja
  // chat-template renderer crashed on those ("Cannot convert value of
  // type Optional<Any> to Jinja Value", 2026-05-29). Telemak 0.6.20
  // fixed that natively — verified by sending a raw null-schema tool to
  // a Telemak cluster and getting 200 OK — so the workaround is gone.
  return {
    type: "function" as const,
    function: {
      name: `mcp_${serverSlug}_${t.name}`,
      description: t.description ?? `${t.name} (via ${serverSlug})`,
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  };
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

// ── Legacy Hermes tools (no-op stubs) ─────────────────────────────────────
// The OLD tool-call-based Hermes integration (the model would invoke
// `hermes_agent` / `cluster_action` directly during a chat turn) is
// gone. The CURRENT Hermes integration is the `/hermes` slash command
// + ACP bridge — see Settings → Add-ons → Hermes Agent.
//
// We keep the legacy tool names mapped to no-op stubs so an old
// in-flight conversation that already has a tool_calls block in its
// history doesn't blow up at replay time; the stub returns a polite
// error pointing the user at the slash command.

async function hermesLegacyStub(): Promise<ToolResult> {
  return {
    ok: false,
    error:
      "The hermes_agent / cluster_action tools are no longer supported. " +
      "Use the /hermes slash command in chat instead (configure via " +
      "Settings → Add-ons → Hermes Agent).",
  };
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

const RAG_QDRANT_URL = process.env.RAG_QDRANT_URL ?? "";
const RAG_EMBED_URL = process.env.RAG_EMBED_URL ?? "";
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

// ── Native tools implementation ───────────────────────────────────────────

const WEB_CACHE_DIR = process.env.WEB_CACHE_DIR ?? "/tmp/companion-web-cache";
const WEB_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 h
const BASH_TIMEOUT_MS = 30_000;
const BASH_SANDBOX_DIR = process.env.BASH_SANDBOX_DIR ?? "/tmp/companion-bash";

/** Fetch a URL, strip HTML, cache 24 h. Returns plain text. */
async function fetchUrl(url: string): Promise<string> {
  const key = createHash("sha256").update(url).digest("hex");
  const cacheFile = join(WEB_CACHE_DIR, key + ".txt");

  // Cache hit?
  try {
    const s = await stat(cacheFile);
    if (Date.now() - s.mtimeMs < WEB_CACHE_TTL_MS) {
      return await readFile(cacheFile, "utf8");
    }
  } catch {
    // cache miss — proceed
  }

  const resp = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const html = await resp.text();

  // Strip script/style/comments/tags
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  // Write cache
  await mkdir(WEB_CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, text, "utf8").catch(() => undefined);
  return text;
}

async function executeNativeTool(
  name: string,
  args: ToolArgs,
): Promise<ToolResult> {
  try {
    // ── web_search ──────────────────────────────────────────────────────
    if (name === "web_search") {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "missing 'query'" };
      const numResults = Math.min(20, Math.max(1, Number(args.num_results ?? 5)));

      const encoded = encodeURIComponent(query);
      const ddgUrl = `https://lite.duckduckgo.com/lite/?q=${encoded}`;
      // Parse DuckDuckGo Lite HTML: split by numbered result markers
      // then extract href + title + snippet from each block.
      const rawHtml = await (async () => {
        // fetchUrl strips HTML — we need raw HTML for DDG parsing
        const key = createHash("sha256").update(ddgUrl).digest("hex");
        const cacheFile = join(WEB_CACHE_DIR, key + ".html");
        try {
          const s = await stat(cacheFile);
          if (Date.now() - s.mtimeMs < WEB_CACHE_TTL_MS) {
            return await readFile(cacheFile, "utf8");
          }
        } catch { /* miss */ }
        const r = await fetch(ddgUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!r.ok) throw new Error(`DDG HTTP ${r.status}`);
        const html = await r.text();
        await mkdir(WEB_CACHE_DIR, { recursive: true });
        await writeFile(cacheFile, html, "utf8").catch(() => undefined);
        return html;
      })();

      const results: { title: string; link: string; snippet: string }[] = [];
      // Split by numbered td markers
      const sections = rawHtml.split(/<tr>\s*<td[^>]*valign="top"[^>]*>\s*\d+\.\s*&nbsp;\s*<\/td>/i);
      for (const section of sections.slice(1, numResults + 1)) {
        const hrefM = section.match(/href=['"]([^'"]+)['"]/);
        if (!hrefM) continue;
        let link = hrefM[1];
        // Extract real URL from DDG redirect param
        try {
          const uddg = new URL(link).searchParams.get("uddg");
          if (uddg) link = uddg;
        } catch { /* not a full URL */ }
        const titleM = section.match(/href=['"][^'"]+['"]>([^<]+)<\/a>/i);
        const title = titleM ? titleM[1].trim() : "";
        const snippetM = section.match(/class=['"]result-snippet['"][^>]*>([^<]*)</i);
        const snippet = snippetM
          ? snippetM[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim()
          : "";
        if (link && title) results.push({ title, link, snippet });
      }
      return {
        ok: true,
        data: { query, results, result_count: results.length },
      };
    }

    // ── web_read ────────────────────────────────────────────────────────
    if (name === "web_read") {
      const url = String(args.url ?? "").trim();
      if (!url) return { ok: false, error: "missing 'url'" };
      const startPos = Math.max(0, Number(args.start_pos ?? 0));
      const maxLength = Math.max(1, Number(args.max_length ?? 8000));
      const text = await fetchUrl(url);
      const slice = text.slice(startPos, startPos + maxLength);
      return {
        ok: true,
        data: {
          url,
          content: slice,
          content_length: slice.length,
          total_length: text.length,
          start_pos: startPos,
        },
      };
    }

    // ── web_read_full ───────────────────────────────────────────────────
    if (name === "web_read_full") {
      const url = String(args.url ?? "").trim();
      if (!url) return { ok: false, error: "missing 'url'" };
      const text = await fetchUrl(url);
      return {
        ok: true,
        data: { url, content: text, content_length: text.length },
      };
    }

    // ── bash ────────────────────────────────────────────────────────────
    if (name === "bash") {
      const command = String(args.command ?? "").trim();
      if (!command) return { ok: false, error: "missing 'command'" };

      // Basic safety: block obviously dangerous patterns
      const blocked = [
        /rm\s+-rf\s+\//,
        /mkfs/,
        /dd\s+if=/,
        /:\(\)\{.*\}/,  // fork bomb
        /shutdown|reboot|halt/,
        /chmod\s+777\s+\//,
        /sudo\s+rm/,
      ];
      for (const pattern of blocked) {
        if (pattern.test(command)) {
          return { ok: false, error: "command blocked by safety filter" };
        }
      }

      await mkdir(BASH_SANDBOX_DIR, { recursive: true });
      try {
        const { stdout, stderr } = await execFileAsync(
          "/bin/bash",
          ["-c", command],
          {
            cwd: BASH_SANDBOX_DIR,
            timeout: BASH_TIMEOUT_MS,
            maxBuffer: 1_000_000, // 1 MB output cap
            env: {
              ...process.env,
              HOME: BASH_SANDBOX_DIR,
              TMPDIR: BASH_SANDBOX_DIR,
            },
          },
        );
        return {
          ok: true,
          data: {
            stdout: stdout.slice(0, 8000),
            stderr: stderr.slice(0, 2000),
            command,
          },
        };
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        return {
          ok: false,
          error: [
            err.stderr?.slice(0, 500) || "",
            err.message || "command failed",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }
    }

    return { ok: false, error: `unknown native tool: ${name}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function executeTool(
  name: string,
  args: ToolArgs,
  userId: string,
): Promise<ToolResult> {
  // Route to local agent if connected — bash + fs tools run on user's Mac.
  // Server-side execution is the fallback when no local agent is connected.
  const LOCAL_TOOLS = new Set(["bash", "fs_read", "fs_write", "fs_list", "fs_edit"]);
  if (LOCAL_TOOLS.has(name) && isLocalAgentConnected(userId)) {
    const result = await localAgentExecute(userId, name, args as Record<string, unknown>);
    if (result) return result as ToolResult;
    // null = agent disconnected between check and call, fall through to server
  }

  if (name.startsWith("fs_")) return executeFsTool(name, args, userId);
  if (name === "rag_search") {
    const q = String(args.query ?? "");
    const limit = typeof args.limit === "number" ? args.limit : 5;
    if (!q) return { ok: false, error: "missing 'query' argument" };
    return ragSearch(q, limit);
  }
  // Native tools — no addon or API key required
  if (
    name === "web_search" ||
    name === "web_read" ||
    name === "web_read_full" ||
    name === "bash"
  ) {
    // web_search: native DDG first, Tavily fallback if addon enabled
    if (name === "web_search") {
      const native = await executeNativeTool(name, args);
      if (native.ok && (native.data as { result_count?: number })?.result_count) {
        return native;
      }
      // Fallback to Tavily if configured
      const hasAddon = await isWebSearchEnabled(userId);
      if (hasAddon) return executeWebTool("web_search", args, userId);
      return native;
    }
    return executeNativeTool(name, args);
  }
  if (name === "web_fetch") {
    return executeWebTool(name, args, userId);
  }
  if (name.startsWith("skill_")) {
    return executeSkillTool(name, args, userId);
  }
  // `cluster_action` / `hermes_agent` were the old Hermes-as-tool
  // integration. Replaced by the `/hermes` slash command; the stub
  // returns a polite error if a stale conversation still references
  // them.
  if (name === "cluster_action" || name === "hermes_agent") {
    return hermesLegacyStub();
  }
  if (name.startsWith("mcp_")) {
    return executeMcpTool(name, args, userId);
  }
  return { ok: false, error: `unknown tool: ${name}` };
}

async function executeMcpTool(
  name: string,
  args: ToolArgs,
  userId: string,
): Promise<ToolResult> {
  const parsed = parseMcpToolName(name);
  if (!parsed) return { ok: false, error: `bad MCP tool name: ${name}` };
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(
      and(eq(mcpServers.userId, userId), eq(mcpServers.slug, parsed.slug)),
    )
    .limit(1);
  if (!row) return { ok: false, error: `MCP server not found: ${parsed.slug}` };
  if (!row.enabled) {
    return { ok: false, error: `MCP server disabled: ${parsed.slug}` };
  }
  const res = await callMcpTool(row, parsed.tool, args);
  if (!res.ok) {
    // Persist last_error so the Settings UI surfaces the failure.
    await db
      .update(mcpServers)
      .set({ lastError: res.error ?? "unknown" })
      .where(eq(mcpServers.id, row.id))
      .catch(() => undefined);
    return { ok: false, error: res.error ?? "mcp_tool_failed" };
  }
  // Cap at 16k chars — typical Tavily / Qdrant tool responses are 4-10k
  // chars (full search-result payloads). The previous 4k cap routinely
  // chopped Tavily JSON mid-string, the model saw malformed JSON, decided
  // the tool failed, and retried until MAX_TOOL_ITERATIONS — exactly the
  // 2026-05-29 TeleCoder loop. 16k stays bounded enough to keep prompts
  // manageable but leaves room for valid JSON to survive.
  //
  // When we DO have to truncate, append an explicit "[truncated]" marker
  // so the model recognises partial data instead of treating it as a tool
  // failure to retry.
  if (res.content.length > 16_000) {
    return {
      ok: true,
      data: res.content.slice(0, 16_000) + "\n…[result truncated, do not retry]",
    };
  }
  return { ok: true, data: res.content };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// ── Agent skill tools ────────────────────────────────────────────────
// Dispatch the skill_* family. The chat model calls these to manage
// the agent_skills table on the user's behalf. Lookup is by name,
// case-insensitive (matches the unique index on lower(name)).

async function executeSkillTool(
  name: string,
  args: ToolArgs,
  userId: string,
): Promise<ToolResult> {
  if (name === "skill_list") return skillList(userId);
  if (name === "skill_get") return skillGet(userId, String(args.name ?? ""));
  if (name === "skill_create") {
    return skillCreate(userId, {
      name: String(args.name ?? ""),
      body: String(args.body ?? ""),
      description: args.description ? String(args.description) : null,
      tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
      license: typeof args.license === "string" ? args.license : null,
      compatibility:
        typeof args.compatibility === "string" ? args.compatibility : null,
      files: asStringMap(args.files),
      metadata: isPlainObject(args.metadata)
        ? (args.metadata as Record<string, unknown>)
        : {},
    });
  }
  if (name === "skill_update") {
    return skillUpdate(userId, {
      name: String(args.name ?? ""),
      body: typeof args.body === "string" ? args.body : undefined,
      description:
        typeof args.description === "string" ? args.description : undefined,
      tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
      license: typeof args.license === "string" ? args.license : undefined,
      compatibility:
        typeof args.compatibility === "string" ? args.compatibility : undefined,
      files: args.files === undefined ? undefined : asStringMap(args.files),
      metadata: isPlainObject(args.metadata)
        ? (args.metadata as Record<string, unknown>)
        : undefined,
    });
  }
  if (name === "skill_delete") {
    return skillDelete(userId, String(args.name ?? ""));
  }
  if (name === "skill_import_md") {
    return skillImportMd(userId, String(args.content ?? ""));
  }
  return { ok: false, error: `unknown skill tool: ${name}` };
}

async function skillImportMd(
  userId: string,
  content: string,
): Promise<ToolResult> {
  if (!content.trim()) return { ok: false, error: "missing 'content'" };
  let parsed;
  try {
    parsed = parseSkillMd(content);
  } catch (e) {
    if (e instanceof SkillParseError) return { ok: false, error: e.message };
    throw e;
  }
  return skillCreate(userId, {
    name: parsed.name,
    body: parsed.body,
    description: parsed.description,
    tags: [],
    license: parsed.license,
    compatibility: parsed.compatibility,
    files: {},
    metadata: parsed.metadata,
  });
}

async function skillList(userId: string): Promise<ToolResult> {
  const rows = await db
    .select({
      name: agentSkills.name,
      description: agentSkills.description,
      tags: agentSkills.tags,
      source: agentSkills.source,
      body: agentSkills.body,
      files: agentSkills.files,
      updatedAt: agentSkills.updatedAt,
    })
    .from(agentSkills)
    .where(eq(agentSkills.userId, userId))
    .orderBy(asc(agentSkills.name));
  const summary = rows.map((r) => ({
    name: r.name,
    description: r.description,
    tags: r.tags,
    source: r.source,
    bodyLength: r.body.length,
    fileCount: Object.keys(r.files ?? {}).length,
    updatedAt: r.updatedAt,
  }));
  return { ok: true, data: summary };
}

async function skillGet(userId: string, name: string): Promise<ToolResult> {
  if (!name.trim()) return { ok: false, error: "missing 'name' argument" };
  const [row] = await db
    .select()
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.userId, userId),
        sql`lower(${agentSkills.name}) = lower(${name})`,
      ),
    )
    .limit(1);
  if (!row) return { ok: false, error: `skill not found: ${name}` };
  return {
    ok: true,
    data: {
      name: row.name,
      description: row.description,
      tags: row.tags,
      source: row.source,
      license: row.license,
      compatibility: row.compatibility,
      body: row.body,
      files: row.files,
      metadata: row.metadata,
      updatedAt: row.updatedAt,
    },
  };
}

async function skillCreate(
  userId: string,
  input: {
    name: string;
    body: string;
    description: string | null;
    tags: string[];
    license: string | null;
    compatibility: string | null;
    files: Record<string, string>;
    metadata: Record<string, unknown>;
  },
): Promise<ToolResult> {
  if (!input.name.trim() || !input.body.trim()) {
    return { ok: false, error: "name and body are both required" };
  }
  try {
    const [row] = await db
      .insert(agentSkills)
      .values({
        userId,
        name: input.name.trim(),
        body: input.body,
        description: input.description?.trim() || null,
        tags: input.tags,
        source: "agent",
        license: input.license?.trim() || null,
        compatibility: input.compatibility?.trim() || null,
        files: input.files,
        metadata: input.metadata,
      })
      .returning({ id: agentSkills.id, name: agentSkills.name });
    return {
      ok: true,
      data: { ok: true, id: row.id, name: row.name, source: "agent" },
    };
  } catch (e) {
    const msg = (e as Error).message;
    if (/unique|duplicate/i.test(msg)) {
      return {
        ok: false,
        error: `a skill named "${input.name}" already exists — use skill_update to refine it`,
      };
    }
    return { ok: false, error: msg };
  }
}

async function skillUpdate(
  userId: string,
  input: {
    name: string;
    body?: string;
    description?: string;
    tags?: string[];
    license?: string;
    compatibility?: string;
    files?: Record<string, string>;
    metadata?: Record<string, unknown>;
  },
): Promise<ToolResult> {
  if (!input.name.trim()) {
    return { ok: false, error: "missing 'name' argument" };
  }
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.body !== undefined) patch.body = input.body;
  if (input.description !== undefined)
    patch.description = input.description.trim() || null;
  if (input.tags !== undefined) patch.tags = input.tags;
  if (input.license !== undefined) patch.license = input.license.trim() || null;
  if (input.compatibility !== undefined)
    patch.compatibility = input.compatibility.trim() || null;
  if (input.files !== undefined) patch.files = input.files;
  if (input.metadata !== undefined) patch.metadata = input.metadata;
  if (Object.keys(patch).length === 1) {
    return {
      ok: false,
      error:
        "nothing to update — pass at least one of body / description / tags / license / compatibility / files / metadata",
    };
  }
  const [row] = await db
    .update(agentSkills)
    .set(patch)
    .where(
      and(
        eq(agentSkills.userId, userId),
        sql`lower(${agentSkills.name}) = lower(${input.name})`,
      ),
    )
    .returning({ id: agentSkills.id, name: agentSkills.name });
  if (!row) return { ok: false, error: `skill not found: ${input.name}` };
  return { ok: true, data: { ok: true, id: row.id, name: row.name } };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function asStringMap(v: unknown): Record<string, string> {
  if (!isPlainObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

async function skillDelete(userId: string, name: string): Promise<ToolResult> {
  if (!name.trim()) return { ok: false, error: "missing 'name' argument" };
  const r = await db
    .delete(agentSkills)
    .where(
      and(
        eq(agentSkills.userId, userId),
        sql`lower(${agentSkills.name}) = lower(${name})`,
      ),
    )
    .returning({ id: agentSkills.id });
  if (r.length === 0) return { ok: false, error: `skill not found: ${name}` };
  return { ok: true, data: { ok: true, deleted: name } };
}

// ── Tool intent routing ───────────────────────────────────────────────────
//
// Pattern-based classifier that detects which tools are needed for a given
// user message WITHOUT requiring agent-mode to be manually enabled and
// WITHOUT injecting ALL tools at once.
//
// Design:
//   - Runs in <1ms (pure regex, no LLM call)
//   - Returns the subset of NATIVE_TOOLS + FS_TOOLS definitions to inject
//   - Returns null when no tool is clearly needed (normal chat path)
//   - Covers 90% of common cases; edge cases fall through to normal routing
//
// Called from chat.ts before building the system prompt.

// Map tool name → its definition (for lazy injection)
const TOOL_BY_NAME = new Map<string, unknown>(
  [...FS_TOOLS, ...NATIVE_TOOLS].map((t) => [
    (t as { function: { name: string } }).function.name,
    t,
  ]),
);

/**
 * Map tool names → their OpenAI tool definitions. Used by the semantic
 * router path (detectToolIntent returns names; chat.ts needs the defs).
 * Unknown names are dropped. web_read also pulls in web_read_full so the
 * model can choose full-page fetch when the paginated read isn't enough.
 */
export function getToolDefs(names: string[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    for (const n of name === "web_read" ? ["web_read", "web_read_full"] : [name]) {
      if (seen.has(n)) continue;
      const def = TOOL_BY_NAME.get(n);
      if (def) { out.push(def); seen.add(n); }
    }
  }
  return out;
}

/**
 * Detect which tools are needed for a user message via pattern matching.
 * Returns an array of tool definitions to inject, or null if no tool needed.
 */
export function selectToolsForIntent(message: string): unknown[] | null {
  if (!message.trim()) return null;
  const m = message.toLowerCase();
  const needed = new Set<string>();

  // ── Filesystem ───────────────────────────────────────────────────────
  if (/\bread\b|\bcat\b|\bshow.*content|\bopen.*file|\bprint.*file/.test(m)
    && /\bfile|\bpath|\b\.ts\b|\b\.js\b|\b\.py\b|\b\.md\b|\b\.json\b|\b\.txt\b/.test(m)) {
    needed.add("fs_read");
  }
  if (/\bwrite\b|\bcreate.*file|\bsave.*file|\bnew.*file/.test(m)
    && /\bfile|\bpath/.test(m)) {
    needed.add("fs_write");
  }
  if (/\blist.*file|\bls\b|\bdir\b|\bwhat.*file|\bfiles.*in/.test(m)) {
    needed.add("fs_list");
  }
  if (/\bedit.*file|\bmodify.*file|\bupdate.*file|\breplace.*in.*file/.test(m)) {
    needed.add("fs_edit");
  }

  // ── Web search ───────────────────────────────────────────────────────
  if (
    /\bsearch\b|\blook.*up\b|\bfind.*online|\bgoogle|\bweb.*search/.test(m) ||
    /\b(latest|current|recent|news|today|update).*(version|release|price|weather|stock|score)/.test(m) ||
    /\bwhat.*(is|are|was|were).*\b(today|current|latest|now)\b/.test(m)
  ) {
    needed.add("web_search");
  }

  // ── Web read ─────────────────────────────────────────────────────────
  if (/https?:\/\/\S+/.test(message)) {
    // URL in message → read it
    needed.add(/\bfull\b|\bentire\b|\bwhole\b/.test(m) ? "web_read_full" : "web_read");
  } else if (/\bfetch\b|\bscrap|\bread.*page|\bopen.*url|\bvisit.*site/.test(m)) {
    needed.add("web_read");
  }

  // ── Bash ─────────────────────────────────────────────────────────────
  if (
    /\brun\b|\bexecute|\bcommand|\bshell|\bbash/.test(m) ||
    /\bgit\b|\bnpm\b|\byarn\b|\bpip\b|\bmake\b|\bdocker\b/.test(m) ||
    /\bgrep\b|\bfind\b|\bawk\b|\bsed\b|\bcurl\b|\bwget\b/.test(m) ||
    /\bls -|\bcat |\becho |\bmkdir\b|\bchmod\b|\bcp |\bmv /.test(m)
  ) {
    needed.add("bash");
  }

  if (needed.size === 0) return null;

  // Return the tool definitions for the detected tools
  return Array.from(needed)
    .map((name) => TOOL_BY_NAME.get(name))
    .filter(Boolean);
}
