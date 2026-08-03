#!/usr/bin/env node
// V3-d smoke — the long-tail rebranchements on a v3 conversation:
//  1. /inference falls back to turn_state + parts (MCP status parity)
//  2. export.md derives the Thought from parts
//  3. title auto-gen fired from the first user message
// Runs in the container. Usage: node /app/scripts/smoke-v3d.mjs [model]

import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const MODEL = process.argv[2] ?? "CoeOS";
const BASE = "http://127.0.0.1:3000";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const results = [];
const check = (n, ok, d) => { results.push({ ok }); console.log(`${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); };

let tokenId = null, convId = null;
try {
  const [user] = await q("select id from users where role='admin' order by created_at asc limit 1");
  const token = "hms_" + randomBytes(24).toString("base64url");
  const [tok] = await q(
    "insert into hermes_tokens (user_id, token_hash, token, label, source) values ($1,$2,$3,'smoke-v3d','cowork') returning id",
    [user.id, createHash("sha256").update(token).digest("hex"), token],
  );
  tokenId = tok.id;
  const auth = { authorization: `Bearer ${token}` };

  // Create via the REAL route so title auto-gen path is exercised.
  const cr = await fetch(`${BASE}/api/conversations`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL }),
  });
  convId = (await cr.json()).conversation.id;
  const prompt = "Explique en une phrase pourquoi séparer thinking et résultat aide la lecture.";
  await fetch(`${BASE}/api/conversations/${convId}/messages`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ role: "user", content: prompt }),
  });

  await fetch(`${BASE}/api/v3/chat`, {
    method: "POST", headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ conversationId: convId, model: MODEL, messages: [{ role: "user", content: prompt }], params: { max_tokens: 2500, thinking: true } }),
  });

  // Poll /inference — must report the v3 turn (active then done).
  let sawActive = false, finalStatus = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await (await fetch(`${BASE}/api/conversations/${convId}/inference`, { headers: auth })).json();
    if (s.active) sawActive = true;
    const [ts] = await q("select status from turn_states where conversation_id=$1", [convId]);
    if (ts && ts.status !== "active") { finalStatus = s; break; }
  }
  check("(1a) /inference reported the v3 turn active", sawActive, `active seen=${sawActive}`);
  check("(1b) /inference done:true + content via turn_state fallback",
    finalStatus?.done === true && (finalStatus?.content?.length ?? 0) > 0,
    `done=${finalStatus?.done} content=${finalStatus?.content?.length ?? 0}ch`);

  await new Promise((r) => setTimeout(r, 800));
  const md = await (await fetch(`${BASE}/api/conversations/${convId}/export.md`, { headers: auth })).text();
  check("(2) export.md contains the Thought derived from parts",
    md.includes("<summary>Thought</summary>"),
    `md=${md.length}ch thought=${md.includes("Thought")}`);

  const [conv] = await q("select title from conversations where id=$1", [convId]);
  check("(3) title auto-generated from first user message",
    conv.title !== "New conversation" && conv.title.length > 0,
    `title="${conv.title?.slice(0, 40)}"`);
} catch (e) {
  check("smoke crashed", false, e.message);
} finally {
  if (convId) await q("delete from conversations where id=$1", [convId]).catch(() => {});
  if (tokenId) await q("update hermes_tokens set revoked_at=now() where id=$1", [tokenId]).catch(() => {});
  await pool.end().catch(() => {});
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass} pass / ${results.length - pass} fail`);
process.exit(pass === results.length ? 0 : 1);
