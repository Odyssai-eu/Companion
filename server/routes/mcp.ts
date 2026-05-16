/**
 * MCP endpoint — exposes Companion (projects, conversations, chat,
 * exports) as a Streamable HTTP MCP server at `/api/mcp`. Consumers are
 * any MCP-capable client: Claude Cowork dispatch, Hermes Agent, Claude
 * Desktop, Continue.dev, etc.
 *
 * Why HTTP transport vs stdio binary: the user only needs an URL + a
 * bearer token. No local install, no env var forwarding, no separate
 * deployment. Settings → External agents → Generate token, copy, done.
 *
 * Stateless: each request authenticates via `Authorization: Bearer hms_…`
 * (resolved by `hermesBearerLoader` middleware before this route runs).
 * No session IDs, no in-memory state — multiple tenants share one route.
 *
 * Tools:
 *   - companion_list_projects
 *   - companion_get_project
 *   - companion_list_conversations
 *   - companion_create_conversation
 *   - companion_get_conversation
 *   - companion_send_message      (consumes own /api/chat/completions SSE)
 *   - companion_delete_messages_from
 *   - companion_export_md
 *   - companion_list_models
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { and, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { conversations, messages, projects } from "../db/schema";

type Env = { Variables: { userId: string } };
const mcpRoute = new Hono<Env>();

// ── Internal helpers (DB-direct for everything except send_message) ───
// We avoid the network round-trip and call Drizzle directly. send_message
// still goes through /api/chat/completions to reuse the streaming + tool
// loop + memory + time-tag pipeline.

async function listUserProjects(userId: string) {
  return db
    .select()
    .from(projects)
    .where(eq(projects.userId, userId))
    .orderBy(desc(projects.updatedAt));
}

async function getUserProject(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, userId)))
    .limit(1);
  return row ?? null;
}

async function listUserConversations(userId: string, projectId?: string) {
  if (projectId) {
    return db
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.projectId, projectId),
        ),
      )
      .orderBy(desc(conversations.updatedAt));
  }
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt));
}

async function getUserConversation(userId: string, id: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, userId)))
    .limit(1);
  if (!conv) return null;
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);
  return { conversation: conv, messages: msgs };
}

async function createUserConversation(
  userId: string,
  data: {
    title?: string;
    projectId?: string;
    model?: string;
    kind?: "chat" | "talk" | "hermes";
    repoPath?: string;
  },
) {
  const kind = data.kind ?? "chat";
  const defaultTitle =
    kind === "talk"
      ? "New talk"
      : kind === "hermes"
        ? "New Hermes"
        : "New conversation";
  const [row] = await db
    .insert(conversations)
    .values({
      userId,
      title: data.title ?? defaultTitle,
      projectId: data.projectId ?? null,
      model: data.model,
      kind,
      repoPath: data.repoPath ?? null,
    })
    .returning();
  return row;
}

async function deleteMessagesFrom(
  userId: string,
  convId: string,
  messageId: string,
) {
  const [conv] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  if (!conv || conv.userId !== userId) {
    return { ok: false, error: "not_found" as const };
  }
  const [pivot] = await db
    .select({ createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!pivot) return { ok: false, error: "message_not_found" as const };
  await db
    .delete(messages)
    .where(
      and(
        eq(messages.conversationId, convId),
        gte(messages.createdAt, pivot.createdAt),
      ),
    );
  return { ok: true as const };
}

/**
 * Fire a chat completion against Companion's own /api/chat/completions
 * and **detach** — we don't consume the SSE body, we just confirm the
 * server accepted the request, then return.
 *
 * Why non-blocking: MCP clients (Claude Cowork, Hermes, Continue.dev)
 * impose a per-tool-call timeout (~45s in Cowork). Long generations
 * (HY3 reasoner on argo: 78-120s on rich contexts) blow past that, the
 * client errors out and discards the tool result. But Companion's chat
 * route keeps generating server-side and persists the result — it just
 * becomes unreachable from the original tool call.
 *
 * Standard async pattern: send → poll → fetch. The MCP tool surface:
 *   companion_send_message            → fires + returns immediately
 *   companion_get_inference_status    → polls server-side buffer
 *   companion_get_conversation        → reads persisted messages once done
 *
 * Implementation: we await the response headers (so we know the server
 * accepted the body and started its worker), then cancel our reader.
 * Companion's chat route writes to a TransformStream wrapped in
 * `writer.write(...).catch(() => undefined)` — so our client-side
 * disconnect is invisible to the server worker, which keeps running,
 * persists the assistant message, and refreshes memory.
 */
async function startChatCompletion(opts: {
  authHeader: string;
  origin: string;
  conversationId: string;
  userMessage: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repetition_penalty?: number;
  seed?: number;
  stop?: string | string[];
  thinking?: boolean;
  reasoning_effort?: string;
  system_prompt?: string;
}): Promise<{ ok: true; startedAt: string } | { ok: false; error: string }> {
  const url = `${opts.origin}/api/chat/completions`;
  const body = {
    conversationId: opts.conversationId,
    messages: [
      {
        role: "user" as const,
        content: opts.userMessage,
        createdAt: new Date().toISOString(),
      },
    ],
    model: opts.model,
    temperature: opts.temperature,
    max_tokens: opts.max_tokens,
    top_p: opts.top_p,
    top_k: opts.top_k,
    min_p: opts.min_p,
    repetition_penalty: opts.repetition_penalty,
    seed: opts.seed,
    stop: opts.stop,
    thinking: opts.thinking,
    reasoning_effort: opts.reasoning_effort,
    system_prompt: opts.system_prompt,
  };
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: opts.authHeader,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `network error: ${(e as Error).message}` };
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return { ok: false, error: `${r.status} ${r.statusText}: ${txt}` };
  }
  // Headers received: the server accepted the request, opened the SSE
  // pipe, and the inference-state buffer for this conversation has been
  // started (startInference() is called before the first byte hits the
  // wire). Cancel our reader so we don't hold the connection.
  try {
    await r.body?.cancel();
  } catch {
    // ignore — best effort detach
  }
  return { ok: true, startedAt: new Date().toISOString() };
}

// ── MCP server factory (per-request, stateless) ────────────────────────
// We instantiate a fresh McpServer per HTTP request, closing tool
// handlers over the resolved userId + auth header. That keeps the route
// stateless and avoids cross-tenant leaks: there's no shared mutable
// state between requests.

function buildServer(opts: {
  userId: string;
  authHeader: string;
  origin: string;
}): McpServer {
  const server = new McpServer({
    name: "companion-mcp",
    version: "0.3.0",
  });

  server.registerTool(
    "companion_list_projects",
    {
      description: "List the authenticated user's projects, most recent first.",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await listUserProjects(opts.userId), null, 2),
        },
      ],
    }),
  );

  server.registerTool(
    "companion_get_project",
    {
      description: "Get a project by id (system prompt, metadata).",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const row = await getUserProject(opts.userId, id);
      if (!row) {
        return {
          isError: true,
          content: [{ type: "text", text: "Project not found." }],
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    },
  );

  server.registerTool(
    "companion_list_conversations",
    {
      description:
        "List conversations, most recent first. Optional `projectId` filter.",
      inputSchema: {
        projectId: z.string().uuid().optional(),
      },
    },
    async ({ projectId }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await listUserConversations(opts.userId, projectId),
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerTool(
    "companion_create_conversation",
    {
      description:
        "Create a new conversation. `kind` defaults to 'chat'. Pass `projectId` to anchor inside a project.",
      inputSchema: {
        title: z.string().min(1).max(200).optional(),
        projectId: z.string().uuid().optional(),
        model: z.string().max(200).optional(),
        kind: z.enum(["chat", "talk", "hermes"]).optional(),
        repoPath: z.string().min(1).max(500).optional(),
      },
    },
    async (data) => {
      const row = await createUserConversation(opts.userId, data);
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    },
  );

  server.registerTool(
    "companion_get_conversation",
    {
      description:
        "Fetch a conversation including all messages (chronological). Use after send_message to read the assistant's reply and its id.",
      inputSchema: { id: z.string().uuid() },
    },
    async ({ id }) => {
      const data = await getUserConversation(opts.userId, id);
      if (!data) {
        return {
          isError: true,
          content: [{ type: "text", text: "Conversation not found." }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  server.registerTool(
    "companion_send_message",
    {
      description:
        "Submit a user message to a conversation. NON-BLOCKING: returns immediately with `{ status: 'started' }` as soon as the server accepts the request. Companion keeps generating server-side and persists the assistant message when done. To get the response: poll `companion_get_inference_status(conversationId)` until `done:true`, then call `companion_get_conversation(id)` to read the persisted assistant message and its id. `max_tokens` defaults to 32768 — Odysseus / EXO default to 512 when unset, which truncates almost every response. Tuning knobs useful for prose / long-form: `repetition_penalty` ~1.1-1.15 breaks syntactic recycling; `seed` makes a regenerate reproducible; `stop` halts on a marker (e.g. `['***','---']`) instead of letting the model decide.",
      inputSchema: {
        conversationId: z.string().uuid(),
        content: z.string().min(1),
        model: z.string().min(1),
        temperature: z.number().optional(),
        max_tokens: z.number().int().optional(),
        top_p: z.number().optional(),
        top_k: z.number().int().optional(),
        min_p: z.number().optional(),
        repetition_penalty: z.number().optional(),
        seed: z.number().int().optional(),
        stop: z.union([z.string(), z.array(z.string())]).optional(),
        thinking: z.boolean().optional(),
        reasoning_effort: z.string().optional(),
        system_prompt: z.string().optional(),
      },
    },
    async (args) => {
      const result = await startChatCompletion({
        authHeader: opts.authHeader,
        origin: opts.origin,
        conversationId: args.conversationId,
        userMessage: args.content,
        model: args.model,
        temperature: args.temperature,
        // Default to 32k. Odysseus' OpenAI-compat layer defaults to 512
        // when unset (cf. MLX Distributed scripts/api.py), which cuts
        // virtually every useful response short. The chat route still
        // clamps for Anthropic (64k) / OpenAI (16k) hosted models, so
        // 32k is safe across the board.
        max_tokens: args.max_tokens ?? 32_768,
        top_p: args.top_p,
        top_k: args.top_k,
        min_p: args.min_p,
        repetition_penalty: args.repetition_penalty,
        seed: args.seed,
        stop: args.stop,
        thinking: args.thinking,
        reasoning_effort: args.reasoning_effort,
        system_prompt: args.system_prompt,
      });
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: result.error }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "started",
                conversationId: args.conversationId,
                startedAt: result.startedAt,
                hint: "Poll companion_get_inference_status until done:true, then companion_get_conversation to read the assistant message.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "companion_get_inference_status",
    {
      description:
        "Check the live inference buffer for a conversation. Returns `{ active, done, content, reasoning, error }`. `active:false` means no inference is running (either never started, or the buffer was already cleared). `done:true` means generation finished — the message is persisted; call `companion_get_conversation` to fetch it with its id. While `done:false` and `active:true`, `content` and `reasoning` are partial accumulations.",
      inputSchema: {
        conversationId: z.string().uuid(),
      },
    },
    async ({ conversationId }) => {
      const r = await fetch(
        `${opts.origin}/api/conversations/${conversationId}/inference`,
        { headers: { Authorization: opts.authHeader } },
      );
      const txt = await r.text();
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `${r.status}: ${txt}` }],
        };
      }
      return { content: [{ type: "text", text: txt }] };
    },
  );

  server.registerTool(
    "companion_delete_messages_from",
    {
      description:
        "Delete every message at or after `messageId` in the given conversation. Use to roll back a bad assistant turn before re-sending.",
      inputSchema: {
        conversationId: z.string().uuid(),
        messageId: z.string().uuid(),
      },
    },
    async ({ conversationId, messageId }) => {
      const r = await deleteMessagesFrom(opts.userId, conversationId, messageId);
      if (!r.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: r.error }],
        };
      }
      return { content: [{ type: "text", text: '{"ok":true}' }] };
    },
  );

  server.registerTool(
    "companion_export_md",
    {
      description:
        "Export a conversation as markdown (the same format the Companion UI's export button produces).",
      inputSchema: { conversationId: z.string().uuid() },
    },
    async ({ conversationId }) => {
      const r = await fetch(
        `${opts.origin}/api/conversations/${conversationId}/export.md`,
        { headers: { Authorization: opts.authHeader } },
      );
      if (!r.ok) {
        return {
          isError: true,
          content: [
            { type: "text", text: `export failed: ${r.status} ${await r.text()}` },
          ],
        };
      }
      return { content: [{ type: "text", text: await r.text() }] };
    },
  );

  server.registerTool(
    "companion_list_models",
    {
      description:
        "List the models available to the authenticated user (via LiteLLM / Odysseus).",
      inputSchema: {},
    },
    async () => {
      const r = await fetch(`${opts.origin}/api/models`, {
        headers: { Authorization: opts.authHeader },
      });
      const txt = await r.text();
      return { content: [{ type: "text", text: txt }] };
    },
  );

  return server;
}

// ── HTTP entry point (POST/GET/DELETE) ─────────────────────────────────

mcpRoute.all("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  // Internal sub-fetches (chat/completions, export.md, models) need a
  // Bearer header. The incoming request may carry one — but it may also
  // have authenticated via `?token=hms_…` query param (for MCP clients
  // that don't expose a custom-headers field, e.g. Claude Desktop). In
  // that case we reconstruct the header from the query.
  let authHeader = c.req.header("authorization");
  if (!authHeader) {
    const t = c.req.query("token");
    if (t) authHeader = `Bearer ${t}`;
  }
  if (!authHeader) {
    return c.json({ error: "missing_auth" }, 401);
  }
  const origin = new URL(c.req.url).origin;

  const server = buildServer({ userId, authHeader, origin });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c.req.raw);
});

export default mcpRoute;
