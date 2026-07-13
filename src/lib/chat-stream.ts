export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  // Raw-document part (Parser add-on). Carried to the server, which forwards
  // the bytes to Docling and swaps in a text part before the engine call.
  | { type: "document"; document: { name: string; url: string; mime?: string } };

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
  /** ISO-8601 timestamp — set on outgoing user messages so the backend can
   *  build per-message Δ time tags. */
  createdAt?: string;
};

export type StreamDelta =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_start";
      calls: Array<{ name: string; args: Record<string, unknown> }>;
    }
  | {
      type: "tool_done";
      calls: Array<{
        name: string;
        result: {
          ok: boolean;
          summary: string;
          sources?: Array<{ title: string; url: string }>;
        };
      }>;
    }
  | { type: "file_changed"; path: string }
  | {
      type: "guard_warning";
      severity: "low" | "medium" | "high";
      findings: Array<{ category: string; severity: string; spans: string[] }>;
      forcedLocal: boolean;
      forcedModel: string | null;
    };

export type InferencePayload = {
  temperature?: number;
  max_tokens?: number;
  top_p?: number | null;
  top_k?: number | null;
  min_p?: number | null;
  repetition_penalty?: number | null;
  seed?: number | null;
  thinking?: boolean;
  reasoning_effort?: string;
  system_prompt?: string;
};

export type StreamChatOptions = {
  /** Used by the backend to fetch the user's memory wiki for this conversation
   *  (and its project, if any) and inject it into the system prompt. */
  conversationId?: string;
  messages: ChatMessage[];
  model: string;
  inference?: InferencePayload | null;
  signal?: AbortSignal;
  onDelta: (delta: StreamDelta) => void;
};

export type StreamChatResult = {
  ok: boolean;
  error?: string;
  ttftMs?: number;
  durationMs?: number;
  /** Estimated total tokens (prompt+completion) when upstream doesn't
   *  send `usage`, otherwise the upstream value. */
  tokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  /** Number of SSE chunks received with content. Useful as a coarse
   *  "the model was producing" signal vs total wallclock. */
  chunks?: number;
};

export async function streamChat(
  opts: StreamChatOptions,
): Promise<StreamChatResult> {
  const start = performance.now();
  let firstContentAt: number | null = null;
  let tokenCount = 0;
  let chunkCount = 0;
  let usagePrompt: number | undefined;
  let usageCompletion: number | undefined;
  let usageReasoning: number | undefined;

  // Set when the backend writes an inline SSE error (e.g. upstream 4xx/5xx
  // after our keep-alive stream has already opened). Surfaced via wrap().
  let inlineError: string | null = null;

  let res: Response;
  try {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
    };
    if (opts.conversationId) body.conversationId = opts.conversationId;
    if (opts.inference) {
      const inf = opts.inference;
      if (inf.temperature !== undefined) body.temperature = inf.temperature;
      if (inf.max_tokens !== undefined) body.max_tokens = inf.max_tokens;
      if (inf.top_p != null) body.top_p = inf.top_p;
      if (inf.top_k != null) body.top_k = inf.top_k;
      if (inf.min_p != null) body.min_p = inf.min_p;
      if (inf.repetition_penalty != null)
        body.repetition_penalty = inf.repetition_penalty;
      if (inf.seed != null) body.seed = inf.seed;
      if (inf.thinking) body.thinking = true;
      // reasoning_effort is independent of the thinking toggle: reasoning-first
      // models (Step-3.7) ALWAYS think — the dial controls how much, not
      // whether. So send it whenever the user picked a level, even with
      // thinking off. "none" means "let the engine decide" → omit it.
      if (inf.reasoning_effort && inf.reasoning_effort !== "none")
        body.reasoning_effort = inf.reasoning_effort;
      if (inf.system_prompt) body.system_prompt = inf.system_prompt;
    }

    res = await fetch("/api/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      error: `${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return wrap();
      try {
        const chunk = JSON.parse(payload) as {
          error?: string;
          _event?: string;
          calls?: Array<unknown>;
          path?: string;
          choices?: {
            delta?: { content?: string | null; reasoning_content?: string | null };
          }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            reasoning_tokens?: number;
            total_tokens?: number;
          };
        };
        // Backend-emitted error (upstream failure after stream open).
        if (typeof chunk.error === "string" && chunk.error) {
          inlineError = chunk.error;
          continue;
        }
        // Backend-emitted custom events (tool execution lifecycle).
        if (chunk._event === "tool_start" && Array.isArray(chunk.calls)) {
          opts.onDelta({
            type: "tool_start",
            calls: chunk.calls as Array<{
              name: string;
              args: Record<string, unknown>;
            }>,
          });
          continue;
        }
        if (chunk._event === "tool_done" && Array.isArray(chunk.calls)) {
          opts.onDelta({
            type: "tool_done",
            calls: chunk.calls as Array<{
              name: string;
              result: {
                ok: boolean;
                summary: string;
                sources?: Array<{ title: string; url: string }>;
              };
            }>,
          });
          continue;
        }
        if (chunk._event === "file_changed" && typeof chunk.path === "string") {
          opts.onDelta({ type: "file_changed", path: chunk.path });
          continue;
        }
        if (chunk._event === "guard_warning") {
          const g = chunk as unknown as {
            severity?: string;
            findings?: Array<{ category: string; severity: string; spans: string[] }>;
            forcedLocal?: boolean;
            forcedModel?: string | null;
          };
          opts.onDelta({
            type: "guard_warning",
            severity: (g.severity ?? "medium") as "low" | "medium" | "high",
            findings: Array.isArray(g.findings) ? g.findings : [],
            forcedLocal: Boolean(g.forcedLocal),
            forcedModel: g.forcedModel ?? null,
          });
          continue;
        }
        if (chunk.usage) {
          if (typeof chunk.usage.prompt_tokens === "number")
            usagePrompt = chunk.usage.prompt_tokens;
          if (typeof chunk.usage.completion_tokens === "number")
            usageCompletion = chunk.usage.completion_tokens;
          if (typeof chunk.usage.reasoning_tokens === "number")
            usageReasoning = chunk.usage.reasoning_tokens;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          const text = unescapeUpstreamLiterals(delta.reasoning_content);
          tokenCount += estimateTokens(text);
          chunkCount++;
          opts.onDelta({ type: "reasoning", text });
        }
        if (typeof delta.content === "string" && delta.content) {
          if (firstContentAt === null) firstContentAt = performance.now();
          const text = unescapeUpstreamLiterals(delta.content);
          tokenCount += estimateTokens(text);
          chunkCount++;
          opts.onDelta({ type: "content", text });
        }
      } catch {
        // ignore malformed payloads
      }
    }
  }

  return wrap();

  function wrap(): StreamChatResult {
    const durationMs = Math.round(performance.now() - start);
    const ttftMs =
      firstContentAt !== null ? Math.round(firstContentAt - start) : undefined;
    const total =
      usagePrompt !== undefined && usageCompletion !== undefined
        ? usagePrompt + usageCompletion + (usageReasoning ?? 0)
        : tokenCount;
    return {
      ok: !inlineError,
      error: inlineError ?? undefined,
      ttftMs,
      durationMs,
      tokens: total,
      promptTokens: usagePrompt,
      completionTokens: usageCompletion,
      reasoningTokens: usageReasoning,
      chunks: chunkCount,
    };
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/**
 * Inferencer (Pro v1.10.x) double-escapes newlines in SSE delta content:
 * its JSON sends `"\\n"` where it should send `"\n"`. After JSON.parse
 * we end up with the literal 2-char string `\n` (backslash + n) instead
 * of an actual newline, which breaks markdown rendering.
 *
 * This unescapes the common cases. Risk of mangling code blocks that
 * legitimately discuss escape sequences is low for a chat UI; if it
 * becomes a problem we can detect upstream provider and only apply when
 * the model id is known to be Inferencer-served.
 */
function unescapeUpstreamLiterals(s: string): string {
  if (!s.includes("\\")) return s;
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"');
}
