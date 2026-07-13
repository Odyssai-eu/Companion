/**
 * Model origin classifier — local vs cloud vs router.
 *
 * The single source of truth for "where does this model actually run",
 * used by the Confidential Guard (chat.ts) AND the model picker filter.
 *
 * Discriminator = `owned_by`, verified authoritative across the whole
 * fleet (2026-07-13, /v1/models on .39):
 *   odyssai-coeos    → router  (CoeOS full — decides local/cloud downstream,
 *                               so we can't know pre-flight; the guard blocks)
 *   odyssai-cloud-*  → cloud   (every external provider bucket: OpenRouter,
 *                               MiniMax, Mimo, Audio, Coeos-SE, …)
 *   odyssai-*        → local   (odyssai-main native JACCL, odyssai-telemak, …)
 *   else / absent    → cloud   (fail-safe: never treat an unknown as local)
 *
 * NOT derived from `upstream` or `backend`: native distributed pools
 * (kind=mlx-distributed, backend=jaccl) have a NULL upstream, which the
 * old "upstream is an http:// URL = local" heuristic would misclassify
 * as cloud. `owned_by` has no such hole.
 */

export type ModelOrigin = "local" | "cloud" | "router";

/** The virtual id CoeOS advertises. Matched case-insensitively as a
 *  backstop for when the router model isn't in the resolved list. */
const COEOS_ID = "coeos";

export function classifyOrigin(entry: {
  id?: string | null;
  owned_by?: string | null;
}): ModelOrigin {
  if ((entry.id ?? "").toLowerCase() === COEOS_ID) return "router";
  const owned = (entry.owned_by ?? "").toLowerCase();
  if (owned === "odyssai-coeos") return "router";
  if (owned.startsWith("odyssai-cloud-")) return "cloud";
  if (owned.startsWith("odyssai-")) return "local";
  return "cloud";
}
