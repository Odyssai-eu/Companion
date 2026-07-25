/**
 * Resolve the LiteLLM proxy URL + auth for a given user.
 *
 * Precedence (0059 inserted the instance layer in the middle):
 *   1. users.litellm_url / litellm_api_key           (per-user override)
 *   2. global_settings.litellm_url / litellm_api_key (instance default)
 *   3. LITELLM_URL / LITELLM_API_KEY env vars        (deployment fallback)
 *   4. empty string — no LiteLLM proxy resolvable. Callers that need
 *      a real URL must check and surface a user-facing config error.
 *
 * The chain itself lives in server/lib/global-settings.ts; this module is
 * just the LiteLLM-shaped view of it.
 */

import { resolveUserSettingsById } from "./global-settings";

const ENV_URL = process.env.LITELLM_URL;
const ENV_KEY = process.env.LITELLM_API_KEY;
const FALLBACK_URL = "";

export type LiteLLMTarget = {
  baseUrl: string;
  apiKey: string | null;
};

/** Strips trailing slashes so we can append /v1/... safely. */
function trim(s: string): string {
  return s.replace(/\/+$/, "");
}

export async function resolveLiteLLM(userId: string): Promise<LiteLLMTarget> {
  const s = await resolveUserSettingsById(userId);
  // No such user (deleted mid-request): fall back to the env-only view
  // instead of throwing — same shape, and the caller already handles an
  // unreachable/empty base URL.
  if (!s) return defaultLiteLLM();
  return {
    baseUrl: s.litellmUrl ?? FALLBACK_URL,
    apiKey: s.litellmApiKey,
  };
}

/** No-DB version — for /context endpoints called outside a session. */
export function defaultLiteLLM(): LiteLLMTarget {
  return {
    baseUrl: trim(ENV_URL ?? FALLBACK_URL),
    apiKey: ENV_KEY ?? null,
  };
}

export function authHeaders(target: LiteLLMTarget): Record<string, string> {
  return target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {};
}
