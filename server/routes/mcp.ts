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
 *   - companion_set_conversation_memory
 *   - companion_send_message      (consumes own /api/chat/completions SSE)
 *   - companion_delete_messages_from
 *   - companion_export_md
 *   - companion_list_models
 *   - companion_search_memory     (RAG over the Obsidian wiki, optional
 *                                  project_memory_files scan when scoped)
 *   - companion_remember          (write a fact into project_memory_files)
 *   - companion_list_skills       (markdown skills the agent can load)
 *   - companion_get_skill         (fetch a skill body by name)
 *   - companion_create_skill      (persist a new skill, fails on dup)
 *   - companion_update_skill      (edit an existing skill)
 *   - companion_delete_skill      (remove a skill)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { and, asc, desc, eq, gte, ilike } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import {
  agentSkills,
  conversations,
  messages,
  projectMemoryFiles,
  projects,
} from "../db/schema";
import { ragRetrieve } from "../lib/memory";

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

/**
 * Create a conversation by delegating to `POST /api/conversations`.
 * Re-implementing the insert in-process would skip the project-memory
 * inheritance (memoryEnabled snapshot, memory wiki snapshot, project
 * memory toggles), so we proxy to the same route the UI uses. The
 * `memoryEnabled` override is applied as a PATCH right after creation
 * when the caller passed it explicitly — the create route doesn't
 * accept it (it always inherits from the project).
 */
async function createUserConversation(
  authHeader: string,
  origin: string,
  data: {
    title?: string;
    projectId?: string;
    model?: string;
    kind?: "chat" | "talk" | "hermes";
    repoPath?: string;
    memoryEnabled?: boolean;
  },
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};
  if (data.title !== undefined) payload.title = data.title;
  if (data.projectId !== undefined) payload.projectId = data.projectId;
  if (data.model !== undefined) payload.model = data.model;
  if (data.kind !== undefined) payload.kind = data.kind;
  if (data.repoPath !== undefined) payload.repoPath = data.repoPath;

  const r = await fetch(`${origin}/api/conversations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    throw new Error(
      `create conversation failed: ${r.status} ${await r.text().catch(() => "")}`,
    );
  }
  const { conversation } = (await r.json()) as {
    conversation: Record<string, unknown>;
  };

  // Apply explicit memoryEnabled override via PATCH. Cowork's main use
  // case for an override is the OFF direction — projects with memory off
  // currently leak ON into MCP-created conversations otherwise.
  if (
    typeof data.memoryEnabled === "boolean" &&
    conversation.memoryEnabled !== data.memoryEnabled
  ) {
    const p = await fetch(
      `${origin}/api/conversations/${conversation.id}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify({ memoryEnabled: data.memoryEnabled }),
      },
    );
    if (p.ok) {
      const { conversation: patched } = (await p.json()) as {
        conversation: Record<string, unknown>;
      };
      return patched;
    }
  }
  return conversation;
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
        "Create a new conversation. `kind` defaults to 'chat'. Pass `projectId` to anchor inside a project — the project's `memoryEnabled` toggle is inherited (e.g. a memory-off project gives you a memory-off conversation). Pass `memoryEnabled` explicitly to override that inheritance.",
      inputSchema: {
        title: z.string().min(1).max(200).optional(),
        projectId: z.string().uuid().optional(),
        model: z.string().max(200).optional(),
        kind: z.enum(["chat", "talk", "hermes"]).optional(),
        repoPath: z.string().min(1).max(500).optional(),
        memoryEnabled: z.boolean().optional(),
      },
    },
    async (data) => {
      const row = await createUserConversation(opts.authHeader, opts.origin, data);
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
    "companion_set_conversation_memory",
    {
      description:
        "Toggle the memory wiki injection for a conversation. When `enabled` is false, the user's global memory wiki (and the project's dedicated corpus, if any) are NOT injected into subsequent turns — useful before sensitive or off-topic prompts.",
      inputSchema: {
        conversationId: z.string().uuid(),
        enabled: z.boolean(),
      },
    },
    async ({ conversationId, enabled }) => {
      const r = await fetch(
        `${opts.origin}/api/conversations/${conversationId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: opts.authHeader,
          },
          body: JSON.stringify({ memoryEnabled: enabled }),
        },
      );
      if (!r.ok) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `update failed: ${r.status} ${await r.text()}`,
            },
          ],
        };
      }
      return { content: [{ type: "text", text: await r.text() }] };
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

  // ── Brain tools (memory + skills) ────────────────────────────────────
  // Companion as a knowledge backend for external coding agents
  // (Continue.dev, Cline, Claude Desktop, Aider). The agent in VS Code
  // can call these to fetch user memory before answering and write back
  // learnings without leaving its editor flow.

  server.registerTool(
    "companion_search_memory",
    {
      description:
        "Semantic search over the user's Obsidian wiki (RAG via bge-m3 + Qdrant). When `projectId` is given, also greps the project's DB-backed memory files. Returns up to `limit` top hits (default 5, max 10).",
      inputSchema: {
        query: z.string().min(1),
        projectId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(10).optional(),
      },
    },
    async (args) => {
      const limit = args.limit ?? 5;
      const ragHits = await ragRetrieve(args.query, limit);
      const sections: string[] = [];

      if (ragHits.length > 0) {
        sections.push(
          "# Wiki hits (semantic, top " + ragHits.length + ")\n\n" +
            ragHits
              .map(
                (h, i) =>
                  `## [${i + 1}] ${h.title}\n_(source: ${h.path}, score ${h.score.toFixed(3)})_\n\n${h.snippet}`,
              )
              .join("\n\n---\n\n"),
        );
      }

      // Project-scoped substring grep — RAG only indexes the global
      // Obsidian wiki, not project_memory_files. When the caller asks
      // for a project-scoped search, fall back to a simple substring
      // match over the project's stored content. Cheap; cardinality is
      // typically < 100 files per project.
      if (args.projectId) {
        const q = args.query.toLowerCase();
        // Ownership check via the project row's user_id.
        const [proj] = await db
          .select({ userId: projects.userId })
          .from(projects)
          .where(eq(projects.id, args.projectId))
          .limit(1);
        if (proj && proj.userId === opts.userId) {
          const files = await db
            .select({
              path: projectMemoryFiles.path,
              content: projectMemoryFiles.content,
            })
            .from(projectMemoryFiles)
            .where(eq(projectMemoryFiles.projectId, args.projectId));
          const matches: Array<{ path: string; snippet: string }> = [];
          for (const f of files) {
            const lc = f.content.toLowerCase();
            const idx = lc.indexOf(q);
            if (idx < 0) continue;
            const start = Math.max(0, idx - 120);
            const end = Math.min(f.content.length, idx + 280);
            matches.push({
              path: f.path,
              snippet:
                (start > 0 ? "…" : "") +
                f.content.slice(start, end) +
                (end < f.content.length ? "…" : ""),
            });
            if (matches.length >= limit) break;
          }
          if (matches.length > 0) {
            sections.push(
              `# Project memory hits (substring, ${matches.length})\n\n` +
                matches
                  .map((m) => `## ${m.path}\n\n${m.snippet}`)
                  .join("\n\n---\n\n"),
            );
          }
        }
      }

      const text =
        sections.length > 0
          ? sections.join("\n\n===\n\n")
          : "_No hits for query: " + JSON.stringify(args.query) + "_";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "companion_remember",
    {
      description:
        "Persist a fact / learning into the user's project memory. Writes to a deterministic path under `agent-notes/` so subsequent calls accumulate without clobbering. `projectId` is currently required — global wiki writes (back to Obsidian) aren't supported yet.",
      inputSchema: {
        projectId: z.string().uuid(),
        title: z.string().min(1).max(120),
        body: z.string().min(1).max(20_000),
        tags: z.array(z.string().max(40)).max(10).optional(),
      },
    },
    async (args) => {
      // Ownership check.
      const [proj] = await db
        .select({ userId: projects.userId })
        .from(projects)
        .where(eq(projects.id, args.projectId))
        .limit(1);
      if (!proj || proj.userId !== opts.userId) {
        return {
          isError: true,
          content: [
            { type: "text", text: "project_not_found_or_not_owned" },
          ],
        };
      }
      const slug = args.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "note";
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const path = `agent-notes/${today}-${slug}.md`;
      const tagsLine =
        args.tags && args.tags.length > 0
          ? `\ntags: ${args.tags.join(", ")}\n`
          : "";
      const content =
        `# ${args.title}\n` +
        `created: ${new Date().toISOString()}\n` +
        tagsLine +
        `\n${args.body}\n`;
      // Manual upsert by (projectId, path). The table has no unique
      // constraint on that pair (cf. schema), so onConflictDoUpdate
      // can't help — do a SELECT then UPDATE/INSERT branch. The table has no unique
      // constraint on that pair (cf. schema), so onConflictDoUpdate
      // can't help — do a SELECT then UPDATE/INSERT branch.
      const sizeBytes = Buffer.byteLength(content, "utf8");
      const [existing] = await db
        .select({ id: projectMemoryFiles.id })
        .from(projectMemoryFiles)
        .where(
          and(
            eq(projectMemoryFiles.projectId, args.projectId),
            eq(projectMemoryFiles.path, path),
          ),
        )
        .limit(1);
      if (existing) {
        await db
          .update(projectMemoryFiles)
          .set({ content, sizeBytes, updatedAt: new Date() })
          .where(eq(projectMemoryFiles.id, existing.id));
      } else {
        await db.insert(projectMemoryFiles).values({
          projectId: args.projectId,
          path,
          mimeType: "text/markdown",
          sizeBytes,
          content,
        });
      }
      return {
        content: [
          {
            type: "text",
            text: `Saved to ${path} (${Buffer.byteLength(content, "utf8")} bytes)`,
          },
        ],
      };
    },
  );

  server.registerTool(
    "companion_list_skills",
    {
      description:
        "List the user's agent skills (markdown instruction packages the chat model can load on demand). Returns name, description, tags, source, and a short preview of the body. Use companion_get_skill to fetch the full body, companion_create_skill to persist a new one.",
      inputSchema: {},
    },
    async () => {
      const rows = await db
        .select({
          id: agentSkills.id,
          name: agentSkills.name,
          description: agentSkills.description,
          tags: agentSkills.tags,
          source: agentSkills.source,
          body: agentSkills.body,
          files: agentSkills.files,
        })
        .from(agentSkills)
        .where(eq(agentSkills.userId, opts.userId))
        .orderBy(asc(agentSkills.name));
      const summary = rows.map((r) => ({
        name: r.name,
        description: r.description,
        tags: r.tags,
        source: r.source,
        preview: r.body.slice(0, 200) + (r.body.length > 200 ? "…" : ""),
        bodyLength: r.body.length,
        fileCount: Object.keys(r.files ?? {}).length,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  );

  server.registerTool(
    "companion_get_skill",
    {
      description:
        "Fetch the full body of an agent skill by name (case-insensitive). Treat the body as instructions to apply for the current task — do not replace your own system prompt with it.",
      inputSchema: {
        name: z.string().min(1).max(120),
      },
    },
    async (args) => {
      const [row] = await db
        .select()
        .from(agentSkills)
        .where(
          and(
            eq(agentSkills.userId, opts.userId),
            ilike(agentSkills.name, args.name),
          ),
        )
        .limit(1);
      if (!row) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Skill not found: ${args.name}` },
          ],
        };
      }
      const out = {
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
      };
      return {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      };
    },
  );

  server.registerTool(
    "companion_create_skill",
    {
      description:
        "Persist a new agent skill (agentskills.io format). Name must be lowercase a-z/0-9/hyphen, 1-64 chars. Fails on name collision — use companion_update_skill in that case. Set source='imported' when bulk-loading from an external library (e.g. Anthropic's published skills); otherwise the row is tagged 'agent'. Supporting files (scripts/, references/, assets/) live in `files` as a map of relative path → contents.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
        body: z.string().min(1).max(200_000),
        description: z.string().max(1024).optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        source: z.enum(["agent", "user", "imported"]).optional(),
        license: z.string().max(200).optional(),
        compatibility: z.string().max(500).optional(),
        files: z.record(z.string(), z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      try {
        const [row] = await db
          .insert(agentSkills)
          .values({
            userId: opts.userId,
            name: args.name,
            body: args.body,
            description: args.description ?? null,
            tags: args.tags ?? [],
            source: args.source ?? "agent",
            license: args.license ?? null,
            compatibility: args.compatibility ?? null,
            files: args.files ?? {},
            metadata: args.metadata ?? {},
          })
          .returning({ id: agentSkills.id, name: agentSkills.name });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ok: true, id: row.id, name: row.name }),
            },
          ],
        };
      } catch (e) {
        const msg = (e as Error).message;
        const collision = /unique|duplicate/i.test(msg);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: collision
                ? `A skill named "${args.name}" already exists. Use companion_update_skill to refine it.`
                : msg,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "companion_update_skill",
    {
      description:
        "Edit an existing agent skill by name. Pass only the fields to change. Use this when refining a skill, fixing a typo, or adding supporting files.",
      inputSchema: {
        name: z.string().min(1).max(64),
        body: z.string().min(1).max(200_000).optional(),
        description: z.string().max(1024).nullable().optional(),
        tags: z.array(z.string().max(40)).max(20).optional(),
        license: z.string().max(200).nullable().optional(),
        compatibility: z.string().max(500).nullable().optional(),
        files: z.record(z.string(), z.string()).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) => {
      const patch: Record<string, unknown> = { updatedAt: new Date() };
      if (args.body !== undefined) patch.body = args.body;
      if (args.description !== undefined)
        patch.description = args.description;
      if (args.tags !== undefined) patch.tags = args.tags;
      if (args.license !== undefined) patch.license = args.license;
      if (args.compatibility !== undefined)
        patch.compatibility = args.compatibility;
      if (args.files !== undefined) patch.files = args.files;
      if (args.metadata !== undefined) patch.metadata = args.metadata;
      if (Object.keys(patch).length === 1) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Nothing to update — pass at least one of body / description / tags / license / compatibility / files / metadata.",
            },
          ],
        };
      }
      const [row] = await db
        .update(agentSkills)
        .set(patch)
        .where(
          and(
            eq(agentSkills.userId, opts.userId),
            ilike(agentSkills.name, args.name),
          ),
        )
        .returning({ id: agentSkills.id, name: agentSkills.name });
      if (!row) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Skill not found: ${args.name}` },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, id: row.id, name: row.name }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "companion_delete_skill",
    {
      description:
        "Delete an agent skill by name (case-insensitive). Hard delete, no undo.",
      inputSchema: {
        name: z.string().min(1).max(120),
      },
    },
    async (args) => {
      const r = await db
        .delete(agentSkills)
        .where(
          and(
            eq(agentSkills.userId, opts.userId),
            ilike(agentSkills.name, args.name),
          ),
        )
        .returning({ id: agentSkills.id });
      if (r.length === 0) {
        return {
          isError: true,
          content: [
            { type: "text", text: `Skill not found: ${args.name}` },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, deleted: args.name }),
          },
        ],
      };
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
