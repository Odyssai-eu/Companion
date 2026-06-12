/**
 * Per-user-engine capability cache. Holds the parsed `x_odyssai` map
 * keyed by lowercased model id, refreshed on a 60s TTL.
 *
 * Why a cache: the `/api/models` endpoint is hit on every model picker
 * render and on every conv load (in some flows). Hitting OdyssAI-X on
 * each of those would multiply the load + add latency for no gain —
 * the capability set changes only when models load/unload.
 *
 * Cache key = engine URL (NOT user id). Two users pointing at the
 * same engine share the cache. Right semantics: capabilities are a
 * property of the engine, not the consumer.
 */

import type {
  OdyssaiModelCapabilities,
  OdyssaiModelList,
} from "./odyssai-contract";

const CACHE = new Map<
  string,
  { ts: number; caps: Map<string, OdyssaiModelCapabilities> }
>();
const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

/**
 * Fetch capabilities from an engine URL, with 60s TTL cache. Returns
 * an empty Map on any failure — the caller falls back to heuristics.
 *
 * Lowercase normalisation handles the well-known LiteLLM vs OdyssAI-X
 * casing skew (`Argo` vs `argo`). Both alias id and `x_concrete` are
 * indexed so consumers can look up either name.
 */
export async function fetchEngineCapabilities(
  engineUrl: string,
  engineToken?: string | null,
): Promise<Map<string, OdyssaiModelCapabilities>> {
  const url = engineUrl.replace(/\/+$/, "");
  const cached = CACHE.get(url);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.caps;

  const caps = new Map<string, OdyssaiModelCapabilities>();
  const headers: Record<string, string> = {};
  if (engineToken) headers.authorization = `Bearer ${engineToken}`;

  try {
    const r = await fetch(`${url}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (r.ok) {
      const list = (await r.json()) as OdyssaiModelList;
      for (const m of list.data ?? []) {
        if (!m.x_odyssai) continue;
        caps.set(m.id.toLowerCase(), m.x_odyssai);
        if (m.x_concrete) {
          caps.set(m.x_concrete.toLowerCase(), m.x_odyssai);
        }
      }
    } else {
      console.warn(`[odyssai-caps] ${url}/v1/models → ${r.status}`);
    }
  } catch (e) {
    console.warn(`[odyssai-caps] ${url} fetch failed:`, (e as Error).message);
  }

  CACHE.set(url, { ts: Date.now(), caps });
  return caps;
}

/** Drop the cached entry for an engine URL — call from the Test
 *  button so the user sees fresh results after editing config. */
export function invalidateEngineCache(engineUrl?: string): void {
  if (engineUrl) CACHE.delete(engineUrl.replace(/\/+$/, ""));
  else CACHE.clear();
}
