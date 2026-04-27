/**
 * Static price table for OpenRouter-routed models.
 * Unit: USD per 1 000 000 tokens (prompt / completion).
 *
 * Model IDs follow the OpenRouter convention: `provider/model-name`.
 * Variant suffixes like `:beta`, `:free`, `:extended` are stripped before
 * lookup. Unknown models return null — callers show "— · cloud".
 *
 * Update cadence: refresh when major pricing changes happen. OpenRouter's
 * public catalogue is at https://openrouter.ai/api/v1/models for reference.
 */

type Price = { prompt: number; completion: number };

const TABLE: Record<string, Price> = {
  // ── Anthropic ──────────────────────────────────────────────────────────
  "anthropic/claude-opus-4":          { prompt: 15,    completion: 75    },
  "anthropic/claude-sonnet-4":        { prompt: 3,     completion: 15    },
  "anthropic/claude-3-7-sonnet":      { prompt: 3,     completion: 15    },
  "anthropic/claude-3-5-sonnet":      { prompt: 3,     completion: 15    },
  "anthropic/claude-3-5-haiku":       { prompt: 0.8,   completion: 4     },
  "anthropic/claude-3-opus":          { prompt: 15,    completion: 75    },
  "anthropic/claude-3-sonnet":        { prompt: 3,     completion: 15    },
  "anthropic/claude-3-haiku":         { prompt: 0.25,  completion: 1.25  },
  // ── OpenAI ────────────────────────────────────────────────────────────
  "openai/gpt-4o":                    { prompt: 2.5,   completion: 10    },
  "openai/gpt-4o-mini":               { prompt: 0.15,  completion: 0.6   },
  "openai/gpt-4-turbo":               { prompt: 10,    completion: 30    },
  "openai/o1":                        { prompt: 15,    completion: 60    },
  "openai/o1-mini":                   { prompt: 3,     completion: 12    },
  "openai/o1-pro":                    { prompt: 150,   completion: 600   },
  "openai/o3":                        { prompt: 10,    completion: 40    },
  "openai/o3-mini":                   { prompt: 1.1,   completion: 4.4   },
  "openai/o4-mini":                   { prompt: 1.1,   completion: 4.4   },
  // ── Google ────────────────────────────────────────────────────────────
  "google/gemini-2.5-pro":            { prompt: 1.25,  completion: 5     },
  "google/gemini-2.5-flash":          { prompt: 0.15,  completion: 0.6   },
  "google/gemini-2.0-flash":          { prompt: 0.1,   completion: 0.4   },
  "google/gemini-2.0-flash-lite":     { prompt: 0.075, completion: 0.3   },
  "google/gemini-1.5-pro":            { prompt: 1.25,  completion: 5     },
  "google/gemini-1.5-flash":          { prompt: 0.075, completion: 0.3   },
  // ── Meta ──────────────────────────────────────────────────────────────
  "meta-llama/llama-4-maverick":      { prompt: 0.17,  completion: 0.17  },
  "meta-llama/llama-4-scout":         { prompt: 0.08,  completion: 0.08  },
  "meta-llama/llama-3.3-70b-instruct":{ prompt: 0.12,  completion: 0.12  },
  "meta-llama/llama-3.1-405b-instruct":{ prompt: 0.8,  completion: 0.8   },
  "meta-llama/llama-3.1-70b-instruct":{ prompt: 0.1,   completion: 0.1   },
  // ── DeepSeek ──────────────────────────────────────────────────────────
  "deepseek/deepseek-r1":             { prompt: 0.55,  completion: 2.19  },
  "deepseek/deepseek-r1-zero":        { prompt: 0.55,  completion: 2.19  },
  "deepseek/deepseek-v3":             { prompt: 0.27,  completion: 1.1   },
  "deepseek/deepseek-chat":           { prompt: 0.27,  completion: 1.1   },
  // ── Mistral ───────────────────────────────────────────────────────────
  "mistralai/mistral-large":          { prompt: 3,     completion: 9     },
  "mistralai/mistral-medium":         { prompt: 0.4,   completion: 1.2   },
  "mistralai/mistral-small":          { prompt: 0.1,   completion: 0.3   },
  "mistralai/ministral-8b":           { prompt: 0.1,   completion: 0.1   },
  "mistralai/mixtral-8x22b-instruct": { prompt: 0.9,   completion: 0.9   },
  // ── Cohere ────────────────────────────────────────────────────────────
  "cohere/command-r-plus":            { prompt: 2.5,   completion: 10    },
  "cohere/command-r":                 { prompt: 0.15,  completion: 0.6   },
  "cohere/command-a":                 { prompt: 2.5,   completion: 10    },
  // ── xAI ───────────────────────────────────────────────────────────────
  "x-ai/grok-3":                      { prompt: 3,     completion: 15    },
  "x-ai/grok-3-mini":                 { prompt: 0.3,   completion: 0.5   },
  "x-ai/grok-2":                      { prompt: 2,     completion: 10    },
  // ── Amazon ────────────────────────────────────────────────────────────
  "amazon/nova-pro":                  { prompt: 0.8,   completion: 3.2   },
  "amazon/nova-lite":                 { prompt: 0.06,  completion: 0.24  },
};

/**
 * Estimate the dollar cost of one completion.
 *
 * Returns a formatted "$0.0042" string, or `null` when the model isn't in
 * the table so the caller can show "— · cloud" instead.
 */
export function estimateCost(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): string | null {
  // Strip variant suffix (:beta, :free, :extended, …)
  const base = modelId.split(":")[0].toLowerCase();

  // 1. Exact match
  let price: Price | undefined = TABLE[base];

  // 2. Longest-prefix match (e.g. "anthropic/claude-3-5-sonnet-20241022" → "anthropic/claude-3-5-sonnet")
  if (!price) {
    const key = Object.keys(TABLE)
      .filter((k) => base.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (key) price = TABLE[key];
  }

  if (!price) return null;

  const usd =
    (promptTokens * price.prompt + completionTokens * price.completion) /
    1_000_000;

  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return `$${usd.toExponential(1)}`;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
