// Upstream chat-completions request building — extracted from chat.ts (#31, WU3).
// Pure construction; no route state.

import { maxTokensCap } from "./model-policy";
import type { ChatBody } from "../routes/chat";

/**
 * Build the upstream request body (WITHOUT `messages` — those are set per
 * tool-loop iteration by the caller). Copies through the sampling params,
 * forces an explicit `enable_thinking` (our local mlx-lm runners default OFF,
 * Inferencer defaults ON — the proxy normalises), forwards `reasoning_effort`
 * + the prefix-cache `session_id`, drops `top_p` for Anthropic (it rejects
 * temperature+top_p together), and clamps `max_tokens` to the provider ceiling.
 */
export function buildUpstreamBody(body: ChatBody): Record<string, unknown> {
  const model = body.model ?? "";
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
    "stop",
  ] as const) {
    const v = body[k];
    if (v !== undefined) baseBody[k] = v;
  }
  baseBody.enable_thinking = body.thinking === true;
  // reasoning_effort is independent of the thinking toggle — forward whenever
  // the client sent a concrete level ("none"/empty → engine default decides).
  if (body.reasoning_effort && body.reasoning_effort !== "none") {
    baseBody.reasoning_effort = body.reasoning_effort;
  }
  // Prefix-cache key for OdyssAI-X (gateway mode): every turn of a conv shares
  // the system prompt + memory + prior messages → high KV-cache hit rate.
  // LiteLLM/legacy paths ignore unknown body fields, so send unconditionally.
  if (body.conversationId) {
    baseBody.session_id = body.conversationId;
  }
  // Anthropic rejects requests that set both temperature and top_p.
  const looksAnthropic = /^anthropic\//i.test(model) || /^claude[-_]/i.test(model);
  if (looksAnthropic && "top_p" in baseBody && "temperature" in baseBody) {
    delete baseBody.top_p;
  }
  // Clamp max_tokens to the provider's published ceiling so we don't 400.
  if (typeof baseBody.max_tokens === "number") {
    const cap = maxTokensCap(model);
    if (cap !== null && baseBody.max_tokens > cap) {
      console.warn(
        "[chat] clamping max_tokens %d → %d for model %s",
        baseBody.max_tokens,
        cap,
        model,
      );
      baseBody.max_tokens = cap;
    }
  }
  return baseBody;
}
