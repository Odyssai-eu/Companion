#!/usr/bin/env node
// V3-b smoke — proves TOOLS + DELEGATION run on the parts core.
// Runs in the container (node on .79 can't route to .39).
//
// Two turns on one conversation (agentMode ON):
//  A. a tool-triggering prompt → asserts the primary turn produced
//     tool-call + tool-result PARTS on the assistant row.
//  B. a delegation-forcing prompt → asserts a task card row appeared,
//     a sub-conversation was spawned with its own parts, and run_events
//     fired (task_started → task_done).
//
// Usage (in container): node /app/scripts/smoke-v3b.mjs [model]

import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const MODEL = process.argv[2] ?? "CoeOS";
const BASE = "http://127.0.0.1:3000";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function runTurn(convId, auth, prompt, maxTok) {
  await q("insert into messages (conversation_id, role, content) values ($1,'user',$2)", [convId, prompt]);
  const post = await fetch(`${BASE}/api/v3/chat`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      conversationId: convId,
      model: MODEL,
      messages: (await q(
        "select role, content from messages where conversation_id=$1 and message_type is distinct from 'task' order by created_at asc",
        [convId],
      )).map((m) => ({ role: m.role, content: m.content })),
      params: { max_tokens: maxTok, thinking: true },
    }),
  });
  if (post.status !== 202) return { ok: false, status: post.status };
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const [row] = await q("select status from turn_states where conversation_id=$1", [convId]);
    if (row && row.status !== "active") return { ok: true, status: row.status };
  }
  return { ok: false, status: "timeout" };
}

let tokenId = null;
let convId = null;

try {
  const [user] = await q("select id from users where role='admin' order by created_at asc limit 1");
  if (!user) throw new Error("no admin user");

  // What can this account actually call? (context for the assertions)
  const [nemo] = await q("select name, enabled, mode from agents where user_id=$1 and name='nemo'", [user.id]);
  const subs = await q("select name from agents where user_id=$1 and mode='subagent' and enabled=true", [user.id]);
  console.log(`  nemo=${JSON.stringify(nemo)} subagents=${subs.map((s) => s.name).join(",") || "none"}`);

  const token = "hms_" + randomBytes(24).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  const [tok] = await q(
    "insert into hermes_tokens (user_id, token_hash, token, label, source) values ($1,$2,$3,'smoke-v3b','cowork') returning id",
    [user.id, hash, token],
  );
  tokenId = tok.id;
  const auth = { authorization: `Bearer ${token}` };

  const [conv] = await q(
    "insert into conversations (user_id, title, kind, model, memory_enabled, agent_mode) values ($1,'smoke-v3b','chat',$2,true,true) returning id",
    [user.id, MODEL],
  );
  convId = conv.id;

  // ── Turn A — tool path ────────────────────────────────────────────────
  const a = await runTurn(
    convId,
    auth,
    "Liste les fichiers de mon workspace avec l'outil fs_list, puis dis-moi combien il y en a. Utilise l'outil, n'invente pas.",
    3000,
  );
  check("(A0) turn A settled done", a.status === "done", `status=${a.status}`);

  const [asstA] = await q(
    "select parts from messages where conversation_id=$1 and role='assistant' order by created_at desc limit 1",
    [convId],
  );
  const partsA = Array.isArray(asstA?.parts) ? asstA.parts : [];
  const typesA = [...new Set(partsA.map((p) => p.type))];
  const toolCallsA = partsA.filter((p) => p.type === "tool-call");
  const toolResA = partsA.filter((p) => p.type === "tool-result");
  check(
    "(A1) primary turn emitted tool-call + tool-result parts",
    toolCallsA.length > 0 && toolResA.length > 0,
    `types=${JSON.stringify(typesA)} calls=${toolCallsA.map((c) => c.toolName).join(",") || "none"}`,
  );

  // ── Turn B — delegation path ──────────────────────────────────────────
  const b = await runTurn(
    convId,
    auth,
    "Délègue au sous-agent 'explore' une recherche : ce que tu trouves en mémoire sur Kimi K3. Utilise l'outil task avec subagent='explore'. Puis résume ce qu'il rapporte.",
    4000,
  );
  check("(B0) turn B settled done", b.status === "done", `status=${b.status}`);

  const taskRows = await q(
    "select payload from messages where conversation_id=$1 and message_type='task'",
    [convId],
  );
  check(
    "(B1) a task card row was created in the parent",
    taskRows.length > 0,
    `cards=${taskRows.length} agents=${taskRows.map((r) => r.payload?.agent).join(",") || "none"}`,
  );

  const subConvs = await q(
    "select id, agent_name from conversations where parent_id=$1",
    [convId],
  );
  let subParts = 0;
  if (subConvs.length) {
    const [subAsst] = await q(
      "select parts from messages where conversation_id=$1 and role='assistant' order by created_at desc limit 1",
      [subConvs[0].id],
    );
    subParts = Array.isArray(subAsst?.parts) ? subAsst.parts.length : 0;
  }
  check(
    "(B2) sub-conversation spawned with its own parts",
    subConvs.length > 0 && subParts > 0,
    `subConvs=${subConvs.length} agent=${subConvs[0]?.agent_name ?? "none"} subParts=${subParts}`,
  );

  const events = await q(
    "select type from run_events where conversation_id=$1 order by created_at asc",
    [convId],
  );
  const evTypes = events.map((e) => e.type);
  check(
    "(B3) run_events fired for the delegation (task_started → task_done)",
    evTypes.includes("task_started") && (evTypes.includes("task_done") || evTypes.includes("task_error")),
    `events=${JSON.stringify(evTypes)}`,
  );
} catch (err) {
  check("smoke crashed", false, err.message);
} finally {
  if (convId) {
    const subs = await q("select id from conversations where parent_id=$1", [convId]).catch(() => []);
    for (const s of subs) await q("delete from conversations where id=$1", [s.id]).catch(() => {});
    await q("delete from conversations where id=$1", [convId]).catch(() => {});
  }
  if (tokenId) await q("update hermes_tokens set revoked_at=now() where id=$1", [tokenId]).catch(() => {});
  await pool.end().catch(() => {});
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass} pass / ${results.length - pass} fail`);
process.exit(pass === results.length ? 0 : 1);
