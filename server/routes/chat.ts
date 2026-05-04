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
import { logAuthEvent, reqMeta } from "../lib/auth-log";
import { incrementGuestUsage } from "../lib/guest-token";
import { authHeaders } from "../lib/litellm";
import { getMemoryContext } from "../lib/memory";
import { buildTag } from "../lib/timetag";
import type { GuestTokenContext } from "../lib/guest-token";
import { resolveExoEndpoint } from "./addon-exo";
import {
  executeTool,
  isHermesEnabled,
  isWebSearchEnabled,
  toolsForUser,
  type ToolResult,
} from "../lib/tools";

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
  const guest: GuestTokenContext | undefined = c.get("guest");

  // Guest budget pre-check — short-circuit before we stream anything.
  // tokenBudget = 0 means unlimited.
  if (guest && guest.tokenBudget > 0 && guest.tokensUsed >= guest.tokenBudget) {
    return c.json({ error: "guest_budget_exceeded" }, 429);
  }

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

  // ── 2. Resolve target — LiteLLM by default, EXO direct when the model
  //       carries the `exo-direct/<endpointId>/<modelId>` prefix.
  //       Direct mode skips LiteLLM entirely so we can A/B latency.
  const isExoDirect = body.model.startsWith("exo-direct/");
  let exoEndpoint: { baseUrl: string } | null = null;
  if (isExoDirect) {
    const rest = body.model.slice("exo-direct/".length);
    const slash = rest.indexOf("/");
    if (slash <= 0) {
      return c.json({ error: "exo_direct_bad_id" }, 400);
    }
    const endpointId = rest.slice(0, slash);
    const ep = await resolveExoEndpoint(userId, endpointId);
    if (!ep) {
      return c.json(
        { error: "exo_direct_unconfigured", detail: "endpoint not found or disabled" },
        400,
      );
    }
    exoEndpoint = { baseUrl: ep.baseUrl };
    body.model = rest.slice(slash + 1); // raw EXO model id
  }
  const target = isExoDirect && exoEndpoint
    ? { baseUrl: exoEndpoint.baseUrl, apiKey: null }
    : {
        baseUrl: (
          userRow.litellmUrl ?? process.env.LITELLM_URL ?? "http://192.168.86.44:4000"
        ).replace(/\/+$/, ""),
        apiKey: userRow.litellmApiKey ?? process.env.LITELLM_API_KEY ?? null,
      };

  // ── 3. Resolve project + memory snapshot (frozen per-conversation) ────
  // The memory wiki is snapshot at conversation creation (or on explicit
  // "Remember now") and reused as-is on every turn. This keeps the system-
  // prompt prefix byte-stable across turns so EXO's KV prefix cache hits,
  // and prevents the model's "memory" from drifting mid-conversation.
  // For pre-snapshot conversations (created before this feature), we lazily
  // backfill the snapshot on first chat so the same stability kicks in from
  // turn 2 onwards.
  let projectId: string | null = null;
  let memoryBlock = "";
  if (body.conversationId) {
    try {
      const [conv] = await db
        .select({
          projectId: conversations.projectId,
          userId: conversations.userId,
          memorySnapshot: conversations.memorySnapshot,
          memoryEnabled: conversations.memoryEnabled,
        })
        .from(conversations)
        .where(eq(conversations.id, body.conversationId))
        .limit(1);
      if (conv && conv.userId === userId) {
        projectId = conv.projectId;
        // Memory toggle (per-conversation, inherited from project at creation):
        // when off, do not inject the wiki into the system prompt at all.
        if (conv.memoryEnabled === false) {
          memoryBlock = "";
        } else if (conv.memorySnapshot != null) {
          memoryBlock = conv.memorySnapshot;
        } else {
          // Lazy backfill — fetch once, persist, reuse from now on.
          memoryBlock = await getMemoryContext(userId, projectId);
          await db
            .update(conversations)
            .set({
              memorySnapshot: memoryBlock || null,
              memorySnapshotAt: memoryBlock ? new Date() : null,
            })
            .where(eq(conversations.id, body.conversationId));
        }
      }
    } catch (err) {
      console.warn("[chat] memory lookup failed:", (err as Error).message);
    }
  }

  // ── 4. Inject time tags into user messages ────────────────────────────
  //
  // Every user message is tagged the SAME way regardless of whether it's
  // historical or being sent now. This is the only way the tag of a given
  // message stays byte-identical across turns — once it's tagged at turn
  // T (when it's the latest), turn T+1 sees it as historical and must
  // reconstruct the same tag.
  //
  // Rules (apply identically to latest + historical):
  //   stamp    = m.createdAt (frontend always provides it for user msgs)
  //   previous = previous user message's createdAt within this payload
  //              (= lastUserAt at the moment we encounter this msg)
  //
  // Nothing depends on the volatile `userRow.lastInteractionAt` anymore:
  // including it would cause the latest msg's tag at turn T to differ
  // from its historical re-rendering at turn T+1.
  const tz = userRow.timezone || "Europe/Brussels";
  const taggedMessages: IncomingMessage[] = [];
  let lastUserAt: Date | null = null;

  for (const m of body.messages) {
    if (m.role !== "user") {
      taggedMessages.push(m);
      continue;
    }
    const stamp = m.createdAt ? new Date(m.createdAt) : now;
    const previous = lastUserAt;
    const tag = buildTag({ now: stamp, previous, timezone: tz });
    taggedMessages.push({
      ...m,
      content: prependTagToContent(m.content, tag),
    });
    lastUserAt = stamp;
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

  // ── 6. Build upstream body (without `messages` — set per iteration below)
  const baseBody: Record<string, unknown> = {
    model: body.model,
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
    if (v !== undefined) baseBody[k] = v;
  }
  if (body.thinking) baseBody.enable_thinking = true;
  if (body.thinking && body.reasoning_effort)
    baseBody.reasoning_effort = body.reasoning_effort;
  // EXO Direct path bypasses LiteLLM, so it doesn't get LiteLLM's per-model
  // defaults (which is where we baked enable_thinking=false for `big`).
  // Force it off here unless the user explicitly enabled thinking — Qwen
  // and friends default to thinking ON otherwise, which burns 1-3k tokens
  // of pre-answer reasoning the user doesn't want.
  if (isExoDirect && !body.thinking) baseBody.enable_thinking = false;

  // Clamp max_tokens to the provider's published ceiling so we don't get
  // 400s from the upstream. Local models served by exo/Inferencer don't
  // need a clamp — they use whatever they accept and bail gracefully.
  if (typeof baseBody.max_tokens === "number") {
    const cap = maxTokensCap(body.model);
    if (cap !== null && baseBody.max_tokens > cap) {
      console.warn(
        "[chat] clamping max_tokens %d → %d for model %s",
        baseBody.max_tokens,
        cap,
        body.model,
      );
      baseBody.max_tokens = cap;
    }
  }

  // Tool add-ons: when enabled (and the model is tool-capable), the chat
  // route forwards tools so the model can decide when to call them. Each
  // add-on contributes its own tools — see toolsForUser.
  //
  // exo's MLX runner currently aborts (SIGABRT) when handed a `tools:`
  // param even for tool-trained models, so we whitelist by model name.
  const anyToolEnabled =
    ((await isWebSearchEnabled(userId)) || (await isHermesEnabled(userId))) &&
    modelSupportsTools(body.model);
  const tools = anyToolEnabled ? await toolsForUser(userId) : [];
  const toolsEnabled = tools.length > 0;

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
    let conversation: ChatTurn[] = withSystem as ChatTurn[];
    const MAX_TOOL_ITERATIONS = 3;
    // Aggregate usage across tool-loop iterations — guests are billed for
    // every upstream call, not just the final one.
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalChunkCount = 0;
    let sawUpstreamUsage = false;

    try {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const requestBody = {
          ...baseBody,
          messages: conversation,
          ...(toolsEnabled ? { tools, tool_choice: "auto" } : {}),
        };

        // Debug: hash both the conversation prefix AND the actual body
        // sent to EXO. The first reveals our internal prompt drift, the
        // second reveals if any non-message field (params, headers, body
        // ordering, tools schema) is breaking the EXO-side cache key.
        const bodyJson = JSON.stringify(requestBody);
        if (process.env.DEBUG_PROMPT_HASH === "1") {
          const { createHash } = await import("node:crypto");
          const parts: string[] = [];
          for (let k = 1; k <= conversation.length; k++) {
            const sub = JSON.stringify(conversation.slice(0, k));
            const h = createHash("sha256")
              .update(sub)
              .digest("hex")
              .slice(0, 10);
            parts.push(`${k}:${conversation[k - 1].role[0]}=${h}`);
          }
          const fullJson = JSON.stringify(conversation);
          const bodyHash = createHash("sha256")
            .update(bodyJson)
            .digest("hex")
            .slice(0, 10);
          // Hash the body without the LAST message — should be byte-stable
          // across consecutive turns of the same conversation.
          const bodyMinusLast = JSON.stringify({
            ...requestBody,
            messages: conversation.slice(0, -1),
          });
          const bodyPrefixHash = createHash("sha256")
            .update(bodyMinusLast)
            .digest("hex")
            .slice(0, 10);
          console.log(
            `[chat:prompt-hash] msgs=${conversation.length} bytes=${fullJson.length} bodyBytes=${bodyJson.length} body=${bodyHash} bodyPrefix=${bodyPrefixHash} ${parts.join(" ")}`,
          );
        }

        const upstream = await fetch(
          `${target.baseUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers,
            body: bodyJson,
          },
        );

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => "");
          const err = `${upstream.status} ${upstream.statusText}: ${text.slice(0, 200)}`;
          console.error("[chat] upstream not ok:", err);
          await writer.write(
            encoder.encode(`data: ${JSON.stringify({ error: err })}\n\n`),
          );
          break;
        }

        const { toolCalls, finishReason, assistantContent, usage, chunkCount } =
          await pipeAndCollect(upstream, writer, encoder);
        totalChunkCount += chunkCount;
        if (usage) {
          sawUpstreamUsage = true;
          totalPromptTokens += usage.promptTokens;
          totalCompletionTokens += usage.completionTokens;
        }

        if (
          toolsEnabled &&
          finishReason === "tool_calls" &&
          toolCalls.length > 0
        ) {
          // Notify the client visually (the parser ignores `_event` shape).
          await writer.write(
            encoder.encode(
              `data: ${JSON.stringify({
                _event: "tool_start",
                calls: toolCalls.map((tc) => ({
                  name: tc.name,
                  args: tryParseJson(tc.argumentsRaw),
                })),
              })}\n\n`,
            ),
          );

          // Execute tools in parallel
          const results = await Promise.all(
            toolCalls.map((tc) =>
              executeTool(tc.name, tryParseJson(tc.argumentsRaw), userId),
            ),
          );

          await writer.write(
            encoder.encode(
              `data: ${JSON.stringify({
                _event: "tool_done",
                calls: toolCalls.map((tc, i) => ({
                  name: tc.name,
                  result: summarizeResult(results[i]),
                })),
              })}\n\n`,
            ),
          );

          // Append assistant tool_calls + tool results to history for next iter
          conversation = [
            ...conversation,
            {
              role: "assistant",
              content: assistantContent || null,
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: tc.argumentsRaw,
                },
              })),
            },
            ...toolCalls.map((tc, i) => ({
              role: "tool" as const,
              tool_call_id: tc.id,
              content: stringifyForTool(results[i]),
            })),
          ];
          // Loop again — the model will integrate tool results into a final
          // answer (or call more tools).
          continue;
        }
        // Either no tools requested, or finish_reason !== "tool_calls" → done.
        break;
      }
      // End-of-stream marker for the client parser
      await writer.write(encoder.encode("data: [DONE]\n\n"));

      // Guest accounting — bill the token, log the use. We do this after
      // the stream has fully drained so we have the real usage numbers.
      if (guest) {
        // Fallback: when upstream didn't report `usage` (older EXO, some
        // local engines), use the chunk count as a coarse proxy. Each
        // streamed delta is ~1 token in practice for OpenAI-compat servers.
        const completionTokens = sawUpstreamUsage
          ? totalCompletionTokens
          : totalChunkCount;
        try {
          await incrementGuestUsage(guest.id, completionTokens);
        } catch (err) {
          console.error("[chat] guest usage increment failed:", err);
        }
        const meta = reqMeta(c);
        logAuthEvent({
          userId: guest.createdBy,
          event: "guest.use",
          ip: meta.ip,
          userAgent: meta.userAgent,
          meta: {
            tokenId: guest.id,
            promptTokens: sawUpstreamUsage ? totalPromptTokens : null,
            completionTokens,
            usageReported: sawUpstreamUsage,
          },
        });
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

// ── Tool-call streaming infrastructure ─────────────────────────────────────

/** A row in the OpenAI-shaped messages array. We don't have to be strict —
 *  LiteLLM forwards extra fields like tool_calls or tool_call_id to its
 *  model adapters. */
type ChatTurn =
  | IncomingMessage
  | {
      role: "assistant";
      content: string | ContentPart[] | null;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

type AccumulatedToolCall = {
  id: string;
  name: string;
  /** Tool args stream as JSON string fragments — we accumulate then parse. */
  argumentsRaw: string;
};

/**
 * Read a streaming chat-completions response, forward most chunks to the
 * client verbatim (so content + reasoning stream through naturally), and
 * pull out any tool_calls + finish_reason so the outer loop can react.
 *
 * Filters two kinds of upstream events:
 *   - `data: [DONE]` — we suppress these between iterations (and emit
 *     exactly one at the very end of the conversation).
 *   - tool_calls deltas — we don't strip them from the forwarded stream;
 *     the client parser already ignores fields it doesn't know about, so
 *     they're harmless. We just *also* parse them server-side.
 */
async function pipeAndCollect(
  upstream: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
): Promise<{
  toolCalls: AccumulatedToolCall[];
  finishReason: string | null;
  assistantContent: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  chunkCount: number;
}> {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const tcByIndex = new Map<number, AccumulatedToolCall>();
  let finishReason: string | null = null;
  let assistantContent = "";
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let chunkCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    buf += chunkText;

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    // Re-emit lines we want the client to see, line by line; suppress [DONE].
    const out: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (t === "data: [DONE]" || t === "data:[DONE]") {
        // suppress — we'll emit our own [DONE] at the very end
        continue;
      }
      out.push(line);

      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
          };
        };
        if (parsed.usage) {
          usage = {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
          };
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          assistantContent += choice.delta.content;
          chunkCount += 1;
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = tcByIndex.get(idx) ?? {
              id: "",
              name: "",
              argumentsRaw: "",
            };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.argumentsRaw += tc.function.arguments;
            tcByIndex.set(idx, acc);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      } catch {
        // ignore malformed payloads
      }
    }

    if (out.length > 0) {
      await writer.write(encoder.encode(out.join("\n") + "\n"));
    }
  }

  return {
    toolCalls: Array.from(tcByIndex.values()).filter((tc) => tc.name),
    finishReason,
    assistantContent,
    usage,
    chunkCount,
  };
}

/**
 * Heuristic: does this model accept the OpenAI-style `tools:` parameter
 * without crashing the upstream? Currently:
 *
 *   - Anthropic family (claude-*, anthropic/*) — yes, native tool use.
 *   - OpenAI family (gpt-*, openai/*) — yes, native function calling.
 *   - Anything else served by exo — NO. exo's MLX runner aborts (signal 6)
 *     on `tools:` even for tool-trained models like GLM-5.1.
 *
 * When this returns false, the chat route silently drops the tools param
 * even if the Web Search add-on is enabled, so picking GLM in the model
 * picker doesn't 500 the conversation. The user just doesn't get
 * web_search/web_fetch on that model — they'd switch to claude-* to use it.
 */
function modelSupportsTools(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("claude") || m.startsWith("anthropic/")) return true;
  if (m.startsWith("gpt-") || m.startsWith("openai/")) return true;
  return false;
}

/**
 * Per-provider max_tokens ceiling. Returns null when the model is local
 * (we let exo/Inferencer enforce their own limits). Heuristic on the
 * model id surfaced through LiteLLM:
 *
 *   "claude-haiku"               → Anthropic alias        → 64k
 *   "anthropic/claude-haiku-4-5" → Anthropic passthrough  → 64k
 *   "claude-sonnet"              → Anthropic alias        → 64k
 *   "gpt-4o" / "openai/..."      → OpenAI                 → 16k
 *   anything else                → local                  → no clamp
 */
function maxTokensCap(model: string): number | null {
  const m = model.toLowerCase();
  if (m.startsWith("anthropic/") || m.includes("claude")) return 64_000;
  if (m.startsWith("openai/") || m.startsWith("gpt-")) return 16_384;
  return null;
}

function tryParseJson(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Serialize a tool result so the LLM sees consistent JSON. Truncates very
 *  large bodies (Tavily extract can return huge raw_content) so we don't blow
 *  up the next round-trip's prompt budget. */
function stringifyForTool(r: ToolResult): string {
  if (!r.ok) return JSON.stringify({ error: r.error });
  const json = JSON.stringify(r.data);
  // 24k chars ≈ 6k tokens — generous but bounded.
  return json.length > 24_000 ? json.slice(0, 24_000) + "…[truncated]" : json;
}

/** A short summary of a tool result to display in the UI without blowing up
 *  the SSE stream. The full payload is fed back to the LLM separately. */
function summarizeResult(
  r: ToolResult,
): { ok: boolean; summary: string; sources?: Array<{ title: string; url: string }> } {
  if (!r.ok) return { ok: false, summary: r.error };
  const data = r.data as
    | { results?: Array<{ title: string; url: string }>; query?: string }
    | { url?: string; content?: string }
    | {
        content?: string;
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
        };
      };
  // Hermes Agent (native gateway) — chat completion-style result.
  if ("content" in data && typeof data.content === "string" && "usage" in data) {
    const u = data.usage ?? {};
    const tot = (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
    const len = data.content.length;
    return {
      ok: true,
      summary: `${len.toLocaleString()} chars · ${tot.toLocaleString()} tok`,
    };
  }
  // Tavily search
  if ("results" in data && Array.isArray(data.results)) {
    return {
      ok: true,
      summary: `${data.results.length} result${data.results.length === 1 ? "" : "s"}`,
      sources: data.results.slice(0, 5).map((r) => ({
        title: r.title,
        url: r.url,
      })),
    };
  }
  // Tavily extract
  if ("url" in data && data.url) {
    const len = (data as { content?: string }).content?.length ?? 0;
    return {
      ok: true,
      summary: `Fetched ${len.toLocaleString()} chars from ${data.url}`,
      sources: [{ title: data.url, url: data.url }],
    };
  }
  return { ok: true, summary: "done" };
}

export default chatRoute;
