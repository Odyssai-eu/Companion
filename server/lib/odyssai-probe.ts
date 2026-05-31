/**
 * Engine probe — hit `/.well-known/inference-engine.json` then `/v1/models`
 * to discover whether a URL is an Odyssai-compatible engine, what
 * version, and how many models it currently knows about.
 *
 * Backs the "Test" button in Settings → Inference. Never throws — the
 * caller renders the result. Short timeouts so the UI stays snappy.
 */

import type {
  OdyssaiEngineMeta,
  OdyssaiModelList,
} from "./odyssai-contract";
import { assertFetchTargetAllowed } from "./net-guard";

export type ProbeResult = {
  /** True if either /.well-known or /v1/models returned a 2xx. */
  reachable: boolean;
  /** True iff /.well-known is present AND vendor === "odyssai.eu". */
  isOdyssai: boolean;
  meta?: OdyssaiEngineMeta;
  authRequired: boolean;
  authProvided: boolean;
  modelsReachable: boolean;
  modelsCount?: number;
  /** True iff features includes "cloud-passthrough" — gateway mode possible. */
  supportsGateway: boolean;
  /** Count of model entries with backend === "http-proxy" (cloud aliases). */
  cloudAliasesCount: number;
  /** First error encountered, for surfacing in the UI when reachable=false. */
  error?: string;
};

export async function probeEngine(
  capabilityUrl: string,
  capabilityToken?: string | null,
): Promise<ProbeResult> {
  const url = capabilityUrl.replace(/\/+$/, "");
  // SSRF guard: reject metadata/link-local/unspecified targets (#3). LAN/RFC1918
  // stays allowed (probing the LAN engine is the point). Never throws — surface
  // the block as an unreachable result.
  try {
    await assertFetchTargetAllowed(url);
  } catch (e) {
    return {
      reachable: false,
      isOdyssai: false,
      authRequired: false,
      authProvided: !!capabilityToken,
      modelsReachable: false,
      supportsGateway: false,
      cloudAliasesCount: 0,
      error: (e as Error).message,
    };
  }
  let meta: OdyssaiEngineMeta | undefined;
  let isOdyssai = false;
  let modelsReachable = false;
  let modelsCount: number | undefined;
  let firstError: string | undefined;

  // /.well-known is the truth source for vendor detection. Errors here
  // aren't fatal — many engines won't expose the contract; we still
  // try /v1/models to confirm reachability.
  try {
    const r = await fetch(`${url}/.well-known/inference-engine.json`, {
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      meta = (await r.json()) as OdyssaiEngineMeta;
      isOdyssai = meta?.vendor === "odyssai.eu";
    }
  } catch (e) {
    firstError = (e as Error).message;
  }

  // /v1/models is the standard OpenAI-compat endpoint — every provider
  // we care about exposes it. Auth token goes in only when supplied;
  // public routes on Odysseus ignore it anyway.
  const headers: Record<string, string> = {};
  if (capabilityToken) headers.authorization = `Bearer ${capabilityToken}`;
  let cloudAliasesCount = 0;
  try {
    const r = await fetch(`${url}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    modelsReachable = r.ok;
    if (r.ok) {
      const list = (await r.json()) as OdyssaiModelList;
      modelsCount = Array.isArray(list.data) ? list.data.length : 0;
      cloudAliasesCount = (list.data || []).filter(
        (m) => m.x_odyssai?.backend === "http-proxy",
      ).length;
    } else if (!firstError) {
      firstError = `models ${r.status}`;
    }
  } catch (e) {
    if (!firstError) firstError = (e as Error).message;
  }

  return {
    reachable: !!meta || modelsReachable,
    isOdyssai,
    meta,
    authRequired: !!meta?.auth?.required,
    authProvided: !!capabilityToken,
    modelsReachable,
    modelsCount,
    supportsGateway:
      isOdyssai && !!meta?.features?.includes("cloud-passthrough"),
    cloudAliasesCount,
    error: firstError,
  };
}
