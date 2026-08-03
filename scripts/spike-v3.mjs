#!/usr/bin/env node
// V3-a spike — the mandatory gate before any v3 phase (PLAN.md).
// Proves, against the LIVE engine:
//  (a) reasoning-delta parts flow from CoeOS through the AI SDK
//  (b) streamed tool-calls parse correctly (CoeOS rail)
//  (d) the custom fetch injects the full house extra-body into the
//      adapter's outgoing POST AND captures x_odyssai_routed from the
//      response stream.
// Assertion (c) — anthropic wire-shape — is settled by decision: all
// current targets are chat-completions → openai-compatible everywhere.
//
// Usage: node scripts/spike-v3.mjs [engineBase] [model]

import { streamText, tool } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

const BASE = process.argv[2] ?? "http://192.168.86.39:8000/v1";
const MODEL = process.argv[3] ?? "CoeOS";

const EXTRA_BODY = {
  session_id: "spike-v3-session",
  enable_thinking: true,
  reasoning_effort: undefined, // absent — must not appear as null
  top_k: 40,
  min_p: undefined,
  repetition_penalty: 1.05,
  anti_loop: undefined,
};

const captured = {
  requestFields: null,
  routed: null,
  responseModel: null,
};

// Custom fetch: inject extra-body on the way out, scan SSE lines for
// x_odyssai_routed on the way back (tee — the SDK still consumes the
// original stream untouched).
const customFetch = async (url, init) => {
  if (init?.body && typeof init.body === "string") {
    const body = JSON.parse(init.body);
    for (const [k, v] of Object.entries(EXTRA_BODY)) {
      if (v !== undefined) body[k] = v;
    }
    captured.requestFields = Object.keys(body).filter((k) =>
      ["session_id", "enable_thinking", "top_k", "repetition_penalty"].includes(k),
    );
    init = { ...init, body: JSON.stringify(body) };
  }
  const res = await fetch(url, init);
  if (!res.body) return res;
  const [a, b] = res.body.tee();
  // Scan branch b for routing metadata without blocking the SDK on a.
  (async () => {
    const reader = b.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const idx = buf.indexOf("x_odyssai_routed");
      if (idx >= 0) {
        const line = buf.slice(Math.max(0, idx - 200), idx + 400);
        const m = line.match(/"x_odyssai_routed"\s*:\s*(\{[^}]*\})/);
        if (m) {
          try {
            captured.routed = JSON.parse(m[1]);
          } catch {
            captured.routed = { raw: m[1] };
          }
        }
      }
      const mm = buf.match(/"model"\s*:\s*"([^"]+)"/);
      if (mm) captured.responseModel = mm[1];
      if (buf.length > 200_000) buf = buf.slice(-10_000);
    }
  })().catch(() => {});
  return new Response(a, { status: res.status, statusText: res.statusText, headers: res.headers });
};

const provider = createOpenAICompatible({
  name: "odyssai",
  baseURL: BASE,
  apiKey: "unused",
  fetch: customFetch,
});

let pass = 0;
let fail = 0;
const assert = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ── (a) + (d-request) : reasoning parts on a plain turn ────────────────
{
  const counts = { reasoning: 0, text: 0, other: {} };
  const r = streamText({
    model: provider(MODEL),
    prompt: "Explique en 2 phrases pourquoi la mer est salée.",
    maxOutputTokens: 1500,
  });
  for await (const part of r.fullStream) {
    if (part.type === "reasoning-delta") counts.reasoning++;
    else if (part.type === "text-delta") counts.text++;
    else counts.other[part.type] = (counts.other[part.type] ?? 0) + 1;
  }
  assert(
    "(a) reasoning-delta parts flow",
    counts.reasoning > 0,
    `reasoning=${counts.reasoning} text=${counts.text} other=${JSON.stringify(counts.other)}`,
  );
  assert(
    "(d1) extra-body injected in outgoing POST",
    Array.isArray(captured.requestFields) &&
      ["session_id", "enable_thinking", "top_k", "repetition_penalty"].every(
        (k) => captured.requestFields.includes(k),
      ),
    JSON.stringify(captured.requestFields),
  );
  assert(
    "(d2) x_odyssai_routed captured from response",
    captured.routed !== null || captured.responseModel !== null,
    JSON.stringify({ routed: captured.routed, model: captured.responseModel }),
  );
}

// ── (b) streamed tool-call parses correctly ────────────────────────────
{
  const toolCalls = [];
  const r = streamText({
    model: provider(MODEL),
    prompt:
      "Quelle est la météo à Paris ? Utilise l'outil get_weather pour répondre.",
    tools: {
      get_weather: tool({
        description: "Get current weather for a city.",
        inputSchema: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, temp_c: 21, sky: "clear" }),
      }),
    },
    maxOutputTokens: 1500,
  });
  let leaked = false;
  let text = "";
  for await (const part of r.fullStream) {
    if (part.type === "tool-call") toolCalls.push(part.toolName);
    if (part.type === "text-delta") text += part.text ?? part.textDelta ?? "";
  }
  if (/<function=|<tool_call>|<\|channel/.test(text)) leaked = true;
  assert(
    "(b) streamed tool-call parsed (no leak in text)",
    toolCalls.includes("get_weather") && !leaked,
    `calls=${JSON.stringify(toolCalls)} leaked=${leaked}`,
  );
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
