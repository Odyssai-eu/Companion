/**
 * Chat completion proxy — LiteLLM only.
 *
 * The frontend posts {conversationId, messages, model, inference}. We:
 *
 *   1. Resolve the user's LiteLLM target (per-user URL/key, env, fallback).
 *   2. Pull "what I remember about you" from the memory service and prepend
 *      it to the system prompt.
 *   3. Atomically read & advance users.last_interaction_at (single tx, FOR
 *      UPDATE row lock) — the read gives us T_old for the time tag, the
 *      write makes the next request see T_now.
 *   4. Inject [ISO | Δ: …] tags onto every user message. The latest one
 *      uses T_old as its delta basis; historicals use the previous message's
 *      provided createdAt (or fall back to T_old when missing).
 *   5. Forward to LiteLLM /v1/chat/completions, stream the response back
 *      verbatim (SSE).
 *
 * No engine-kind dispatch, no model resolution magic — LiteLLM exposes a
 * single OpenAI-compatible surface.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { conversations, users } from "../db/schema";
import { authHeaders } from "../lib/litellm";
import { getMemoryContext } from "../lib/memory";
import { buildTag } from "../lib/timetag";

type Env = { Variables: { userId: string } };
const chatRoute = new Hono<Env>();

// ── Types from the client ─────────────────────────────────────────────────

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type IncomingMessage = {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
  /** ISO-8601 — populated by the frontend for time-tag deltas. Optional;
   *  falls back to T_old when absent. */
  createdAt?: string;
};

type ChatBody = {
  conversationId?: string;
  messages?: IncomingMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repetition_penalty?: number;
  seed?: number;
  thinking?: boolean;
  reasoning_effort?: string;
  system_prompt?: string;
};

// ── Route ────────────────────────────────────────────────────────────────

chatRoute.post("/completions", async (c) => {
  const body = (await c.req.json().catch(() => null)) as ChatBody | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "missing_messages" }, 400);
  }
  if (!body.model) {
    return c.json({ error: "missing_model" }, 400);
  }

  const userId = c.get("userId");

  // ── 1. Atomic last-interaction swap ────────────────────────────────────
  // SELECT … FOR UPDATE locks the user row for the duration of the tx.
  // Concurrent chat requests from the same user serialize through this gate,
  // so each gets the immediately-prior interaction time as its delta basis.
  const now = new Date();
  const userRow = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        timezone: users.timezone,
        lastInteractionAt: users.lastInteractionAt,
        litellmUrl: users.litellmUrl,
        litellmApiKey: users.litellmApiKey,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!row) throw new Error("user_not_found");
    await tx
      .update(users)
      .set({ lastInteractionAt: now })
      .where(eq(users.id, userId));
    return row;
  });

  // ── 2. Resolve LiteLLM target ─────────────────────────────────────────
  const target = {
    baseUrl: (userRow.litellmUrl ?? process.env.LITELLM_URL ?? "http://192.168.86.44:4000")
      .replace(/\/+$/, ""),
    apiKey: userRow.litellmApiKey ?? process.env.LITELLM_API_KEY ?? null,
  };

  // ── 3. Resolve project + memory context (best-effort) ─────────────────
  let projectId: string | null = null;
  let memoryBlock = "";
  if (body.conversationId) {
    try {
      const [conv] = await db
        .select({ projectId: conversations.projectId, userId: conversations.userId })
        .from(conversations)
        .where(eq(conversations.id, body.conversationId))
        .limit(1);
      if (conv && conv.userId === userId) {
        projectId = conv.projectId;
        memoryBlock = await getMemoryContext(userId, projectId);
      }
    } catch (err) {
      console.warn("[chat] memory lookup failed:", (err as Error).message);
    }
  }

  // ── 4. Inject time tags into user messages ────────────────────────────
  const tz = userRow.timezone || "Europe/Brussels";
  const taggedMessages: IncomingMessage[] = [];
  let prevTimestamp: Date | null = userRow.lastInteractionAt ?? null;
  let latestUserSeen = false;

  // Walk messages in order. The LATEST (last in array, role=user) message is
  // the one being sent now; we use T_old=lastInteractionAt for its delta.
  // Historical user messages use either their provided createdAt (frontend
  // sends it) or fall back to walking from T_old.
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (m.role !== "user") {
      taggedMessages.push(m);
      continue;
    }
    const isLatest = i === body.messages.length - 1;
    const createdAt = isLatest
      ? now
      : m.createdAt
        ? new Date(m.createdAt)
        : null;

    const stamp = createdAt ?? now;
    const tag = buildTag({
      now: stamp,
      previous: latestUserSeen || prevTimestamp ? prevTimestamp : null,
      timezone: tz,
    });
    // Do not overwrite — prepend on a new line for readability
    taggedMessages.push({
      ...m,
      content: prependTagToContent(m.content, tag),
    });
    prevTimestamp = stamp;
    latestUserSeen = true;
  }

  // ── 5. Compose system prompt: user prompt + memory ───────────────────
  const systemSegments: string[] = [];
  if (body.system_prompt && body.system_prompt.trim().length > 0) {
    systemSegments.push(body.system_prompt.trim());
  }
  if (memoryBlock.trim().length > 0) systemSegments.push(memoryBlock);
  const composedSystem = systemSegments.join("\n\n---\n\n");

  const withSystem =
    composedSystem.length > 0
      ? [
          { role: "system" as const, content: composedSystem },
          ...taggedMessages,
        ]
      : taggedMessages;

  // ── 6. Forward to LiteLLM ─────────────────────────────────────────────
  const upstreamBody: Record<string, unknown> = {
    model: body.model,
    messages: withSystem,
    stream: true,
  };
  for (const k of [
    "temperature",
    "max_tokens",
    "top_p",
    "top_k",
    "min_p",
    "repetition_penalty",
    "seed",
  ] as const) {
    const v = body[k];
    if (v !== undefined) upstreamBody[k] = v;
  }
  if (body.thinking) upstreamBody.enable_thinking = true;
  if (body.thinking && body.reasoning_effort)
    upstreamBody.reasoning_effort = body.reasoning_effort;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(target),
  };

  // ── 7. Stream with a heartbeat keep-alive ──────────────────────────────
  //
  // Why: when a local model (e.g. GLM-5.1) is cold, exo can take 60–90s to
  // load it. During that time, LiteLLM's fetch() blocks waiting for the
  // first response byte, and our backend blocks waiting for LiteLLM. If we
  // sat at `await fetch(...)` and only wrote to the response when it
  // resolved, Cloudflare's 100s "time to first byte" cap would kill the
  // connection with a 524 long before the model warmed up.
  //
  // So we open the SSE response immediately, emit a `:keepalive` comment
  // every 25s while we wait, fire the upstream fetch in the background,
  // and pipe the upstream body into our stream when it arrives. The
  // browser-side parser ignores SSE comment lines (anything starting with
  // `:`), so the heartbeats are invisible to the UI.

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Push one heartbeat immediately so the first byte hits the wire asap.
  writer.write(encoder.encode(":keepalive\n\n")).catch(() => undefined);
  const heartbeat: ReturnType<typeof setInterval> = setInterval(() => {
    writer.write(encoder.encode(":keepalive\n\n")).catch(() => undefined);
  }, 25_000);

  void (async () => {
    try {
      const upstream = await fetch(`${target.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
      });

      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => "");
        const err = `${upstream.status} ${upstream.statusText}: ${text.slice(0, 200)}`;
        console.error("[chat] upstream not ok:", err);
        await writer.write(
          encoder.encode(`data: ${JSON.stringify({ error: err })}\n\n`),
        );
        await writer.write(encoder.encode("data: [DONE]\n\n"));
        return;
      }

      // Pipe the upstream stream into our outer stream.
      const reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
    } catch (err) {
      console.error("[chat] upstream pipe failed:", err);
      try {
        await writer.write(
          encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`),
        );
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch {
        // already closed
      }
    } finally {
      clearInterval(heartbeat);
      try {
        await writer.close();
      } catch {
        // already closed
      }
    }
  })();

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return c.body(readable);
});

// ── Helpers ──────────────────────────────────────────────────────────────

function prependTagToContent(
  content: string | ContentPart[],
  tag: string,
): string | ContentPart[] {
  if (typeof content === "string") {
    return `${tag} ${content}`;
  }
  // Multimodal: find the first text part and prepend; if none, add one.
  const out: ContentPart[] = [];
  let injected = false;
  for (const part of content) {
    if (!injected && part.type === "text") {
      out.push({ type: "text", text: `${tag} ${part.text}` });
      injected = true;
    } else {
      out.push(part);
    }
  }
  if (!injected) out.unshift({ type: "text", text: tag });
  return out;
}

export default chatRoute;
