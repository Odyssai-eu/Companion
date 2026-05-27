/**
 * Hermes agent invocation endpoint. Routes the user's `/hermes <prompt>`
 * input through the Hermes Agent gateway (v0.14+).
 *
 *   POST /api/agents/hermes/invoke
 *     body: {conversationId, prompt}
 *     responds: SSE stream — events translated to the legacy
 *               `sessionUpdate: agent_message_chunk | tool_call` shape
 *               the chat client already speaks.
 *
 *   GET  /api/agents/hermes/transcript/:conversationId
 *     → past messages for the agent sub-thread in this conv
 *
 *   POST /api/agents/hermes/reset/:conversationId
 *     → drop the local agent_sessions row, forcing a fresh Hermes
 *       conversation key on the next invoke
 *
 * Transport (since 2026-05-27):
 *   - Hermes v0.14 gateway is OpenAI-compatible. We POST to
 *     `${bridgeUrl}/v1/responses` with `conversation: <agent_session.id>`
 *     so Hermes auto-chains turns server-side. No need for a
 *     POST /sessions step. Auth: `Authorization: Bearer ${bridgeToken}`
 *     where bridgeToken == API_SERVER_KEY in ~/.hermes/.env on the
 *     gateway host.
 *   - Hermes streams OpenAI Responses API SSE events
 *     (response.output_text.delta, response.output_item.added/done,
 *     response.completed/failed). We translate to `agent_message_chunk`
 *     and `tool_call` so the frontend in `useChat.ts` doesn't change.
 *
 * Persistence:
 *   - agent_sessions row exists per (conv, kind='hermes'). Its row id
 *     is also the Hermes conversation key — resetting deletes the row
 *     so a fresh conversation starts on Hermes' side too.
 *   - agent_messages stores the transcript (role: user | agent | tool).
 *   - bridge_session_id column is legacy; left nullable, not used.
 */

import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { agentMessages, agentSessions, conversations } from "../db/schema";
import { loadHermesConfigForUser } from "./addon-hermes";

type Env = { Variables: { userId: string } };
const hermesAgentRoute = new Hono<Env>();

const AGENT_KIND = "hermes";
const HERMES_MODEL = "hermes-agent";

async function ensureSession(
  userId: string,
  conversationId: string,
): Promise<{ id: string }> {
  const [existing] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.conversationId, conversationId),
        eq(agentSessions.agentKind, AGENT_KIND),
      ),
    )
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(agentSessions)
    .values({ userId, conversationId, agentKind: AGENT_KIND })
    .returning({ id: agentSessions.id });
  return created;
}

// ── Transcript ────────────────────────────────────────────────────────────

hermesAgentRoute.get("/transcript/:conversationId", async (c) => {
  const userId = c.get("userId");
  const convId = c.req.param("conversationId");
  const [conv] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  if (!conv || conv.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const [session] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.conversationId, convId),
        eq(agentSessions.agentKind, AGENT_KIND),
      ),
    )
    .limit(1);
  if (!session) return c.json({ sessionId: null, messages: [] });
  const rows = await db
    .select()
    .from(agentMessages)
    .where(eq(agentMessages.sessionId, session.id))
    .orderBy(asc(agentMessages.createdAt));
  return c.json({ sessionId: session.id, messages: rows });
});

// ── Reset ─────────────────────────────────────────────────────────────────

hermesAgentRoute.post("/reset/:conversationId", async (c) => {
  const userId = c.get("userId");
  const convId = c.req.param("conversationId");
  const [conv] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  if (!conv || conv.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  // Deleting the row forces ensureSession() to create a new one with a
  // fresh UUID, which is also a fresh Hermes conversation key.
  await db
    .delete(agentSessions)
    .where(
      and(
        eq(agentSessions.conversationId, convId),
        eq(agentSessions.agentKind, AGENT_KIND),
      ),
    );
  return c.json({ ok: true });
});

// ── Invoke ────────────────────────────────────────────────────────────────

const invokeSchema = z.object({
  conversationId: z.string().uuid(),
  prompt: z.string().min(1).max(50_000),
});

hermesAgentRoute.post("/invoke", zValidator("json", invokeSchema), async (c) => {
  const userId = c.get("userId");
  const { conversationId, prompt } = c.req.valid("json");

  const [conv] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv || conv.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }

  const cfg = await loadHermesConfigForUser(userId);
  if (!cfg) {
    return c.json(
      {
        error: "hermes_not_configured",
        detail:
          "The Hermes Agent add-on is not enabled or no bridge URL is set. " +
          "Open Settings → Add-ons → Hermes Agent to configure it.",
      },
      400,
    );
  }

  const session = await ensureSession(userId, conversationId);
  const baseUrl = cfg.bridgeUrl!.replace(/\/+$/, "");

  // Persist the user message first so a reload mid-stream still shows it.
  await db.insert(agentMessages).values({
    sessionId: session.id,
    role: "user",
    content: prompt,
  });

  const upstream = await fetch(baseUrl + "/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(cfg.bridgeToken
        ? { Authorization: `Bearer ${cfg.bridgeToken}` }
        : {}),
    },
    body: JSON.stringify({
      model: HERMES_MODEL,
      input: prompt,
      // Use our agent_session.id as Hermes' conversation key. Hermes
      // auto-chains turns within the same conversation server-side, so
      // we don't need to track previous_response_id ourselves.
      conversation: session.id,
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    return c.json(
      {
        error: "hermes_gateway_error",
        status: upstream.status,
        detail: txt.slice(0, 500),
      },
      502,
    );
  }

  // ── Translate Hermes Responses SSE → frontend's expected shape ──
  //
  // Frontend in useChat.ts listens for:
  //   event: update + data: {sessionUpdate: "agent_message_chunk",
  //                          content: {text: "..."}}
  //   event: update + data: {sessionUpdate: "tool_call",
  //                          toolCallId, title, kind, locations, content}
  //   event: error  + data: {message}
  //
  // Hermes emits OpenAI Responses API events. Map:
  //   response.output_text.delta  → agent_message_chunk
  //   response.output_item.added with item.type=function_call → tool_call
  //   response.failed             → error
  //   response.completed          → close stream
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = "";
      let agentText = "";
      const toolEntries: Array<{
        callId: string;
        name: string;
        args: unknown;
      }> = [];

      function processSseBlock(block: string) {
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) return;

        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }

        // Hermes also wraps `data: [DONE]` is not used here for /v1/responses
        // — completion is signalled by event=response.completed.
        switch (event) {
          case "response.output_text.delta": {
            const delta: string = parsed.delta ?? "";
            if (!delta) return;
            agentText += delta;
            controller.enqueue(
              sse("update", {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: delta },
              }),
            );
            return;
          }
          case "response.output_item.added": {
            const item = parsed.item;
            if (!item || item.type !== "function_call") return;
            const callId: string =
              item.call_id ?? item.id ?? `${Date.now()}-${Math.random()}`;
            const name: string = item.name ?? "tool";
            let parsedArgs: unknown = item.arguments;
            if (typeof item.arguments === "string") {
              try {
                parsedArgs = JSON.parse(item.arguments);
              } catch {
                /* keep raw string */
              }
            }
            const title = `${name}${
              typeof item.arguments === "string"
                ? `(${item.arguments.slice(0, 80)}${
                    item.arguments.length > 80 ? "…" : ""
                  })`
                : ""
            }`;
            toolEntries.push({ callId, name, args: parsedArgs ?? null });
            controller.enqueue(
              sse("update", {
                sessionUpdate: "tool_call",
                toolCallId: callId,
                title,
                kind: name,
                content: parsedArgs ?? null,
                locations: null,
              }),
            );
            return;
          }
          case "response.failed": {
            const msg =
              parsed.response?.error?.message ??
              parsed.error?.message ??
              "hermes failed";
            controller.enqueue(sse("error", { message: msg }));
            return;
          }
          case "response.completed": {
            // Signal nothing extra — the stream close below is enough.
            return;
          }
          default:
            // ignore created/in_progress/etc.
            return;
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            if (block.trim()) processSseBlock(block);
          }
        }
        // Drain any trailing block that wasn't terminated by \n\n
        if (buffer.trim()) processSseBlock(buffer);
      } catch (e) {
        controller.enqueue(
          sse("error", { message: (e as Error).message }),
        );
      } finally {
        controller.close();
        try {
          if (agentText) {
            await db.insert(agentMessages).values({
              sessionId: session.id,
              role: "agent",
              content: agentText,
              stats: { tools: toolEntries.length || undefined },
            });
          }
          for (const t of toolEntries) {
            await db.insert(agentMessages).values({
              sessionId: session.id,
              role: "tool",
              content: t.name,
              stats: { args: t.args, callId: t.callId },
            });
          }
          await db
            .update(agentSessions)
            .set({ updatedAt: new Date() })
            .where(eq(agentSessions.id, session.id));
        } catch (e) {
          console.error("[hermes-agent] persistence failed:", e);
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
});

export default hermesAgentRoute;
