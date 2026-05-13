/**
 * Cheap token estimation.
 *
 * Rough rule: ~4 characters per token on average for English/French
 * mixed text. Worse for code (more like 3), better for prose (closer
 * to 5). Good enough for a context-budget bar where "you're getting
 * close" is the only signal that matters.
 *
 * Don't use this for billing. For billing, run the real tokenizer of
 * the target model (tiktoken / sentencepiece) — that's a much heavier
 * dep and we don't need it client-side.
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Sum a rough token estimate over a list of message contents. Strings
 * are charcount-divided as above; multimodal parts contribute based on
 * their text portions only (images don't add to context here — vision
 * models handle them via separate token paths).
 */
export function estimateMessageListTokens(
  messages: Array<{
    role: string;
    content:
      | string
      | Array<{ type: "text"; text: string } | { type: string }>;
  }>,
): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      total += estimateTokens(m.content);
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          total += estimateTokens(part.text);
        }
      }
    }
  }
  return total;
}

/**
 * Format a token count for compact display:
 *   1234     → "1.2k"
 *   12345    → "12k"
 *   123456   → "123k"
 *   1234567  → "1.2M"
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
