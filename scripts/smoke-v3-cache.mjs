#!/usr/bin/env node
// Verify the prefix cache is hit again: two turns on one conversation with
// STABLE per-message createdAt should make turn 2 report cachedTokens > 0
// (the shared prefix — system + turn 1 — is served from the upstream cache).
// Runs in the container. Usage: node /app/scripts/smoke-v3-cache.mjs [model]

import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const MODEL = process.argv[2] ?? "CoeOS";
const BASE = "http://127.0.0.1:3000";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const results = [];
const check = (n, ok, d) => { results.push({ ok }); console.log(`${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); };

async function turn(convId, auth, history) {
  await fetch(`${BASE}/api/v3/chat`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ conversationId: convId, model: MODEL, messages: history, params: { max_tokens: 400, thinking: false } }),
  });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const [ts] = await q("select status from turn_states where conversation_id=$1", [convId]);
    if (ts && ts.status !== "active") break;
  }
  const [a] = await q("select stats from messages where conversation_id=$1 and role='assistant' order by created_at desc limit 1", [convId]);
  return a?.stats ?? {};
}

let tokenId = null, convId = null;
try {
  const [user] = await q("select id from users where role='admin' order by created_at asc limit 1");
  const token = "hms_" + randomBytes(24).toString("base64url");
  const [tok] = await q(
    "insert into hermes_tokens (user_id, token_hash, token, label, source) values ($1,$2,$3,'smoke-cache','cowork') returning id",
    [user.id, createHash("sha256").update(token).digest("hex"), token],
  );
  tokenId = tok.id;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const [conv] = await q(
    "insert into conversations (user_id,title,kind,model,memory_enabled,agent_mode) values ($1,'smoke-cache','chat',$2,false,false) returning id",
    [user.id, MODEL],
  );
  convId = conv.id;

  // Fixed timestamps — this is the whole point (byte-stable prefix).
  // A big turn-1 prompt so the shared prefix is worth caching.
  const t1 = "2026-08-05T09:00:00.000Z";
  const filler = "Contexte de référence à garder en tête. ".repeat(120);
  const u1 = filler + "\n\nBonjour, présente-toi en une phrase.";
  await q("insert into messages (conversation_id,role,content,created_at) values ($1,'user',$2,$3)", [convId, u1, t1]);
  const s1 = await turn(convId, auth, [{ role: "user", content: u1, createdAt: t1 }]);
  console.log(`  turn1: prompt=${s1.promptTokens} cached=${s1.cachedTokens ?? 0}`);

  // Turn 2 replays turn 1 with the SAME createdAt (as the client now does).
  const [asst1] = await q("select content from messages where conversation_id=$1 and role='assistant' order by created_at asc limit 1", [convId]);
  const t2 = "2026-08-05T09:01:00.000Z";
  const u2 = "Et quel est ton rôle exactement ?";
  await q("insert into messages (conversation_id,role,content,created_at) values ($1,'user',$2,$3)", [convId, u2, t2]);
  const s2 = await turn(convId, auth, [
    { role: "user", content: u1, createdAt: t1 },
    { role: "assistant", content: asst1?.content ?? "" },
    { role: "user", content: u2, createdAt: t2 },
  ]);
  console.log(`  turn2: prompt=${s2.promptTokens} cached=${s2.cachedTokens ?? 0}`);

  check("(1) turn 2 reports cachedTokens in stats", s2.cachedTokens !== undefined, `cached=${s2.cachedTokens ?? "absent"}`);
  check("(2) prefix cache actually hit on turn 2 (cached > 0)", (s2.cachedTokens ?? 0) > 0, `cached=${s2.cachedTokens ?? 0}/${s2.promptTokens} prompt`);
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
