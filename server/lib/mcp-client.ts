/**
 * MCP client wrapper — Companion as a consumer of remote MCP servers.
 *
 * The companion of `routes/mcp.ts` (which exposes Companion AS a server):
 * this module talks TO third-party MCP servers (Notion, Qdrant, Linear,
 * GitHub, …) so their tools can be merged into the toolset the LLM sees
 * at chat time.
 *
 * Transports supported: Streamable HTTP (modern) and SSE (legacy). stdio
 * is deliberately out — spawning child processes inside the Docker
 * container is more trouble than it's worth, and every hosted MCP server
 * exposes an HTTP variant.
 *
 * Connection model: stateless. Each operation opens a fresh client,
 * runs the call, closes. HTTP keep-alive at the fetch layer keeps this
 * cheap. Avoids the bug surface of long-lived connections (server
 * restarts, token rotation, idle eviction).
 *
 * Cache: `mcp_servers.tools_cache` stores the last `tools/list` snapshot
 * with a 5-min TTL. `toolsForUser()` in the chat path reads from cache
 * to avoid a round-trip per turn; explicit POST /refresh re-fetches.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpServerRow } from "../db/schema";

export type McpToolSpec = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

const CONNECT_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 60_000;

/**
 * Open a fresh MCP client for the given server row. Caller MUST close
 * it via `client.close()` in a finally block — the SDK doesn't time
 * out idle connections.
 */
async function openClient(server: McpServerRow): Promise<Client> {
  const client = new Client(
    { name: "companion", version: "1.0" },
    { capabilities: {} },
  );

  const headers: Record<string, string> = {};
  if (server.authHeader) {
    // Accept two convenience shapes:
    //   "Bearer sk_…"            → use as-is for Authorization
    //   "X-API-Key: abc123"      → split on first ":"
    //   any other plain string   → use as Authorization value
    const m = server.authHeader.match(/^([\w-]+):\s*(.+)$/);
    if (m) {
      headers[m[1]] = m[2];
    } else {
      headers.authorization = server.authHeader;
    }
  }

  let transport;
  if (server.transport === "sse") {
    transport = new SSEClientTransport(new URL(server.url), {
      requestInit: { headers },
      eventSourceInit: {
        // The fetch-based EventSource shim accepts headers via the
        // fetch options. We wrap the global fetch to merge our auth
        // headers into every request the SSE transport makes.
        fetch: (url: RequestInfo | URL, init?: RequestInit) =>
          fetch(url, { ...init, headers: { ...init?.headers, ...headers } }),
      },
    });
  } else {
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers },
    });
  }

  await withTimeout(
    client.connect(transport),
    CONNECT_TIMEOUT_MS,
    "mcp_connect_timeout",
  );
  return client;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Fetch the server's tool list. Used both by chat-path cache refresh
 * and by the /refresh route. The caller is responsible for persisting
 * the result + updating tools_cache_at / last_error.
 */
export async function fetchTools(
  server: McpServerRow,
): Promise<McpToolSpec[]> {
  const client = await openClient(server);
  try {
    const res = await withTimeout(
      client.listTools(),
      CALL_TIMEOUT_MS,
      "mcp_list_tools_timeout",
    );
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown> | undefined,
    }));
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Call a tool. Returns the raw result content (typically a string for
 * text responses, but MCP allows mixed content arrays). We coerce to
 * a single string for the chat-loop tool-result message, since that's
 * what the LLM expects.
 */
export async function callTool(
  server: McpServerRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; content: string; error?: string }> {
  let client: Client;
  try {
    client = await openClient(server);
  } catch (e) {
    return { ok: false, content: "", error: (e as Error).message };
  }
  try {
    const res = await withTimeout(
      client.callTool({ name: toolName, arguments: args }),
      CALL_TIMEOUT_MS,
      "mcp_call_tool_timeout",
    );
    if (res.isError) {
      return {
        ok: false,
        content: contentToString(res.content),
        error: "tool_returned_error",
      };
    }
    return { ok: true, content: contentToString(res.content) };
  } catch (e) {
    return { ok: false, content: "", error: (e as Error).message };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * MCP returns `content` as an array of typed parts ({type: "text", text}
 * | {type: "image", data, mimeType} | …). The chat loop wants a string,
 * so we flatten: text parts joined with double-newline, image parts
 * dropped with a tiny placeholder. Good enough for LLM consumption.
 */
function contentToString(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? "");
  const parts: string[] = [];
  for (const p of content) {
    if (!p || typeof p !== "object") continue;
    const part = p as { type?: string; text?: string };
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "image") {
      parts.push("[image omitted]");
    } else if (part.type === "resource") {
      parts.push("[resource omitted]");
    }
  }
  return parts.join("\n\n");
}

/**
 * Slug-prefixed tool name → { server, original name } resolution.
 * `mcp_<slug>_<tool>` → { slug, tool }. Returns null if the name
 * doesn't match the convention.
 */
export function parseMcpToolName(
  name: string,
): { slug: string; tool: string } | null {
  if (!name.startsWith("mcp_")) return null;
  const rest = name.slice(4);
  // First underscore is the boundary between slug and tool name. Slugs
  // are lowercased ascii without underscores (we enforce on POST), so
  // this split is unambiguous.
  const idx = rest.indexOf("_");
  if (idx <= 0) return null;
  return { slug: rest.slice(0, idx), tool: rest.slice(idx + 1) };
}
