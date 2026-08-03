// v3 provider factory — the ONE frontier between Companion and model
// providers (PLAN.md V3-a.1, spike-proven 2026-08-03: 4/4).
//
// openai-compatible everywhere (all current targets speak
// chat-completions — engine/CoeOS, LiteLLM legacy; anthropic-direct
// would need a verified /v1/messages target, none exists today).
//
// The custom fetch is the linchpin (review rd1 pt1-2, rd2 pt5):
//  - injects the full house extra-body (session_id, enable_thinking,
//    reasoning_effort, top_k, min_p, repetition_penalty, anti_loop) that
//    the standard adapter would silently drop;
//  - captures response extras (x_odyssai_routed, concrete model) into a
//    per-call capture object for spans / stats / the CoeOS chip.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type ExtraBody = {
  session_id?: string;
  enable_thinking?: boolean;
  reasoning_effort?: string;
  top_k?: number;
  min_p?: number;
  repetition_penalty?: number;
  anti_loop?: boolean;
};

export type RoutedCapture = {
  routed: { router?: string; routed_to?: string; category?: string; concrete?: string } | null;
  responseModel: string | null;
};

export function makeProvider(opts: {
  baseUrl: string;
  apiKey: string | null;
  extraBody: ExtraBody;
  capture: RoutedCapture;
}) {
  const { baseUrl, apiKey, extraBody, capture } = opts;

  const customFetch: typeof fetch = async (url, init) => {
    let request = init;
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        for (const [k, v] of Object.entries(extraBody)) {
          if (v !== undefined) body[k] = v;
        }
        request = { ...init, body: JSON.stringify(body) };
      } catch {
        /* non-JSON body — pass through */
      }
    }
    const res = await fetch(url, request);
    if (!res.body) return res;
    // Tee: branch b scans for routing metadata; the SDK consumes a.
    const [a, b] = res.body.tee();
    void (async () => {
      const reader = b.getReader();
      const dec = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          if (!capture.routed) {
            const m = buf.match(/"x_odyssai_routed"\s*:\s*(\{[^}]*\})/);
            if (m) {
              try {
                capture.routed = JSON.parse(m[1]);
              } catch {
                /* partial JSON — retry on next chunk */
              }
            }
          }
          if (!capture.responseModel) {
            const mm = buf.match(/"model"\s*:\s*"([^"]+)"/);
            if (mm) capture.responseModel = mm[1];
          }
          if (buf.length > 100_000) buf = buf.slice(-10_000);
        }
      } catch {
        /* scan best-effort */
      }
    })();
    return new Response(a, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };

  return createOpenAICompatible({
    name: "odyssai",
    baseURL: baseUrl,
    apiKey: apiKey ?? "unused",
    fetch: customFetch,
  });
}
