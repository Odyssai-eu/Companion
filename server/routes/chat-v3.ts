// v3 chat routes (PLAN.md V3-a.4/5) — thin HTTP shell over the
// processor. The client NEVER sees a provider frame: POST fires the
// turn (fire-and-forget, MCP-safe), the single SSE streams typed parts
// with the anti-gap order (subscribe → buffer → replay → splice), stop
// flips the durable cancel flag, and /:id/state is the thin turn_state
// read (cross-tab placeholder, prewarm guard, MCP polling).

import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index";
import { conversations, messages } from "../db/schema";
import {
  getTurnState,
  requestStop,
  runTurnV3,
  type TurnRequest,
} from "../lib/v3/processor";
import { subscribeRunEvents } from "../lib/run-events";
import type { GuestTokenContext } from "../lib/guest-token";

type Env = { Variables: { userId: string; guest?: GuestTokenContext } };

const v3 = new Hono<Env>();

async function ownConv(userId: string, id: string) {
  const [conv] = await db
    .select({ id: conversations.id, userId: conversations.userId })
    .from(conversations)
    .where(eq(conversations.id, id))
    .limit(1);
  return conv && conv.userId === userId ? conv : null;
}

// Fire a turn. Returns immediately (202) — progress flows on the SSE,
// completion state lives in turn_state. Same request contract as v1
// (client persists the user message itself, sends full history).
v3.post("/chat", async (c) => {
  const userId = c.get("userId");
  const guest = c.get("guest");
  const body = (await c.req.json().catch(() => null)) as
    | (TurnRequest & { params?: TurnRequest["params"] })
    | null;
  if (!body?.conversationId || !Array.isArray(body.messages) || !body.model) {
    return c.json({ error: "missing_fields" }, 400);
  }
  if (!(await ownConv(userId, body.conversationId))) {
    return c.json({ error: "not_found" }, 404);
  }
  const state = await getTurnState(body.conversationId);
  if (state?.status === "active") {
    return c.json({ error: "turn_already_active" }, 409);
  }
  void runTurnV3({ ...body, userId, guest });
  return c.json({ accepted: true }, 202);
});

// The single SSE — anti-gap order is MANDATORY (review rd2 pt1):
// (1) subscribe the broker and BUFFER live frames, (2) replay persisted
// parts, (3) flush the buffer. Keepalive frames until the first part
// (Cloudflare kills >100s TTFB on cold starts).
v3.get("/conversations/:id/stream", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownConv(userId, id))) return c.json({ error: "not_found" }, 404);

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array>();
  const w = writable.getWriter();
  let closed = false;
  const write = (s: string) => {
    if (closed) return;
    w.write(encoder.encode(s)).catch(() => {
      closed = true;
    });
  };
  const frame = (o: unknown) => write(`data: ${JSON.stringify(o)}\n\n`);

  // (1) subscribe FIRST, buffer while replaying.
  let replaying = true;
  const buffer: unknown[] = [];
  const unsubscribe = subscribeRunEvents(id, (ev) => {
    const payload =
      ev.type === "v3" ? ev.payload : { v3: "event", type: ev.type, payload: ev.payload };
    if (replaying) buffer.push(payload);
    else frame(payload);
  });

  // (2) replay persisted messages with their parts.
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      messageType: messages.messageType,
      payload: messages.payload,
      parts: messages.parts,
      content: messages.content,
      stats: messages.stats,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(asc(messages.createdAt));
  frame({ v3: "replay", messages: rows });

  // (3) splice the buffer, go live.
  replaying = false;
  for (const b of buffer) frame(b);
  buffer.length = 0;

  const keepAlive = setInterval(() => write(": keepalive\n\n"), 25_000);
  c.req.raw.signal.addEventListener("abort", () => {
    closed = true;
    clearInterval(keepAlive);
    unsubscribe();
    w.close().catch(() => {});
  });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return c.body(readable);
});

// Real stop (review rd2 pt4): durable cancel flag, checked by the
// processor between parts — partial parts stay, turn marked 'stopped'.
v3.post("/conversations/:id/stop", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownConv(userId, id))) return c.json({ error: "not_found" }, 404);
  await requestStop(id);
  return c.json({ ok: true });
});

// Thin turn_state read — cross-tab placeholder, prewarm in-flight
// guard, MCP get_inference_status.
v3.get("/conversations/:id/state", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownConv(userId, id))) return c.json({ error: "not_found" }, 404);
  const state = await getTurnState(id);
  return c.json({
    active: state?.status === "active",
    status: state?.status ?? null,
    error: state?.error ?? null,
    updatedAt: state?.updatedAt ?? null,
  });
});

export default v3;
