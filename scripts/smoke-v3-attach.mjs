#!/usr/bin/env node
// Verify chat attachments reach the model on the v3 rail: send a turn with
// a `document` content-part (a tiny markdown carrying a unique token) and
// check the assistant's reply echoes the token — proving the server parsed
// the doc (Docling) and the model read it. Runs in the container.
// Usage: node /app/scripts/smoke-v3-attach.mjs [model]

import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const MODEL = process.argv[2] ?? "tele-fast:qwen3-30b-a3b-instruct-2507-6bit";
const BASE = "http://127.0.0.1:3000";
const TOKEN = "ZORGLUB-4213";
const DOC = `# Note interne\n\nLe code secret du projet est ${TOKEN}. Ne pas le divulguer.\n`;
const dataUrl = "data:text/markdown;base64," + Buffer.from(DOC, "utf-8").toString("base64");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;
const results = [];
const check = (n, ok, d) => { results.push({ ok }); console.log(`${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`); };

let tokenId = null, convId = null;
try {
  const [user] = await q("select id from users where role='admin' order by created_at asc limit 1");
  const token = "hms_" + randomBytes(24).toString("base64url");
  const [tok] = await q(
    "insert into hermes_tokens (user_id, token_hash, token, label, source) values ($1,$2,$3,'smoke-attach','cowork') returning id",
    [user.id, createHash("sha256").update(token).digest("hex"), token],
  );
  tokenId = tok.id;
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const [conv] = await q(
    "insert into conversations (user_id,title,kind,model,memory_enabled,agent_mode) values ($1,'smoke-attach','chat',$2,false,false) returning id",
    [user.id, MODEL],
  );
  convId = conv.id;

  const question = "Quel est le code secret mentionné dans le document joint ? Réponds juste le code.";
  const content = [
    { type: "text", text: question },
    { type: "document", document: { name: "note.md", url: dataUrl, mime: "text/markdown" } },
  ];
  await q("insert into messages (conversation_id,role,content) values ($1,'user',$2)", [convId, question]);

  const post = await fetch(`${BASE}/api/v3/chat`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ conversationId: convId, model: MODEL, messages: [{ role: "user", content }], params: { max_tokens: 200, thinking: false } }),
  });
  check("(1) POST accepted", post.status === 202, `HTTP ${post.status}`);

  let status = null;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const [ts] = await q("select status,error from turn_states where conversation_id=$1", [convId]);
    if (ts && ts.status !== "active") { status = ts; break; }
  }
  check("(2) turn settled done", status?.status === "done", `status=${status?.status} err=${status?.error ?? ""}`);

  const [a] = await q("select content from messages where conversation_id=$1 and role='assistant' order by created_at desc limit 1", [convId]);
  const answer = a?.content ?? "";
  console.log(`  answer: ${answer.slice(0, 120)}`);
  check("(3) model read the attached document (echoed the token)", answer.includes(TOKEN), `token ${answer.includes(TOKEN) ? "found" : "MISSING"}`);
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
