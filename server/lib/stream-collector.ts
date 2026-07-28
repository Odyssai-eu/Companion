/**
 * Streaming + tool-result collectors extracted from chat.ts (#16).
 * Pure structural move — verbatim symbols, no behaviour change.
 */

import { recordInferenceUsage, appendInferenceContent, appendInferenceReasoning } from "./inference-state";
import type { ToolResult } from "./tools";

export type AccumulatedToolCall = {
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
export async function pipeAndCollect(
  upstream: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  /** When set, content deltas + usage are mirrored into the in-memory
   *  inference-state buffer so /inference can serve them to disconnected
   *  clients. Skip for routes that don't want the side effect. */
  convId?: string,
): Promise<{
  toolCalls: AccumulatedToolCall[];
  finishReason: string | null;
  assistantContent: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  chunkCount: number;
  /** CoeOS router decision (OdyssAI-X local path adds this). */
  routed: { routed_to?: string; category?: string; concrete?: string } | null;
  /** The model id the response actually reported (employed model, all paths). */
  responseModel: string | null;
  /** OdyssAI-X anti-loop tripped: the engine ended the turn because the
   *  model was cycling. Surfaced to the user as a notice banner. */
  loopDetected: boolean;
}> {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const tcByIndex = new Map<number, AccumulatedToolCall>();
  let finishReason: string | null = null;
  let assistantContent = "";
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let chunkCount = 0;
  let routed: { routed_to?: string; category?: string; concrete?: string } | null = null;
  let responseModel: string | null = null;
  let loopDetected = false;

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
          model?: string;
          x_odyssai_routed?: {
            router?: string; routed_to?: string; category?: string; concrete?: string;
          };
          x_mlx_cluster?: { loop_detected?: boolean };
          choices?: Array<{
            delta?: {
              content?: string | null;
              // Thinking models stream chain-of-thought on a separate channel
              // (`reasoning_content` for mlx-lm/OdyssAI-X + DeepSeek-style
              // servers, `reasoning` for some others). We must capture it:
              // a turn that emits ONLY reasoning and never a `content` delta
              // would otherwise leave the inference buffer empty → finishInference
              // skips persist → the answer ghosts on reload.
              reasoning_content?: string | null;
              reasoning?: string | null;
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
            input_tokens?: number;
            output_tokens?: number;
          };
        };
        if (parsed.x_odyssai_routed?.routed_to) routed = parsed.x_odyssai_routed;
        if (parsed.x_mlx_cluster?.loop_detected) loopDetected = true;
        if (parsed.model && !responseModel) responseModel = parsed.model;
        if (parsed.usage) {
          // mlx-vlm reports usage under input_tokens/output_tokens; LiteLLM
          // forwards both shapes but zeroes the OpenAI-style fields when
          // upstream uses input/output. Read both, prefer non-zero.
          usage = {
            promptTokens:
              parsed.usage.prompt_tokens ||
              parsed.usage.input_tokens ||
              0,
            completionTokens:
              parsed.usage.completion_tokens ||
              parsed.usage.output_tokens ||
              0,
          };
          if (convId) recordInferenceUsage(convId, parsed.usage);
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          assistantContent += choice.delta.content;
          chunkCount += 1;
          if (convId) appendInferenceContent(convId, choice.delta.content);
        }
        const reasoningPiece =
          choice.delta?.reasoning_content ?? choice.delta?.reasoning;
        if (reasoningPiece && convId) {
          appendInferenceReasoning(convId, reasoningPiece);
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
      // .catch matches the safeWrite pattern in the caller — never throw
      // back into the SSE consumer just because the client disconnected.
      // The upstream must keep being drained so finishInference runs.
      await writer.write(encoder.encode(out.join("\n") + "\n")).catch(() => undefined);
    }
  }

  return {
    toolCalls: Array.from(tcByIndex.values()).filter((tc) => tc.name),
    finishReason,
    assistantContent,
    usage,
    chunkCount,
    routed,
    responseModel,
    loopDetected,
  };
}

/**
 * Non-stream variant: read the upstream response as a single JSON object
 * (returned when we send `stream: false`), then synthesise SSE chunks for
 * the client so it doesn't need to know whether upstream streamed or not.
 *
 * Used for local model + tools: mlx-vlm/Ollama/vLLM emit native-syntax
 * tool calls (Qwen-XML, etc.) inside content during streaming. LiteLLM
 * only converts those into proper tool_calls JSON when stream is off.
 */
export async function collectNonStream(
  upstream: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  /** Mirror content slices + usage into the inference-state buffer
   *  so the polling endpoint can show progress to reconnecting clients
   *  even while we're typewriter-slicing a non-stream upstream. */
  convId?: string,
): Promise<{
  toolCalls: AccumulatedToolCall[];
  finishReason: string | null;
  assistantContent: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  chunkCount: number;
  routed: { routed_to?: string; category?: string; concrete?: string } | null;
  responseModel: string | null;
  loopDetected: boolean;
}> {
  let chunkCountForReturn = 0;
  const text = await upstream.text();
  let parsed: {
    model?: string;
    x_odyssai_routed?: {
      router?: string; routed_to?: string; category?: string; concrete?: string;
    };
    x_mlx_cluster?: { loop_detected?: boolean };
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    // mlx-vlm reports usage as input_tokens/output_tokens; LiteLLM forwards
    // both shapes (and unfortunately fills prompt_tokens/completion_tokens
    // to 0 when the upstream uses input/output_tokens). Read both.
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    // Surface to the client as an error chunk; let the upstream-not-ok
    // path catch the rest of the contract.
    await writer.write(
      encoder.encode(`data: ${JSON.stringify({ error: "invalid_json_from_upstream" })}\n\n`),
    ).catch(() => undefined);
    return { toolCalls: [], finishReason: null, assistantContent: "", usage: null, chunkCount: 0, routed: null, responseModel: null, loopDetected: false };
  }

  const routed = parsed.x_odyssai_routed?.routed_to ? parsed.x_odyssai_routed : null;
  const responseModel = parsed.model ?? null;
  const choice = parsed.choices?.[0];
  const assistantContent = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason ?? null;
  const rawCalls = choice?.message?.tool_calls ?? [];
  const toolCalls: AccumulatedToolCall[] = rawCalls.map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.function?.name ?? "",
    argumentsRaw: tc.function?.arguments ?? "",
  })).filter((tc) => tc.name);

  // Temporary instrumentation for "réponse évaporée" diagnosis. When
  // the upstream returns no useful content AND no tool calls, log the
  // raw body (truncated) so we can see exactly what came back. Remove
  // once the root cause is identified.
  if (!assistantContent.trim() && toolCalls.length === 0) {
    console.warn(
      "[chat:empty-upstream]",
      JSON.stringify({
        convId: convId ?? null,
        finishReason,
        rawCallsCount: rawCalls.length,
        bodyLen: text.length,
        bodyPreview: text.slice(0, 2000),
      }),
    );
  }

  const usage = parsed.usage
    ? {
        promptTokens:
          parsed.usage.prompt_tokens ||
          parsed.usage.input_tokens ||
          0,
        completionTokens:
          parsed.usage.completion_tokens ||
          parsed.usage.output_tokens ||
          0,
      }
    : null;
  if (convId && parsed.usage) recordInferenceUsage(convId, parsed.usage);

  // Fallback for models that "give up" silently. Observed with
  // Qwen3.6-35B served via mlx-vlm when 20+ tools schemas are passed:
  // the model returns content="" + tool_calls=[] + finish_reason="stop".
  // Without this guard, the SSE stream closes with nothing visible and
  // finishInference skips persist (it requires inf.content truthy), so
  // the user sees the typing dots disappear with no response or error.
  let effectiveContent = assistantContent;
  if (
    !effectiveContent &&
    toolCalls.length === 0 &&
    (finishReason === "stop" || finishReason === null)
  ) {
    effectiveContent =
      "_(The model returned an empty response. This often happens with " +
      "local models when many tools are exposed at once. Try rephrasing, " +
      "disabling some MCP servers, or switching to a hosted model like " +
      "`or:claude-haiku`.)_";
  }
  if (effectiveContent) {
    const SLICE = 32;
    const DELAY_MS = 8;
    let chunkCount = 0;
    for (let i = 0; i < effectiveContent.length; i += SLICE) {
      const piece = effectiveContent.slice(i, i + SLICE);
      const synthChunk = {
        choices: [
          {
            index: 0,
            delta: { content: piece },
            finish_reason: null,
          },
        ],
      };
      await writer.write(
        encoder.encode(`data: ${JSON.stringify(synthChunk)}\n\n`),
      ).catch(() => undefined);
      if (convId) appendInferenceContent(convId, piece);
      chunkCount++;
      // Skip the delay on the last slice — no need to add latency before
      // the finish chunk.
      if (i + SLICE < effectiveContent.length) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }
    // Override the chunkCount returned at the end to reflect what we emitted.
    // (We update via the variable below.)
    // chunkCount usage is captured in the return.
    chunkCountForReturn = chunkCount;
  }
  // Emit a finish chunk so the client parser sees the turn close cleanly.
  const finishChunk = {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason ?? "stop",
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
          },
        }
      : {}),
  };
  await writer.write(
    encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`),
  ).catch(() => undefined);

  return {
    toolCalls,
    finishReason,
    assistantContent,
    usage,
    chunkCount: chunkCountForReturn,
    routed,
    responseModel,
    loopDetected: Boolean(parsed.x_mlx_cluster?.loop_detected),
  };
}

/** Serialize a tool result so the LLM sees consistent JSON. Truncates very
 *  large bodies (Tavily extract can return huge raw_content) so we don't blow
 *  up the next round-trip's prompt budget. */
export function stringifyForTool(r: ToolResult): string {
  if (!r.ok) return JSON.stringify({ error: r.error });
  // MCP servers return tool content as an already-serialized string
  // (the `text` field of an MCP content block, typically itself a JSON
  // blob). Re-running JSON.stringify wraps it in another layer of
  // escaped quotes, so the model sees `"\"{\\\"key\\\":...}\""` instead
  // of `"{\"key\":...}"`. Some tool-trained models (TeleCoder /
  // Qwen3-Coder-Next observed 2026-05-29) interpret that as
  // "result is opaque, retry the tool" and loop until MAX iterations.
  //
  // Pass strings through verbatim; only stringify when data is a
  // structured value (objects from local fs_* / skill_* tools).
  const content = typeof r.data === "string"
    ? r.data
    : JSON.stringify(r.data);
  // 24k chars ≈ 6k tokens — generous but bounded.
  return content.length > 24_000
    ? content.slice(0, 24_000) + "…[truncated]"
    : content;
}

/** A short summary of a tool result to display in the UI without blowing up
 *  the SSE stream. The full payload is fed back to the LLM separately. */
export function summarizeResult(
  r: ToolResult,
): { ok: boolean; summary: string; sources?: Array<{ title: string; url: string }> } {
  if (!r.ok) return { ok: false, summary: r.error };
  // MCP tools (mcp-as-client) hand back r.data as a plain string —
  // the textual content concatenated from the tool's MCP response.
  // Show its length so the UI has something meaningful, but skip the
  // object-shape branches below (they'd crash with TypeError on `in`).
  if (typeof r.data === "string") {
    const len = r.data.length;
    return {
      ok: true,
      summary: `${len.toLocaleString()} chars`,
    };
  }
  if (!r.data || typeof r.data !== "object") {
    return { ok: true, summary: "" };
  }
  const data = r.data as
    | { results?: Array<{ title: string; url: string }>; query?: string }
    | { url?: string; content?: string };
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
