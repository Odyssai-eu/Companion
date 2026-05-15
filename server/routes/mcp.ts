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

// SSE consumer for the internal chat completion call. Parses the OAI
// stream that /api/chat/completions emits, accumulates content +
// reasoning, returns the final blob.
interface ChatStreamResult {
  content: string;
  reasoning: string;
  finishReason: string | null;
}

async function runChatCompletion(opts: {
  authHeader: string;
  origin: string;
  conversationId: string;
  userMessage: string;
  model: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  thinking?: boolean;
  reasoning_effort?: string;
  system_prompt?: string;
}): Promise<ChatStreamResult> {
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
    thinking: opts.thinking,
    reasoning_effort: opts.reasoning_effort,
    system_prompt: opts.system_prompt,
  };
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: opts.authHeader,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) {
    const txt = await r.text().catch(() => "");
    throw new Error(`chat completion failed: ${r.status} ${txt}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      const payload = dataLines.join("\n");
      if (payload === "[DONE]") return { content, reasoning, finishReason };
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string;
            reasoning?: string;
            reasoning_content?: string;
          };
          finish_reason?: string | null;
        }>;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) content += delta.content;
      const r = delta?.reasoning ?? delta?.reasoning_content;
      if (r) reasoning += r;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  }
  return { content, reasoning, finishReason };
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
    version: "0.2.0",
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
        "Submit a user message and wait for the full assistant response (consumes the SSE stream internally). Both messages are persisted in Companion. Fetch the conversation afterwards to get message ids.",
      inputSchema: {
        conversationId: z.string().uuid(),
        content: z.string().min(1),
        model: z.string().min(1),
        temperature: z.number().optional(),
        max_tokens: z.number().int().optional(),
        top_p: z.number().optional(),
        thinking: z.boolean().optional(),
        reasoning_effort: z.string().optional(),
        system_prompt: z.string().optional(),
      },
    },
    async (args) => {
      const result = await runChatCompletion({
        authHeader: opts.authHeader,
        origin: opts.origin,
        conversationId: args.conversationId,
        userMessage: args.content,
        model: args.model,
        temperature: args.temperature,
        max_tokens: args.max_tokens,
        top_p: args.top_p,
        thinking: args.thinking,
        reasoning_effort: args.reasoning_effort,
        system_prompt: args.system_prompt,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
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
  const authHeader = c.req.header("authorization");
  if (!authHeader) {
    // Should be impossible: hermesBearerLoader sets userId iff auth is
    // present and valid. Guard anyway.
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
