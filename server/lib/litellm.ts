/**
 * Resolve the LiteLLM proxy URL + auth for a given user.
 *
 * Precedence:
 *   1. user.litellmUrl / user.litellmApiKey  (per-user override)
 *   2. LITELLM_URL / LITELLM_API_KEY env vars (instance default)
 *   3. empty string — no LiteLLM proxy resolvable. Callers that need
 *      a real URL must check and surface a user-facing config error.
 */

import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema";

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
  const [u] = await db
    .select({
      url: users.litellmUrl,
      key: users.litellmApiKey,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return {
    baseUrl: trim(u?.url ?? ENV_URL ?? FALLBACK_URL),
    apiKey: u?.key ?? ENV_KEY ?? null,
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
  return target.apiKey
    ? { Authorization: `Bearer ${target.apiKey}` }
    : {};
}
