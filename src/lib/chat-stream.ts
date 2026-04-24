export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type StreamDelta = {
  type: "content" | "reasoning";
  text: string;
};

export type StreamChatOptions = {
  serverId: string;
  messages: ChatMessage[];
  model?: string;
  signal?: AbortSignal;
  onDelta: (delta: StreamDelta) => void;
};

export type StreamChatResult = {
  ok: boolean;
  error?: string;
  ttftMs?: number;
  durationMs?: number;
  tokens?: number;
};

export async function streamChat(
  opts: StreamChatOptions,
): Promise<StreamChatResult> {
  const start = performance.now();
  let firstContentAt: number | null = null;
  let tokenCount = 0;

  let res: Response;
  try {
    res = await fetch("/api/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: opts.serverId,
        messages: opts.messages,
        model: opts.model,
      }),
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
        };
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
          tokenCount += estimateTokens(delta.reasoning_content);
          opts.onDelta({ type: "reasoning", text: delta.reasoning_content });
        }
        if (typeof delta.content === "string" && delta.content) {
          if (firstContentAt === null) firstContentAt = performance.now();
          tokenCount += estimateTokens(delta.content);
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
    return { ok: true, ttftMs, durationMs, tokens: tokenCount };
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}
