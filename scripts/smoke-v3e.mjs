#!/usr/bin/env node
// V3-e parity smoke — the behaviours a gate must prove before v3 is the
// default: single-flight (concurrent POST rejected) and real stop
// (cancel mid-turn → status 'stopped' with partial parts kept).
// Runs in the container. Usage: node /app/scripts/smoke-v3e.mjs [model]

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
    "insert into hermes_tokens (user_id, token_hash, token, label, source) values ($1,$2,$3,'smoke-v3e','cowork') returning id",
    [user.id, createHash("sha256").update(token).digest("hex"), token],
  );
  tokenId = tok.id;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const [conv] = await q(
    "insert into conversations (user_id,title,kind,model,memory_enabled,agent_mode) values ($1,'smoke-v3e','chat',$2,false,false) returning id",
    [user.id, MODEL],
  );
  convId = conv.id;
  const prompt = "Écris un paragraphe détaillé sur l'histoire de la marine à voile, au moins 300 mots.";
  await q("insert into messages (conversation_id,role,content) values ($1,'user',$2)", [convId, prompt]);

  const fire = () => fetch(`${BASE}/api/v3/chat`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ conversationId: convId, model: MODEL, messages: [{ role: "user", content: prompt }], params: { max_tokens: 4000, thinking: true } }),
  });

  // Single-flight: fire once, then immediately again → second must 409.
  const first = await fire();
  await new Promise((r) => setTimeout(r, 400));
  const second = await fire();
  check("(1) single-flight — concurrent POST rejected 409", first.status === 202 && second.status === 409, `first=${first.status} second=${second.status}`);

  // Let some parts accumulate, then stop mid-turn.
  await new Promise((r) => setTimeout(r, 6000));
  const stop = await fetch(`${BASE}/api/v3/conversations/${convId}/stop`, { method: "POST", headers: auth });
  // Wait for the turn loop to observe the cancel flag between parts.
  let status = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const [ts] = await q("select status from turn_states where conversation_id=$1", [convId]);
    if (ts && ts.status !== "active") { status = ts.status; break; }
  }
  check("(2a) stop → turn settled 'stopped'", stop.ok && status === "stopped", `stop=${stop.status} final=${status}`);

  const [asst] = await q("select parts, content from messages where conversation_id=$1 and role='assistant' order by created_at desc limit 1", [convId]);
  const parts = Array.isArray(asst?.parts) ? asst.parts : [];
  check("(2b) partial parts kept on stop (not discarded)", parts.length > 0, `parts=${parts.length} types=${JSON.stringify([...new Set(parts.map((p) => p.type))])}`);

  // State endpoint reflects the stop.
  const st = await (await fetch(`${BASE}/api/v3/conversations/${convId}/state`, { headers: auth })).json();
  check("(3) /state reports stopped, not active", st.active === false && st.status === "stopped", `active=${st.active} status=${st.status}`);
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
