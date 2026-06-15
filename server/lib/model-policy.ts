// Model-capability & policy helpers — extracted from chat.ts (issue #16).
//
// Pure-ish model introspection: tool support, the engine capability snapshot,
// the user-facing display label, and the per-provider max_tokens ceiling. None
// of these touch request/route state, so they live here and stay unit-testable.

import { fetchEngineCapabilities } from "./odyssai-capabilities";
import type { OdyssaiModelCapabilities } from "./odyssai-contract";

/** exo models don't accept a `tools=` param — the runner SIGABRTs even for
 *  tool-trained models, so we whitelist by name and never hand them tools. */
export function modelSupportsTools(model: string): boolean {
  const m = model.toLowerCase();
  if (m.startsWith("exo:") || m.startsWith("exo/")) return false;
  return true;
}

/**
 * Pull the Odyssai capability snapshot for a model — `null` when the engine
 * doesn't publish caps for this id (LiteLLM-only aliases, or the engine is
 * unreachable). The caller falls back to a name heuristic in that case.
 * Uses the 60s capability cache shared across requests (no extra fetch).
 */
export async function getModelCaps(
  engineUrl: string | null,
  engineToken: string | null,
  model: string,
): Promise<OdyssaiModelCapabilities | null> {
  if (!engineUrl) return null;
  try {
    const caps = await fetchEngineCapabilities(engineUrl, engineToken);
    return caps.get(model.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the user-facing model label for the StatsRow. When the requested model
 * is a pool alias (e.g. "argo") and the engine reports a concrete `alias_for`
 * path, expand to "argo — Qwen3.5-122B-A10B-MLX-9bit" so the user knows which
 * actual model served the response. Falls back to the raw id when no caps are
 * available, the model is already concrete, or the lookup fails.
 */
export async function resolveModelLabel(
  model: string,
  engineUrl: string | null,
  engineToken: string | null,
): Promise<string> {
  const caps = await getModelCaps(engineUrl, engineToken, model);
  const aliasFor = caps?.alias_for;
  if (!aliasFor || aliasFor === model) return model;
  // alias_for is a filesystem path on the engine side — the basename is the
  // readable model name.
  const concrete = aliasFor.split("/").pop() || aliasFor;
  if (!concrete || concrete === model) return model;
  return `${model} — ${concrete}`;
}

/**
 * Per-provider max_tokens ceiling. Returns `null` when the model is local (we
 * let exo/Inferencer enforce their own limits). Heuristic on the model id
 * surfaced through LiteLLM:
 *   "claude" / "anthropic/…"  → 64k
 *   "gpt-" / "openai/…"       → 16k
 *   anything else (local)     → no clamp
 */
export function maxTokensCap(model: string): number | null {
  const m = model.toLowerCase();
  if (m.startsWith("anthropic/") || m.includes("claude")) return 64_000;
  if (m.startsWith("openai/") || m.startsWith("gpt-")) return 16_384;
  return null;
}
