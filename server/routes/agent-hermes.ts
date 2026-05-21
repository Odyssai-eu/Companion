/**
 * Hermes agent invocation endpoint. Routes the user's `/hermes <prompt>`
 * input through the bridge configured in the Hermes add-on.
 *
 *   POST /api/agents/hermes/invoke
 *     body: {conversationId, prompt}
 *     responds: SSE stream of `event: chunk | tool | done | error`
 *
 *   GET  /api/agents/hermes/transcript/:conversationId
 *     → past messages for the agent sub-thread in this conv
 *
 *   POST /api/agents/hermes/reset/:conversationId
 *     → drop the bridge session, force a fresh one on next invoke
 *
 * Persistence:
 *  - agent_sessions row exists per (conv, kind='hermes')
 *  - agent_messages stores the transcript (role: user | agent | tool)
 *  - bridge_session_id stored on the row, reused across invokes
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

async function ensureSession(
  userId: string,
  conversationId: string,
): Promise<{ id: string; bridgeSessionId: string | null }> {
  const [existing] = await db
    .select({
      id: agentSessions.id,
      bridgeSessionId: agentSessions.bridgeSessionId,
    })
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
    .returning({
      id: agentSessions.id,
      bridgeSessionId: agentSessions.bridgeSessionId,
    });
  return created;
}

async function bridgeNewSession(
  bridgeUrl: string,
  bridgeToken: string | undefined,
  cwd: string,
): Promise<string> {
  const url = bridgeUrl.replace(/\/+$/, "") + "/sessions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bridgeToken ? { Authorization: `Bearer ${bridgeToken}` } : {}),
    },
    body: JSON.stringify({ cwd }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`bridge /sessions ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { sessionId: string };
  return data.sessionId;
}

// ── Transcript ────────────────────────────────────────────────────────────

hermesAgentRoute.get("/transcript/:conversationId", async (c) => {
  const userId = c.get("userId");
  const convId = c.req.param("conversationId");
  // Authorize: conv belongs to user
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

  // Authz: conv must belong to user
  const [conv] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (!conv || conv.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }

  // Load addon config
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

  // Lookup or create our session row
  const session = await ensureSession(userId, conversationId);
  let bridgeSid = session.bridgeSessionId;

  // Lazy bridge-session creation on first prompt of a session
  if (!bridgeSid) {
    try {
      bridgeSid = await bridgeNewSession(
        cfg.bridgeUrl!,
        cfg.bridgeToken,
        // For niveau-1 (Hermes on workstation), cwd defaults to home.
        // Future: per-conv cwd override (e.g., a repo path).
        "/",
      );
      await db
        .update(agentSessions)
        .set({ bridgeSessionId: bridgeSid, updatedAt: new Date() })
        .where(eq(agentSessions.id, session.id));
    } catch (e) {
      return c.json(
        {
          error: "bridge_unreachable",
          detail: `Could not start a bridge session: ${(e as Error).message}`,
        },
        502,
      );
    }
  }

  // Persist the user message immediately so reloads see it
  await db.insert(agentMessages).values({
    sessionId: session.id,
    role: "user",
    content: prompt,
  });

  const promptUrl =
    cfg.bridgeUrl!.replace(/\/+$/, "") + `/sessions/${bridgeSid}/prompt`;

  // Open SSE stream from the bridge
  const upstream = await fetch(promptUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...(cfg.bridgeToken
        ? { Authorization: `Bearer ${cfg.bridgeToken}` }
        : {}),
    },
    body: JSON.stringify({ prompt }),
  });
  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => "");
    return c.json(
      {
        error: "bridge_error",
        status: upstream.status,
        detail: txt.slice(0, 500),
      },
      502,
    );
  }

  // Stream the bridge SSE through to the client AND accumulate the
  // agent's text+tool messages for persistence.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = "";
      let agentText = "";
      const toolEntries: Array<{ name: string; args: unknown }> = [];

      function flushParse(chunk: string) {
        buffer += chunk;
        // SSE events are separated by blank lines
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          if (!block.trim()) continue;
          // Forward to client verbatim
          controller.enqueue(encoder.encode(block + "\n\n"));
          // Parse for persistence
          let event = "message";
          let data: string | null = null;
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) {
              data = (data ?? "") + line.slice(5).trim();
            }
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            if (event === "update") {
              const kind = parsed.sessionUpdate;
              if (kind === "agent_message_chunk") {
                agentText += parsed.content?.text ?? "";
              } else if (kind === "tool_call") {
                // ACP `tool_call` is flat: `title` is the user-facing
                // label ("write: /tmp/foo.txt"), `kind` is the category
                // (edit/read/exec), `toolCallId` is the dedup key.
                // No `name` field at this level — bridge_auto_approved
                // carries the raw tool name later but we skip that event.
                toolEntries.push({
                  name: parsed.title ?? parsed.kind ?? "(unknown)",
                  args: parsed.locations ?? parsed.content ?? null,
                });
              }
              // bridge_auto_approved is metadata about permission flow,
              // not a tool action — the tool_call right before already
              // surfaced the user-visible action. Skip to avoid duplication.
            }
          } catch {
            /* ignore non-JSON */
          }
        }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          flushParse(decoder.decode(value, { stream: true }));
        }
        // Flush any tail
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(buffer + "\n\n"));
        }
      } catch (e) {
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ message: (e as Error).message })}\n\n`,
          ),
        );
      } finally {
        controller.close();
        // Persist what we've accumulated
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
              stats: { args: t.args },
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
