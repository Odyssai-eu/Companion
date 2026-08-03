#!/usr/bin/env node
// v2.1 P0/P4 — canonical agentic eval through CoeOS (PLAN.md).
//
// Replays 6 canonical tasks against the dev instance over the normal
// chat API (bearer hms_ token), waits for each turn to finish, then
// pulls conversation + spans to judge. Output: a per-task table with
// the CoeOS axis/model actually used and the exact failure mode
// (leak-channel, leak-function-xml, roleplay, no-tool, ok).
//
// Usage: COMPANION_TOKEN=hms_… node scripts/eval-agents.mjs [baseUrl]

const BASE = process.argv[2] ?? "http://192.168.86.39:3100";
const TOKEN = process.env.COMPANION_TOKEN;
if (!TOKEN) {
  console.error("COMPANION_TOKEN required");
  process.exit(1);
}
const H = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${TOKEN}`,
};

const TASKS = [
  {
    id: "T1-memory",
    prompt:
      "Cherche dans ma mémoire ce qu'on a décidé sur le routing TTS et résume-le.",
    expect: { toolCalled: true },
  },
  {
    id: "T2-multitool",
    prompt:
      "Liste les fichiers de mon workspace, lis le plus récent, et dis-moi en deux phrases ce qu'il contient.",
    expect: { toolCalled: true },
  },
  {
    id: "T3-write",
    prompt:
      "Écris un fichier notes/eval-check.md dans mon workspace contenant la date du jour et une ligne 'eval ok'. Confirme le chemin écrit.",
    expect: { toolCalled: true },
  },
  {
    id: "T4-delegate-explore",
    prompt:
      "Compare ce que disent ma mémoire ET mes fichiers workspace sur le projet Companion, et fais-m'en une synthèse sourcée.",
    expect: { taskSpawned: true },
  },
  {
    id: "T5-delegate-writer",
    prompt:
      "Fais-moi un rapport complet (structure + sections) sur l'état du projet Companion, écrit dans mon workspace sous reports/companion-etat.md.",
    expect: { taskSpawned: true },
  },
  {
    id: "T6-error-recovery",
    prompt:
      "Lis le fichier workspace/inexistant-xyz.md ; s'il n'existe pas, dis-le clairement et liste ce qui existe à la place.",
    expect: { toolCalled: true },
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createConv(title) {
  const r = await fetch(`${BASE}/api/conversations`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ title, agentMode: true, memoryEnabled: true }),
  });
  if (!r.ok) throw new Error(`createConv ${r.status}`);
  return (await r.json()).conversation;
}

async function sendTurn(convId, prompt) {
  // Fire the SSE turn and drain it fully (server persists at the end).
  const r = await fetch(`${BASE}/api/chat/completions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      conversationId: convId,
      model: "auto",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
    }),
  });
  if (!r.ok) return { httpError: `${r.status} ${await r.text().catch(() => "")}` };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let raw = "";
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += dec.decode(value, { stream: true });
  }
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const p = line.slice(6).trim();
    if (p === "[DONE]") continue;
    try {
      events.push(JSON.parse(p));
    } catch {
      /* partial */
    }
  }
  return { events };
}

async function getConv(convId) {
  const r = await fetch(`${BASE}/api/conversations/${convId}`, { headers: H });
  if (!r.ok) return null;
  return r.json();
}

function judge(task, turn, conv) {
  const verdict = {
    id: task.id,
    ok: false,
    mode: "?",
    toolEvents: 0,
    tasks: 0,
    routed: null,
    model: null,
    notes: "",
  };
  if (turn.httpError) {
    verdict.mode = `http:${turn.httpError.slice(0, 60)}`;
    return verdict;
  }
  const toolStarts = turn.events.filter((e) => e._event === "tool_start");
  verdict.toolEvents = toolStarts.reduce(
    (n, e) => n + (e.calls?.length ?? 0),
    0,
  );
  const err = turn.events.find((e) => e.error);
  const msgs = conv?.messages ?? [];
  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
  const content = lastAssistant?.content ?? "";
  verdict.model = lastAssistant?.stats?.model ?? null;
  verdict.routed =
    lastAssistant?.stats?.routedLabel ?? lastAssistant?.stats?.routedFrom ?? null;
  verdict.tasks = msgs.filter((m) => m.messageType === "task").length;

  // Failure-mode detection on the persisted content.
  if (/<\|channel\|?>|<\|channel>/.test(content)) verdict.mode = "leak-channel";
  else if (/<function=|<tool_call>|<\/tool_call>/.test(content))
    verdict.mode = "leak-function-xml";
  else if (/"tool_name"\s*:|```json[\s\S]*tool_input/.test(content) && verdict.toolEvents === 0)
    verdict.mode = "roleplay";
  else if (err) verdict.mode = `stream-error:${String(err.error).slice(0, 50)}`;
  else if (task.expect.taskSpawned && verdict.tasks === 0)
    verdict.mode = "no-delegation";
  else if (task.expect.toolCalled && verdict.toolEvents === 0 && verdict.tasks === 0)
    verdict.mode = "no-tool";
  else if (!content.trim()) verdict.mode = "empty-answer";
  else {
    verdict.mode = "ok";
    verdict.ok = true;
  }
  return verdict;
}

const results = [];
for (const task of TASKS) {
  process.stderr.write(`\n▶ ${task.id} … `);
  try {
    const conv = await createConv(`[eval] ${task.id}`);
    const turn = await sendTurn(conv.id, task.prompt);
    await sleep(1500); // persistence settle
    const full = await getConv(conv.id);
    const v = judge(task, turn, full);
    results.push(v);
    process.stderr.write(`${v.mode}${v.ok ? " ✓" : " ✗"}`);
  } catch (e) {
    results.push({ id: task.id, ok: false, mode: `harness:${e.message}` });
    process.stderr.write(`harness error: ${e.message}`);
  }
}

console.log("\n\n| Task | OK | Mode | Tools | Tasks | Model | Routed |");
console.log("|---|---|---|---|---|---|---|");
for (const r of results) {
  console.log(
    `| ${r.id} | ${r.ok ? "✓" : "✗"} | ${r.mode} | ${r.toolEvents ?? "-"} | ${r.tasks ?? "-"} | ${r.model ?? "-"} | ${r.routed ?? "-"} |`,
  );
}
const pass = results.filter((r) => r.ok).length;
console.log(`\n${pass}/${TASKS.length} pass`);
process.exit(pass === TASKS.length ? 0 : 1);
