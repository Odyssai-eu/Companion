import type { Context } from "hono";

/**
 * Translate an OpenAI-style /v1/chat/completions request to Anthropic's
 * /v1/messages API, proxy the upstream SSE stream, and re-emit it in
 * OpenAI-compatible event format so the existing client parser keeps working.
 *
 * Anthropic spec reference:
 *   https://docs.anthropic.com/en/api/messages-streaming
 *
 * Notable transforms:
 *   - `messages` with role=system are hoisted into the top-level `system` field
 *   - Anthropic requires `max_tokens`; we default to 4096 if the caller omits
 *   - SSE events: message_start → we emit the first `delta.role = assistant`
 *                content_block_start (type=thinking) → reasoning stream begins
 *                content_block_delta (text_delta)    → delta.content
 *                content_block_delta (thinking_delta) → delta.reasoning_content
 *                message_stop / [DONE]               → terminate with [DONE]
 */

type OpenAIMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function handleAnthropicChat(
  c: Context,
  opts: {
    base: string;
    authBearer: string | null;
    model: string;
    messages: OpenAIMessage[];
    temperature?: number;
    max_tokens?: number;
  },
) {
  const { base, authBearer, model, messages, temperature, max_tokens } = opts;

  const systemParts: string[] = [];
  const userAssistant: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(m.content);
    else userAssistant.push({ role: m.role, content: m.content });
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: max_tokens ?? 4096,
    messages: userAssistant,
    stream: true,
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  if (temperature !== undefined) body.temperature = temperature;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (authBearer) headers["x-api-key"] = authBearer;

  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return c.json(
      { error: "upstream_unreachable", detail: String(err) },
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return c.json(
      { error: "upstream_error", status: upstream.status, body: text },
      upstream.status as 400 | 401 | 403 | 404 | 500 | 502,
    );
  }

  const translated = translateStream(upstream.body, model);
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return c.body(translated);
}

function translateStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const completionId = `anthropic-${Date.now()}`;

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      let buf = "";

      function emitDelta(delta: { content?: string; reasoning_content?: string }) {
        const payload = {
          id: completionId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      }

      try {
        // First chunk: announce assistant role so OpenAI-compat clients init
        emitDelta({ content: "" });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });

          const events = buf.split("\n\n");
          buf = events.pop() ?? "";

          for (const evt of events) {
            const lines = evt.split("\n");
            let eventName = "";
            let dataLine = "";
            for (const line of lines) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:"))
                dataLine = line.slice(5).trim();
            }
            if (!dataLine) continue;
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(dataLine);
            } catch {
              continue;
            }

            switch (eventName) {
              case "content_block_delta": {
                const delta = (
                  data as { delta?: { type?: string; text?: string; thinking?: string } }
                ).delta;
                if (!delta) break;
                if (delta.type === "text_delta" && delta.text) {
                  emitDelta({ content: delta.text });
                } else if (
                  delta.type === "thinking_delta" &&
                  delta.thinking
                ) {
                  emitDelta({ reasoning_content: delta.thinking });
                }
                break;
              }
              case "message_stop":
                controller.enqueue(encoder.encode(`data: [DONE]\n\n`));
                break;
              default:
                // message_start / message_delta / ping — ignored for now
                break;
            }
          }
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
