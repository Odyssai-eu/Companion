export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
};

export type StreamDelta = {
  type: "content" | "reasoning";
  text: string;
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
  serverId: string;
  /** Used by the backend to fetch the user's memory wiki for this conversation
   *  (and its project, if any) and inject it into the system prompt. */
  conversationId?: string;
  messages: ChatMessage[];
  model?: string;
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

  let res: Response;
  try {
    const body: Record<string, unknown> = {
      serverId: opts.serverId,
      messages: opts.messages,
    };
    if (opts.conversationId) body.conversationId = opts.conversationId;
    if (opts.model) body.model = opts.model;
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
      if (inf.thinking && inf.reasoning_effort)
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
          tokenCount += estimateTokens(delta.reasoning_content);
          chunkCount++;
          opts.onDelta({ type: "reasoning", text: delta.reasoning_content });
        }
        if (typeof delta.content === "string" && delta.content) {
          if (firstContentAt === null) firstContentAt = performance.now();
          tokenCount += estimateTokens(delta.content);
          chunkCount++;
          opts.onDelta({ type: "content", text: delta.content });
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
      ok: true,
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
