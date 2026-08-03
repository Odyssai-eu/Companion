#!/usr/bin/env node
// V3-a smoke — proves the /api/v3 rail end-to-end against the LIVE
// server, from INSIDE the container (node on the workstation can't route
// to .39 — known interface quirk; localhost:3000 is the app here).
//
// Asserts:
//  1. POST /api/v3/chat returns 202 and turn_state flips to 'active'
//  2. the SSE emits OUR frames only (v3:*) — never a provider frame
//  3. reasoning deltas AND text deltas arrive as separate typed parts
//  4. the message row ends with a parts[] array + mirrored content
//  5. turn_state settles to 'done'
//
// Mints a scoped hermes token for the run and revokes it at the end.
//
// Usage (in container): node /app/scripts/smoke-v3.mjs [model]

import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const MODEL = process.argv[2] ?? "CoeOS";
const BASE = "http://127.0.0.1:3000";
const PROMPT =
  "En deux phrases: pourquoi un stream de parts typees vaut mieux qu'un relais de frames provider ?";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

let tokenId = null;
let convId = null;

try {
  // ── fixtures ────────────────────────────────────────────────────────
  const [user] = await q(
    "select id, email from users where role = 'admin' order by created_at asc limit 1",
  );
  if (!user) throw new Error("no admin user");

  const token = "hms_" + randomBytes(24).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const [tok] = await q(
    `insert into hermes_tokens (user_id, token_hash, token, label, source)
     values ($1, $2, $3, 'smoke-v3', 'cowork') returning id`,
    [user.id, hash, token],
  );
  tokenId = tok.id;

  const [conv] = await q(
    `insert into conversations (user_id, title, kind, model, memory_enabled, agent_mode)
     values ($1, 'smoke-v3', 'chat', $2, false, false) returning id`,
    [user.id, MODEL],
  );
  convId = conv.id;
  await q(
    "insert into messages (conversation_id, role, content) values ($1, 'user', $2)",
    [convId, PROMPT],
  );

  const auth = { authorization: `Bearer ${token}` };

  // ── open the SSE BEFORE firing (anti-gap order is the route's job,
  //    but this also catches a stream that never opens) ───────────────
  const frames = [];
  const ac = new AbortController();
  const sse = await fetch(`${BASE}/api/v3/conversations/${convId}/stream`, {
    headers: auth,
    signal: ac.signal,
  });
  if (!sse.ok || !sse.body) throw new Error(`SSE ${sse.status}`);
  const reading = (async () => {
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!raw.startsWith("data: ")) continue;
        try {
          frames.push(JSON.parse(raw.slice(6)));
        } catch {
          /* keepalive / partial */
        }
      }
    }
  })();

  // ── fire ────────────────────────────────────────────────────────────
  const post = await fetch(`${BASE}/api/v3/chat`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: convId,
      model: MODEL,
      messages: [{ role: "user", content: PROMPT }],
      params: { max_tokens: 4000, thinking: true },
    }),
  });
  check("(1a) POST /api/v3/chat accepted", post.status === 202, `HTTP ${post.status}`);

  // ── wait for the turn to settle (durable state, not a guess) ────────
  const deadline = Date.now() + 180_000;
  let state = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const [row] = await q(
      "select status, error from turn_states where conversation_id = $1",
      [convId],
    );
    state = row ?? null;
    if (state && state.status !== "active") break;
  }
  await new Promise((r) => setTimeout(r, 1200)); // let trailing frames land
  ac.abort();
  await reading.catch(() => {});

  check(
    "(1b) turn_state settled",
    state?.status === "done",
    `status=${state?.status ?? "none"}${state?.error ? ` error=${state.error}` : ""}`,
  );

  // ── frame shape: ours only ──────────────────────────────────────────
  const kinds = {};
  for (const f of frames) kinds[f.v3 ?? "?"] = (kinds[f.v3 ?? "?"] ?? 0) + 1;
  const foreign = frames.filter(
    (f) => !f.v3 || (f.choices !== undefined || f.object !== undefined),
  );
  check(
    "(2) SSE carries only v3 frames (no provider leak)",
    frames.length > 0 && foreign.length === 0,
    JSON.stringify(kinds),
  );

  const deltas = frames.filter((f) => f.v3 === "part-delta");
  const reasoningDeltas = deltas.filter((d) => d.kind === "reasoning").length;
  const textDeltas = deltas.filter((d) => d.kind === "text").length;
  check(
    "(3) reasoning + text deltas streamed as distinct kinds",
    reasoningDeltas > 0 && textDeltas > 0,
    `reasoning=${reasoningDeltas} text=${textDeltas}`,
  );

  // ── durable parts on the row ────────────────────────────────────────
  const [msg] = await q(
    `select parts, content, stats from messages
     where conversation_id = $1 and role = 'assistant'
     order by created_at desc limit 1`,
    [convId],
  );
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  const types = [...new Set(parts.map((p) => p.type))];
  check(
    "(4) message row holds typed parts + mirrored content",
    parts.length > 0 &&
      types.includes("text") &&
      typeof msg.content === "string" &&
      msg.content.length > 0,
    `types=${JSON.stringify(types)} content=${msg?.content?.length ?? 0}ch model=${msg?.stats?.model ?? "?"}`,
  );

  const first = parts.find((p) => p.type === "reasoning");
  check(
    "(5) reasoning persisted as its own part (not inlined in text)",
    !!first && !String(msg.content).includes(String(first.text).slice(0, 40)),
    first ? `${String(first.text).length}ch reasoning` : "no reasoning part",
  );
} catch (err) {
  check("smoke crashed", false, err.message);
} finally {
  if (convId) await q("delete from conversations where id = $1", [convId]).catch(() => {});
  if (tokenId)
    await q("update hermes_tokens set revoked_at = now() where id = $1", [tokenId]).catch(
      () => {},
    );
  await pool.end().catch(() => {});
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass} pass / ${results.length - pass} fail`);
process.exit(pass === results.length ? 0 : 1);
