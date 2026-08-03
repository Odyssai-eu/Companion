// Streaming chat worker (tool-loop + non-stream synth + persist) extracted
// from chat.ts (#31 WU1). Verbatim move.

import type { Context } from "hono";
// Both `fetch` and `Agent` must come from the SAME undici instance — Node's
// built-in `fetch` uses its internal undici (different version), whose
// Dispatcher interface (onRequestStart, …) doesn't match the userland
// `undici@8.x` package. Passing one's Agent to the other's fetch throws
// `UND_ERR_INVALID_ARG: invalid onRequestStart method`. The fix is to use
// undici's own fetch with undici's own Agent.
import { Agent, fetch as undiciFetch } from "undici";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { conversations, messages } from "../db/schema";
import { logAuthEvent, reqMeta } from "../lib/auth-log";
import { incrementGuestUsage } from "../lib/guest-token";
import { registerInactivityCompile } from "../lib/memory-scheduler";
import { resolveModelLabel } from "../lib/model-policy";
import {
  appendInferenceContent,
  deleteInference,
  finishInference,
  markInferenceError,
} from "../lib/inference-state";
import { executeTool } from "../lib/tools";
import { newTurnBudget, runTask } from "../lib/task-runner";
import { emitRunEvent } from "../lib/run-events";
import { pipeAndCollect, collectNonStream, stringifyForTool, summarizeResult } from "../lib/stream-collector";
import type { GuestTokenContext } from "../lib/guest-token";
import type { OdyssaiModelCapabilities } from "../lib/odyssai-contract";
import type { ChatBody, ChatTurn, Env } from "../routes/chat";
import type { GuardVerdict } from "../lib/guard";

// Dedicated undici Agent for upstream LLM calls. Node's default global
// dispatcher has `bodyTimeout: 300_000` (5 min) which is too short for big
// prefills — observed symptom: Hy3-preview on Argo with a ~30k token wiki
// injection times out mid-prefill, undici aborts the socket with
// UND_ERR_BODY_TIMEOUT, finishInference never runs, and the client sees
// a "ghost answer" (the partial response disappears on reload because
// nothing got persisted to the DB).
//
// We disable bodyTimeout entirely (0 = no timeout). headersTimeout was
// 60s but that's too tight for the tools+jaccl path: `shouldUseNonStream`
// forces `stream: false` to avoid the XML tool-call leak on Qwen3/Hy3,
// and OdyssAI-X then doesn't send any HTTP headers until the entire
// response is generated. On slow models (GLM-5.1 on 4-node pipeline-AP
// at ~7 tok/s with max_tokens 64k) that's >> 60s before first byte and
// undici fails the fetch with HeadersTimeoutError before generation
// completes. Bump to 600s (10 min) — generous for non-stream paths,
// invisible for streaming paths which see their first byte in <5s
// regardless. The chat route's heartbeat + finishInference cleanup
// still catches genuine dead connections.
const upstreamDispatcher = new Agent({
  connect: { timeout: 10_000 },   // 10s to TCP+TLS connect
  headersTimeout: 600_000,         // 10 min — generous for non-stream slow models
  bodyTimeout: 0,                  // unbounded body — long prefills OK
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

function tryParseJson(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Everything the streaming worker reads from the route handler's scope.
 * The worker is a verbatim move of the fire-and-forget IIFE that used to
 * live inline in `chatRoute.post("/completions")` — these fields are the
 * handler-local closures it captured. Module-level deps (imports above)
 * are NOT threaded through ctx.
 */
export type ChatStreamCtx = {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  encoder: TextEncoder;
  safeWrite: (data: Uint8Array) => Promise<void>;
  heartbeat: ReturnType<typeof setInterval>;
  withSystem: ChatTurn[];
  baseBody: Record<string, unknown>;
  tools: unknown[];
  toolsEnabled: boolean;
  agentToolsEnabled: boolean;
  modelCaps: OdyssaiModelCapabilities | null;
  target: { baseUrl: string; apiKey: string | null };
  headers: Record<string, string>;
  userId: string;
  projectCwd: string | null;
  /** Resolved default model (user override ∘ instance) — the task
   *  runner's last-resort fallback when the parent model is 'auto'. */
  defaultModel: string | null;
  /** The memory actually injected this turn (#36 transparency). Both can be
   *  "" when nothing was injected. `memoryBlock` = the stable per-conversation
   *  wiki/vault prefix (system prompt); `ragBlock` = the per-turn semantic
   *  retrieval that rides with the last user message. We only echo their
   *  size + text into the assistant message stats so the user can inspect
   *  exactly what was sent — we do NOT touch the injection itself. */
  memoryBlock: string;
  ragBlock: string;
  body: ChatBody;
  userRow: { debugVerbose: boolean };
  guest: GuestTokenContext | undefined;
  routedDecision:
    | {
        from: string;
        to: string;
        label: string;
        score: number;
        ms: number;
        /** Set only when routing FAILED and `to` is the Auto Router's
         *  configured fallback model. Surfaced to the user as a stream
         *  notice + persisted on the message so it survives a reload. */
        error?: string;
      }
    | null;
  /** Confidential Guard verdict for this turn (null = add-on off or clean).
   *  Emitted to the client as an `_event:"guard_warning"` frame and folded
   *  into the persisted message stats. */
  guardVerdict: GuardVerdict | null;
  convKind: "chat" | "talk";
  convMemoryEnabled: boolean;
  projectGlobalReadOnly: boolean;
  projectDedicatedMemoryEnabled: boolean;
  c: Context<Env>;
};

export async function runChatStream(ctx: ChatStreamCtx): Promise<void> {
  const {
    writer,
    encoder,
    safeWrite,
    heartbeat,
    withSystem,
    baseBody,
    tools,
    toolsEnabled,
    agentToolsEnabled,
    modelCaps,
    target,
    headers,
    userId,
    projectCwd,
    defaultModel,
    memoryBlock,
    ragBlock,
    body,
    userRow,
    guest,
    routedDecision,
    guardVerdict,
    convKind,
    convMemoryEnabled,
    projectGlobalReadOnly,
    projectDedicatedMemoryEnabled,
    c,
  } = ctx;

  // Confidential Guard — surface the verdict to the client immediately,
  // before any upstream byte, so the banner shows while the model streams.
  // (The client SSE parser ignores unknown `_event` frames, so older
  // clients are unaffected.)
  if (guardVerdict?.sensitive) {
    safeWrite(
      encoder.encode(
        `data: ${JSON.stringify({
          _event: "guard_warning",
          severity: guardVerdict.maxSeverity,
          findings: guardVerdict.findings,
          forcedLocal: guardVerdict.forcedLocal ?? false,
          forcedModel: guardVerdict.forcedModel ?? null,
          destinationLocal: guardVerdict.destinationLocal ?? false,
        })}\n\n`,
      ),
    );
  }

  let conversation: ChatTurn[] = withSystem as ChatTurn[];

    // Auto Router fell back → tell the user BEFORE the first token lands.
    // We deliberately don't use the inline `{error: …}` channel here: that
    // one marks the whole stream as failed. This turn is going to succeed,
    // just not on the model the router would have chosen, so it rides its
    // own `notice` event that the client renders as a banner without
    // aborting anything.
    if (routedDecision?.error) {
      await safeWrite(
        encoder.encode(
          `data: ${JSON.stringify({
            _event: "notice",
            level: "warn",
            message: `${routedDecision.error} Answering with the fallback model "${routedDecision.to}" instead.`,
          })}\n\n`,
        ),
      );
    }

    // Max upstream calls in the tool loop. History: 3 → 8 (2026-05-29) → 20.
    // In agent mode the model legitimately needs many rounds — with N distinct
    // tools (Hy3 case: 8 different tools) a real workflow can chain well past 8,
    // and capping at 8 cut the model off mid-task with the misleading loop-guard
    // message even though it was working correctly. This is just a cost/latency
    // ceiling now, NOT the loop's safety: the final iteration forces a closing
    // answer (tool_choice:"none" below), so hitting the cap always yields a
    // real synthesis instead of an error.
    const MAX_TOOL_ITERATIONS = 20;
    // v2.0 delegation guards — ONE budget per primary turn: max 3 tasks,
    // 30 cumulative sub-conversation LLM steps (PLAN.md §4 garde-fous).
    const turnBudget = newTurnBudget();
    // v2.1 P3 — the PRIMARY narrates like a task: its tool chains show as
    // a live working block in the thread (same run_events machinery the
    // sub-conversations use; the UI keys the synthetic card on
    // sub_conversation_id, so the primary uses its own conv id). Ephemeral
    // by design — the durable record is the assistant message itself.
    const primaryNarration = body.conversationId
      ? { rootId: body.conversationId, started: false }
      : null;
    const narrate = (
      type: "task_started" | "step" | "tool_call" | "tool_result" | "task_done",
      payload: Record<string, unknown>,
    ) => {
      if (!primaryNarration) return;
      void emitRunEvent({
        conversationId: primaryNarration.rootId,
        type,
        payload: {
          sub_conversation_id: primaryNarration.rootId,
          agent: "nemo",
          ...payload,
        },
      });
    };
    // Aggregate usage across tool-loop iterations — guests are billed for
    // every upstream call, not just the final one.
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalChunkCount = 0;
    let sawUpstreamUsage = false;
    // CoeOS routing decision + the model the response actually reported, so the
    // StatsRow can show "CoeOS — <employed model>" instead of just "CoeOS".
    let coeosRouted: { routed_to?: string; category?: string; concrete?: string } | null = null;
    let responseModelSeen: string | null = null;

    // Stream/non-stream upstream policy:
    //
    // Most models route through this code path with `stream:true` so the
    // user gets typewriter UX on every token. But local backends (mlx-vlm,
    // Ollama, vLLM, llama.cpp) emit tool_calls correctly only in
    // non-stream mode — in stream they leak the model's native tool-call
    // syntax (e.g. Qwen-XML `<tool_call>...</tool_call>`) into the content
    // delta, and LiteLLM doesn't normalise that. Anthropic and OpenAI
    // handle stream + tools natively.
    //
    // Decision: if tools are enabled AND the model is not Anthropic/OpenAI,
    // we fetch this iteration in non-stream mode and synthesise a single
    // SSE chunk for the client. Subsequent iterations re-evaluate (e.g.
    // the post-tool reply doesn't always need tools).
    const modelLower = (body.model ?? "").toLowerCase();
    /**
     * Decide stream vs. non-stream for the upstream call when tools
     * are enabled. The Odyssai x_odyssai contract tells the truth:
     *
     *   backend=jaccl                            → local distributed MLX
     *                                              (argo, hades, …) — many
     *                                              chat templates leak the
     *                                              model's native tool-call
     *                                              syntax into content when
     *                                              streaming. Non-stream
     *                                              forces an atomic JSON
     *                                              response that the
     *                                              backend's parser can
     *                                              normalise into
     *                                              tool_calls correctly.
     *   backend=http-proxy + pool=openrouter     → cloud, stream OK
     *   backend=http-proxy + other pool          → local mlx-vlm/mlx-coder
     *                                              proxy, same issue as
     *                                              jaccl, force non-stream
     *   backend=null / no caps                   → fall back to the legacy
     *                                              name heuristic
     */
    function shouldUseNonStream(): boolean {
      // Only real agent-mode tools (fs/rag/web/MCP) trigger the XML leak
      // workaround. Skill tools alone stream fine — they're meta-curation,
      // the model doesn't emit them mid-response.
      if (!agentToolsEnabled) return false;
      if (modelCaps) {
        const backend = modelCaps.backend;
        const pool = modelCaps.pool;
        if (backend === "jaccl") return true;
        if (backend === "http-proxy") {
          // Cloud passthrough (OpenRouter) handles stream+tools natively
          if (pool === "openrouter" || pool === "or") return false;
          // Other http-proxy pools are local (mlx-vlm, mlx-coder, …)
          return true;
        }
        // Unknown backend with caps — be conservative, force non-stream
        return true;
      }
      // No caps published — fall back to name heuristic.
      if (modelLower.includes("claude") || modelLower.startsWith("anthropic/")) return false;
      if (modelLower.startsWith("gpt-") || modelLower.startsWith("openai/")) return false;
      return true;
    }

    // Track whether the loop ended via natural break (model produced
    // a final answer or no tools) vs. exhausting MAX_TOOL_ITERATIONS.
    // The latter signals a "tool-call loop" — model keeps emitting
    // tool_calls without ever writing a user-facing summary. We
    // surface a helpful message in that case so the user sees what
    // happened instead of "..." silently disappearing.
    let exitedNaturally = false;
    // Most recent real answer text the model produced across the loop. Used to
    // suppress the loop-guard message when the model DID write a reply but the
    // turn still closed on a tool_calls finish_reason (content + trailing
    // tool_call, or a model that ignores tool_choice:"none"). "Il a tout fini
    // mais erreur à la fin" — don't claim "no answer" when there is one.
    let lastAssistantContent = "";
    try {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const useNonStream = shouldUseNonStream();
        // On the final allowed iteration, forbid further tool calls
        // (tool_choice:"none") so the model MUST write a closing answer from the
        // accumulated results instead of being cut off mid-loop with an error.
        // We keep the `tools` field present (some strict OpenAI-compat backends
        // reject a history containing tool messages when `tools` is absent) and
        // only flip the choice. In agent mode the model can legitimately need
        // many rounds — this guarantees the turn always ends with a real reply.
        const isFinalIteration = iter === MAX_TOOL_ITERATIONS - 1;
        const requestBody = {
          ...baseBody,
          stream: !useNonStream,
          messages: conversation,
          ...(toolsEnabled
            ? { tools, tool_choice: isFinalIteration ? "none" : "auto" }
            : {}),
        };

        // Debug: hash both the conversation prefix AND the actual body
        // sent to EXO. The first reveals our internal prompt drift, the
        // second reveals if any non-message field (params, headers, body
        // ordering, tools schema) is breaking the EXO-side cache key.
        const bodyJson = JSON.stringify(requestBody);
        // Per-user verbose request log. Off by default. Flip via Settings →
        // Inference → Debug. Logs the full upstream body before each POST so
        // we can diagnose tool-call shape, model id resolution, streaming
        // weirdness, etc. Truncated at 8 KiB to keep docker logs sane.
        if (userRow.debugVerbose || process.env.DEBUG_VERBOSE === "1") {
          const preview = bodyJson.length > 8192
            ? bodyJson.slice(0, 8192) + `…[+${bodyJson.length - 8192}B]`
            : bodyJson;
          console.log(
            `[chat:upstream] iter=${iter} target=${target.baseUrl} ` +
            `bytes=${bodyJson.length} body=${preview}`,
          );
        }
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

        const upstream = await undiciFetch(
          `${target.baseUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers,
            body: bodyJson,
            dispatcher: upstreamDispatcher,
          },
        );

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => "");
          const err = `${upstream.status} ${upstream.statusText}: ${text.slice(0, 200)}`;
          console.error("[chat] upstream not ok:", err);
          await safeWrite(
            encoder.encode(`data: ${JSON.stringify({ error: err })}\n\n`),
          );
          break;
        }

        // undici's fetch returns its own Response type; structurally compatible
        // with the global Response that collectNonStream/pipeAndCollect expect.
        const upstreamResp = upstream as unknown as Response;
        const { toolCalls, finishReason, assistantContent, usage, chunkCount, routed, responseModel, loopDetected } =
          useNonStream
            ? await collectNonStream(upstreamResp, writer, encoder, body.conversationId)
            : await pipeAndCollect(upstreamResp, writer, encoder, body.conversationId);
        totalChunkCount += chunkCount;
        if (routed) coeosRouted = routed;
        if (responseModel) responseModelSeen = responseModel;
        // Engine anti-loop tripped: the turn was ended early because the
        // model was cycling. Same non-fatal `notice` rail as the Auto Router
        // fallback — the partial answer above is still real and kept.
        if (loopDetected) {
          await safeWrite(
            encoder.encode(
              `data: ${JSON.stringify({
                _event: "notice",
                level: "warn",
                message:
                  "Generation stopped early — the model was repeating itself " +
                  "in a loop. The answer above is kept up to that point. " +
                  "(Anti-loop can be turned off in Settings → Inference.)",
              })}\n\n`,
            ),
          );
        }
        if (usage) {
          sawUpstreamUsage = true;
          totalPromptTokens += usage.promptTokens;
          totalCompletionTokens += usage.completionTokens;
        }
        // Retain the last non-empty reply (don't reset to "" on pure tool turns).
        if (assistantContent && assistantContent.trim()) {
          lastAssistantContent = assistantContent;
        }

        if (
          toolsEnabled &&
          finishReason === "tool_calls" &&
          toolCalls.length > 0
        ) {
          // Notify the client visually (the parser ignores `_event` shape).
          await safeWrite(
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
          if (primaryNarration && !primaryNarration.started) {
            primaryNarration.started = true;
            narrate("task_started", { description: "Working…" });
          }
          if (assistantContent && assistantContent.trim()) {
            narrate("step", { text: assistantContent.trim().slice(0, 300) });
          }
          for (const tc of toolCalls) {
            narrate("tool_call", { name: tc.name });
          }

          // Execute tools. `task` calls (v2.0 delegation) run
          // SEQUENTIALLY — parallel sub-conversation spawns would stack
          // cold starts on the upstream and starve the SSE heartbeat
          // (PLAN.md F10). Everything else keeps the parallel path.
          const results: Awaited<ReturnType<typeof executeTool>>[] =
            new Array(toolCalls.length);
          const plainIdx: number[] = [];
          for (let i = 0; i < toolCalls.length; i++) {
            if (toolCalls[i].name === "task") {
              const a = tryParseJson(toolCalls[i].argumentsRaw);
              const run = await runTask({
                userId,
                parentConversationId: body.conversationId ?? "",
                subagent: String(a.subagent ?? ""),
                prompt: String(a.prompt ?? ""),
                description: String(a.description ?? ""),
                parentModel: String(baseBody.model ?? ""),
                defaultModel,
                target,
                headers,
                budget: turnBudget,
              });
              results[i] = run.ok
                ? { ok: true, data: { status: run.status, result: run.text, sub_conversation_id: run.subConversationId } }
                : { ok: false, error: run.text };
            } else {
              plainIdx.push(i);
            }
          }
          if (plainIdx.length > 0) {
            const plainResults = await Promise.all(
              plainIdx.map((i) =>
                executeTool(toolCalls[i].name, tryParseJson(toolCalls[i].argumentsRaw), userId, projectCwd),
              ),
            );
            plainIdx.forEach((i, k) => {
              results[i] = plainResults[k];
            });
          }

          await safeWrite(
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
          for (let i = 0; i < toolCalls.length; i++) {
            narrate("tool_result", {
              name: toolCalls[i].name,
              ok: results[i]?.ok ?? false,
            });
          }

          // For workspace-mutating fs_* tools, push a file_changed event so
          // the FilesPage hook (useWorkspaceFiles) can refresh in live.
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const r = results[i];
            if (!r.ok) continue;
            if (tc.name !== "fs_write" && tc.name !== "fs_edit") continue;
            const path = (r.data as { path?: string } | undefined)?.path;
            if (!path) continue;
            await safeWrite(
              encoder.encode(
                `data: ${JSON.stringify({ _event: "file_changed", path })}\n\n`,
              ),
            );
          }

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
        // Ghost guard: if the turn ends with NO assistant content and no
        // tool calls, finishInference would skip persist (it requires
        // inf.content truthy) → the bubble vanishes on reload. This is the
        // recurring "ghost answer": a thinking model streams only
        // `reasoning_content` (captured above into the reasoning channel)
        // and never emits a `content` delta — e.g. thinking is enabled and
        // the turn closes after the reasoning, or it hits the token cap
        // mid-think. Mirror collectNonStream's fallback: emit a short note
        // so the turn persists with something visible instead of ghosting.
        if (!assistantContent.trim() && body.conversationId) {
          const note =
            "_No answer was produced._";
          for (let i = 0; i < note.length; i += 32) {
            const piece = note.slice(i, i + 32);
            await safeWrite(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [
                    { index: 0, delta: { content: piece }, finish_reason: null },
                  ],
                })}\n\n`,
              ),
            );
            appendInferenceContent(body.conversationId, piece);
          }
        }
        // Either no tools requested, or finish_reason !== "tool_calls" → done.
        exitedNaturally = true;
        break;
      }
      // Tool-call loop: the model kept emitting tool_calls without ever
      // producing a final user-facing summary. Observed with Qwen3.6 on
      // mlx-vlm when the second iteration's prompt grows large (tool
      // results stuffed in). Without this fallback the user sees only
      // the model's intro line ("I'll search...") then silence.
      // Suppress when the model DID write a real reply this turn — the message
      // would otherwise contradict an answer the user can plainly see.
      if (!exitedNaturally && !lastAssistantContent.trim() && body.conversationId) {
        const note =
          "\n\nError - The model kept asking to call tools without writing a final answer";
        for (let i = 0; i < note.length; i += 32) {
          const piece = note.slice(i, i + 32);
          await safeWrite(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  { index: 0, delta: { content: piece }, finish_reason: null },
                ],
              })}\n\n`,
            ),
          );
          appendInferenceContent(body.conversationId, piece);
        }
        await safeWrite(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          ),
        );
      }
      // End-of-stream marker for the client parser
      await safeWrite(encoder.encode("data: [DONE]\n\n"));

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
      if (body.conversationId) markInferenceError(body.conversationId, String(err));
      await safeWrite(
        encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`),
      );
      await safeWrite(encoder.encode("data: [DONE]\n\n"));
    } finally {
      if (primaryNarration?.started) {
        narrate("task_done", { status: "done" });
      }
      clearInterval(heartbeat);
      try {
        await writer.close();
      } catch {
        // already closed
      }
      // Mark the inference-state buffer done. The persist callback is the
      // single source of assistant-message DB writes from now on — the
      // client used to call api.appendMessage('assistant', …) on stream
      // end, but Phase 2 of the inference-state port moves that here so
      // the message lands even if the client disconnected mid-stream.
      if (body.conversationId) {
        const convIdLocal = body.conversationId;
        // Resolve once before persistence — the cap cache is 60s TTL so this
        // is a Map.get in the steady state. Failure falls back to raw alias.
        let modelLabel = body.model
          ? await resolveModelLabel(
              body.model,
              target?.baseUrl ?? null,
              target?.apiKey ?? null,
            ).catch(() => body.model)
          : body.model;
        // CoeOS routes to a concrete model per request; surface what it actually
        // employed (from the response) instead of the bare router id. The
        // OdyssAI-X local path sends x_odyssai_routed (routed_to + category);
        // Telemak/cloud routes fall back to the response model id.
        if ((body.model ?? "").toLowerCase() === "coeos") {
          const raw = coeosRouted?.concrete || responseModelSeen || coeosRouted?.routed_to;
          const employed = raw ? raw.split("/").pop() : null;
          if (employed) {
            modelLabel = coeosRouted?.category
              ? `CoeOS · ${coeosRouted.category} — ${employed}`
              : `CoeOS — ${employed}`;
          }
        }
        // #36 memory transparency — surface exactly what memory was injected
        // this turn so the user can see "ce qui part". memoryBlock = stable
        // per-conversation wiki/vault (system prompt); ragBlock = per-turn
        // semantic retrieval. Both can be "" (nothing injected → emit nothing,
        // absence is the signal). Token estimate = chars/4 (no tokenizer).
        // This only READS the already-injected strings; it does not change
        // the injection (byte-stability / KV-cache invariant untouched).
        const memChars = memoryBlock.length;
        const ragChars = ragBlock.length;
        const memoryFields =
          memChars + ragChars > 0
            ? {
                memoryChars: memChars,
                ragChars: ragChars,
                memoryTokens: Math.ceil((memChars + ragChars) / 4),
                memoryInjected: [
                  memChars > 0
                    ? `=== Memory (stable, system prompt) ===\n${memoryBlock}`
                    : null,
                  ragChars > 0
                    ? `=== RAG (per-turn retrieval) ===\n${ragBlock}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              }
            : {};
        await finishInference(convIdLocal, async (content, _reasoning, st) => {
          const statsBase = sawUpstreamUsage
            ? {
                ttft: st.ttftMs !== null ? `${st.ttftMs}ms` : undefined,
                tokens: st.promptTokens + st.completionTokens,
                promptTokens: st.promptTokens,
                completionTokens: st.completionTokens,
                reasoningTokens: st.reasoningTokens,
                // Cached prompt tokens — 0 = full re-prefill, >0 = upstream
                // (upstream prefix cache — Anthropic, vLLM, etc.) served part of
                // the prefix from cache. Surfaced in the UI as "Cached".
                cachedTokens: st.cachedTokens,
                chunks: totalChunkCount,
                durationMs: st.totalMs,
                speed:
                  st.totalMs && st.completionTokens
                    ? `${((st.completionTokens / st.totalMs) * 1000).toFixed(1)} tok/s`
                    : undefined,
                // Decode-only tok/s — completion / (duration - ttft). Matches
                // the throughput numbers model providers advertise (e.g.
                // inferencer announces 5 tok/s for Mistral-Medium-3.5; the
                // raw end-to-end "speed" pulls that down because it counts
                // the prompt-eval phase in the denominator). Both rates
                // shown side-by-side so users can sanity-check vs spec.
                //
                // Only meaningful when there's a genuine decode window. In
                // non-stream mode (the tools path) the whole response lands
                // at once, so ttft ≈ total, the decode window collapses to a
                // few ms, and the rate explodes to a garbage ~1000 tok/s
                // (observed 2026-05-29). Require the decode phase to be a
                // non-trivial slice of total (≥250 ms AND ≥10% of duration)
                // and at least a few tokens before trusting the number;
                // otherwise suppress it (the UI just shows overall speed).
                decodeSpeed: (() => {
                  if (!st.totalMs || st.ttftMs === null || !st.completionTokens) {
                    return undefined;
                  }
                  const decodeMs = st.totalMs - st.ttftMs;
                  if (
                    decodeMs < 250 ||
                    decodeMs < st.totalMs * 0.1 ||
                    st.completionTokens < 5
                  ) {
                    return undefined;
                  }
                  return `${((st.completionTokens / decodeMs) * 1000).toFixed(1)} tok/s`;
                })(),
                model: modelLabel,
              }
            : { chunks: totalChunkCount, durationMs: st.totalMs, model: modelLabel };
          // Fold in the #36 memory-transparency fields (empty object when no
          // memory was injected → nothing surfaces in the UI).
          const stats = { ...statsBase, ...memoryFields };
          // Surface the auto-router decision so the UI can render a chip
          // "via Auto → {model} ({label}, {score})". Stored on the
          // assistant message so it's visible when the chat is reopened.
          // routedError is set only on the fallback path — it keeps the
          // "this answer didn't come from the router's pick" signal
          // attached to the message, so reopening the conversation later
          // still shows why. The live SSE notice is transient; this isn't.
          const statsWithRouting = routedDecision
            ? {
                ...stats,
                routedFrom: routedDecision.from,
                routedLabel: routedDecision.label,
                routedScore: routedDecision.score,
                routedMs: routedDecision.ms,
                ...(routedDecision.error
                  ? { routedError: routedDecision.error }
                  : {}),
              }
            : stats;
          // Confidential Guard — persist the verdict on the message so the
          // banner survives a reload (same pattern as the routing chip).
          const statsWithGuard = guardVerdict?.sensitive
            ? {
                ...statsWithRouting,
                guardFlagged: true,
                guardSeverity: guardVerdict.maxSeverity,
                guardCategories: guardVerdict.findings.map((f) => f.category),
                guardForcedLocal: guardVerdict.forcedLocal ?? false,
                guardForcedModel: guardVerdict.forcedModel ?? null,
                guardDestinationLocal: guardVerdict.destinationLocal ?? false,
              }
            : statsWithRouting;
          try {
            await db.insert(messages).values({
              conversationId: convIdLocal,
              role: "assistant",
              content,
              stats: statsWithGuard as Record<string, unknown>,
            });
            await db
              .update(conversations)
              .set({ updatedAt: new Date() })
              .where(eq(conversations.id, convIdLocal));
          } catch (e) {
            console.error(
              "[chat] server-side assistant persist failed:",
              (e as Error).message,
            );
          }
        });
        // Drop the buffer after a grace window so a late-arriving client
        // can still see the final content via /inference. 60s is enough
        // for a tab-switch / page-reload to catch up.
        setTimeout(() => deleteInference(convIdLocal), 60_000);
      }
      // Memory wiki refresh — registered for inactivity-based compile.
      // Was previously a per-turn `triggerCompile` call, which hammered
      // the local Inferencer and contended with chat latency. Now we
      // just mark the conv as a candidate; memory-scheduler fires the
      // compile after MEMORY_INACTIVITY_COMPILE_MS (default 10 min) of
      // quiet, OR via the time-scheduled slots (06/12:30/19).
      // Suppressed when:
      //  - the conv kind isn't 'chat' (Talk handles its own context)
      //  - the conv's memoryEnabled is off
      //  - the conv is a guest session (don't pollute the owner's wiki)
      //  - the project has globalMemoryReadOnly = true (explicit opt-out)
      //  - the project has dedicatedMemoryEnabled = true (writes belong
      //    to the project corpus, not the global wiki)
      //  - a custom system prompt is active (persona / fiction / writing
      //    benchmark sessions). Compiling one into the biographical wiki
      //    is exactly how "Le Bruit Blanc" became a lived memory
      //    (2026-06-12) — so the conv is tainted DURABLY: memoryEnabled
      //    flips off in DB (visible as the conv's memory toggle), which
      //    also shields it from the scheduled global slots, not just
      //    from this turn's registration.
      if (body.system_prompt && body.conversationId && convMemoryEnabled) {
        void db
          .update(conversations)
          .set({ memoryEnabled: false })
          .where(eq(conversations.id, body.conversationId))
          .then(() =>
            console.log(
              `[memory] conv ${body.conversationId} memoryEnabled→off (custom system prompt active)`,
            ),
          )
          .catch(() => {});
      } else if (
        body.conversationId &&
        convKind === "chat" &&
        convMemoryEnabled &&
        !guest &&
        !projectGlobalReadOnly &&
        !projectDedicatedMemoryEnabled
      ) {
        registerInactivityCompile(userId, body.conversationId);
      }
    }
}
