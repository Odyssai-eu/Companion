/**
 * Pi agent invocation endpoint. Routes the user's `/pi <prompt>` input
 * through the thecompai-pi-bridge, which wraps the Pi coding-agent CLI.
 *
 *   POST /api/agents/pi/invoke
 *     body: {conversationId, prompt}
 *     → SSE stream of Pi native events under the `pi.*` namespace.
 *       The frontend renders these directly (no translation layer).
 *
 *   GET  /api/agents/pi/transcript/:conversationId
 *     → forwarded to bridge GET /sessions/{convId}/transcript. Returns
 *       the raw Pi session jsonl from disk on the bridge host. The
 *       bridge is the source of truth — Companion does NOT mirror the
 *       transcript in its own DB.
 *
 *   POST /api/agents/pi/reset/:conversationId
 *     → DELETE the bridge session in memory. The on-disk jsonl is
 *       preserved by the bridge. Next /pi opens a fresh session under
 *       the same convId (so by default it reuses the disk-backed jsonl
 *       — append-mode). To start truly clean, swap convId on the
 *       frontend (new conversation).
 *
 * Architecture decision (2026-05-27, after Sophie's "lean on Pi" reframe):
 *   - Pi keeps the transcript on disk via its --session-dir. We
 *     send the Companion conversation UUID as the bridge's session id,
 *     which is mapped to a per-conv session directory on the bridge.
 *   - No agent_sessions / agent_messages mirror in Companion. The
 *     /hermes route still uses those for the legacy mirror pattern,
 *     and we may converge later; for now they diverge intentionally.
 *   - Events are forwarded verbatim (already prefixed `pi.*` by the
 *     bridge for stable namespacing) to the frontend.
 */

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { eq } from "drizzle-orm";
import { conversations } from "../db/schema";
import { loadPiConfigForUser } from "./addon-pi";

type Env = { Variables: { userId: string } };
const piAgentRoute = new Hono<Env>();

// ── Auth helpers ──────────────────────────────────────────────────────────

async function authorizeConv(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const [conv] = await db
    .select({ userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return Boolean(conv && conv.userId === userId);
}

// ── Transcript pass-through ───────────────────────────────────────────────

piAgentRoute.get("/transcript/:conversationId", async (c) => {
  const userId = c.get("userId");
  const convId = c.req.param("conversationId");
  if (!(await authorizeConv(userId, convId))) {
    return c.json({ error: "not_found" }, 404);
  }
  const cfg = await loadPiConfigForUser(userId);
  if (!cfg) {
    return c.json({ sessionId: null, entries: [] });
  }
  const url =
    cfg.bridgeUrl!.replace(/\/+$/, "") +
    `/sessions/${encodeURIComponent(convId)}/transcript`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: cfg.bridgeToken
        ? { Authorization: `Bearer ${cfg.bridgeToken}` }
        : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return c.json(
        { error: "bridge_error", status: res.status },
        502,
      );
    }
    return c.json(await res.json());
  } catch (e) {
    return c.json(
      { error: "bridge_unreachable", detail: (e as Error).message },
      502,
    );
  }
});

// ── Reset pass-through ────────────────────────────────────────────────────

piAgentRoute.post("/reset/:conversationId", async (c) => {
  const userId = c.get("userId");
  const convId = c.req.param("conversationId");
  if (!(await authorizeConv(userId, convId))) {
    return c.json({ error: "not_found" }, 404);
  }
  const cfg = await loadPiConfigForUser(userId);
  if (!cfg) return c.json({ ok: true }); // nothing to reset client-side
  const url =
    cfg.bridgeUrl!.replace(/\/+$/, "") +
    `/sessions/${encodeURIComponent(convId)}`;
  try {
    await fetch(url, {
      method: "DELETE",
      headers: cfg.bridgeToken
        ? { Authorization: `Bearer ${cfg.bridgeToken}` }
        : {},
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* best-effort */
  }
  return c.json({ ok: true });
});

// ── Invoke ────────────────────────────────────────────────────────────────

const invokeSchema = z.object({
  conversationId: z.string().uuid(),
  prompt: z.string().min(1).max(50_000),
});

piAgentRoute.post("/invoke", zValidator("json", invokeSchema), async (c) => {
  const userId = c.get("userId");
  const { conversationId, prompt } = c.req.valid("json");

  if (!(await authorizeConv(userId, conversationId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const cfg = await loadPiConfigForUser(userId);
  if (!cfg) {
    return c.json(
      {
        error: "pi_not_configured",
        detail:
          "The Pi Agent add-on is not enabled or no bridge URL is set. " +
          "Configure it in Settings → Add-ons → Pi Agent.",
      },
      400,
    );
  }

  const base = cfg.bridgeUrl!.replace(/\/+$/, "");

  // 1. Ensure the bridge has a session for this conv. The bridge is
  //    idempotent — if it already has one, it reuses it.
  try {
    const initRes = await fetch(base + "/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.bridgeToken
          ? { Authorization: `Bearer ${cfg.bridgeToken}` }
          : {}),
      },
      body: JSON.stringify({
        sessionId: conversationId,
        cwd: cfg.cwd || undefined,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!initRes.ok) {
      const detail = await initRes.text().catch(() => "");
      return c.json(
        {
          error: "bridge_init_failed",
          status: initRes.status,
          detail: detail.slice(0, 500),
        },
        502,
      );
    }
  } catch (e) {
    return c.json(
      {
        error: "bridge_unreachable",
        detail: (e as Error).message,
      },
      502,
    );
  }

  // 2. Open the prompt SSE stream from the bridge and forward verbatim
  //    to the client. The bridge already prefixes events with `pi.`.
  const promptUrl =
    base + `/sessions/${encodeURIComponent(conversationId)}/prompt`;
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
        error: "bridge_prompt_failed",
        status: upstream.status,
        detail: txt.slice(0, 500),
      },
      502,
    );
  }

  // Translate the upstream Pi-native events into the existing
  // `sessionUpdate` shape the chat client already speaks (originally
  // defined for Hermes). Lets us ship /pi without touching the
  // frontend renderer tonight; a Pi-native UI is a follow-up.
  //
  // Bridge SSE events come as `event: pi.<type>`; we look at the
  // payload and re-emit `event: update` + sessionUpdate data.
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const sse = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = "";

      function processBlock(block: string) {
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) return;
        if (event === "done") {
          // Pass-through — frontend stops on stream close anyway.
          return;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (event === "error") {
          controller.enqueue(sse("error", parsed));
          return;
        }

        // `event: pi.<type>` — payload is the raw Pi event.
        if (event.startsWith("pi.")) {
          const piType = event.slice(3);
          if (piType === "message_update") {
            const ame = parsed.assistantMessageEvent;
            if (!ame) return;
            if (ame.type === "text_delta" && typeof ame.delta === "string") {
              controller.enqueue(
                sse("update", {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: ame.delta },
                }),
              );
            }
            if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
              controller.enqueue(
                sse("update", {
                  sessionUpdate: "agent_thought_chunk",
                  content: { type: "text", text: ame.delta },
                }),
              );
            }
            return;
          }
          if (piType === "tool_execution_start") {
            const callId: string =
              parsed.toolCallId ?? parsed.id ?? `${Date.now()}`;
            const name: string = parsed.toolName ?? parsed.name ?? "tool";
            controller.enqueue(
              sse("update", {
                sessionUpdate: "tool_call",
                toolCallId: callId,
                title: name,
                kind: name,
                content: parsed.input ?? parsed.arguments ?? null,
                locations: null,
              }),
            );
            return;
          }
          // Ignore other Pi events (agent_start, turn_start, etc.) — the
          // text + tool events above are enough for the existing UI.
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
            if (block.trim()) processBlock(block);
          }
        }
        if (buffer.trim()) processBlock(buffer);
      } catch (e) {
        controller.enqueue(
          sse("error", { message: (e as Error).message }),
        );
      } finally {
        controller.close();
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

export default piAgentRoute;
