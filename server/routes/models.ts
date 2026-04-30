/**
 * Models — pure proxy on LiteLLM /v1/models.
 *
 * Whatever LiteLLM exposes, the user sees. The admin curates the model list
 * by editing ~/litellm/config.yaml on the proxy host. Tags & metadata flow
 * through if LiteLLM publishes them via model_info.
 */

import { Hono } from "hono";
import {
  listExoEndpoints,
  listLoadedExoModels,
} from "./addon-exo";
import { authHeaders, resolveLiteLLM } from "../lib/litellm";

type Env = { Variables: { userId: string } };
const modelsRoute = new Hono<Env>();

export type GlobalModel = {
  id: string;
  /** Optional human label — falls back to `id` when LiteLLM doesn't provide one. */
  name: string;
  /** Optional grouping tag(s) the admin can set in litellm/config.yaml under
   *  model_info.tags. Useful to render "Local" / "Cloud" / "Reasoning" groups. */
  tags: string[];
  /** Coarse capability flags. Heuristic on the id when LiteLLM doesn't expose. */
  capabilities: {
    vision: boolean;
    tools: boolean;
  };
};

modelsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const target = await resolveLiteLLM(userId);

  // Use LiteLLM's /model/info — richer than /v1/models, returns per-model
  // litellm_params (the underlying upstream model id) and model_info flags.
  // We need litellm_params.model so the heuristic can detect capabilities
  // from the actual backend model name (e.g. `gemma-4-26b-a4b`) rather than
  // just the user-facing alias (e.g. `agent-fast`).
  let upstream: Response;
  try {
    upstream = await fetch(`${target.baseUrl}/model/info`, {
      headers: authHeaders(target),
    });
  } catch (err) {
    return c.json(
      { error: "litellm_unreachable", detail: String(err), models: [] },
      502,
    );
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    return c.json(
      { error: "litellm_error", status: upstream.status, body: text, models: [] },
      upstream.status as 401 | 500 | 502,
    );
  }

  const data = (await upstream.json().catch(() => null)) as {
    data?: Array<{
      model_name?: string;
      litellm_params?: { model?: string };
      model_info?: {
        name?: string;
        tags?: string[];
        supports_vision?: boolean;
        supports_function_calling?: boolean;
      };
    }>;
  } | null;

  const seen = new Set<string>();
  const models: GlobalModel[] = (data?.data ?? [])
    .map((m) => {
      const id = m.model_name ?? "";
      if (!id || seen.has(id)) return null;
      seen.add(id);
      const info = m.model_info ?? {};
      const upstreamModel = m.litellm_params?.model ?? "";
      // 1. Honour explicit LiteLLM flags when present.
      // 2. Fallback to heuristic on alias + upstream model path together —
      //    the upstream path (e.g. ".../gemma-4-26b...") is much more
      //    reliable than the alias ("agent-fast") for capability detection.
      const heuristic = heuristicCaps(`${id} ${upstreamModel}`);
      return {
        id,
        name: info.name ?? id,
        tags: info.tags ?? [],
        capabilities: {
          vision: info.supports_vision ?? heuristic.vision,
          tools: info.supports_function_calling ?? heuristic.tools,
        },
      };
    })
    .filter((m): m is GlobalModel => m !== null);

  // EXO Direct add-on: surface every loaded model on every configured
  // endpoint. Each model id is namespaced by endpoint id so the chat route
  // can route the request to the right cluster.
  const endpoints = await listExoEndpoints(userId);
  await Promise.all(
    endpoints.map(async (ep) => {
      const exoModels = await listLoadedExoModels(ep.baseUrl);
      for (const id of exoModels) {
        models.push({
          id: `exo-direct/${ep.id}/${id}`,
          name: `${id} · ${ep.label}`,
          tags: [`EXO · ${ep.label}`],
          capabilities: heuristicCaps(id),
        });
      }
    }),
  );

  // Stable sort: tags grouped, then alpha.
  models.sort((a, b) => {
    const at = a.tags[0] ?? "~";
    const bt = b.tags[0] ?? "~";
    if (at !== bt) return at.localeCompare(bt);
    return a.id.localeCompare(b.id);
  });

  return c.json({ models });
});

/** Cheap heuristic: flag vision / tools by name patterns. We test against
 *  alias + underlying upstream model path together — the alias may be
 *  uninformative ("agent-fast") but the upstream typically reveals the
 *  actual family ("gemma-4-26b-a4b" → vision-capable). LiteLLM admin can
 *  also set explicit `supports_vision` / `supports_function_calling` flags
 *  in model_info to short-circuit this. */
function heuristicCaps(s: string): { vision: boolean; tools: boolean } {
  const lower = s.toLowerCase();
  const vision =
    /(?:vl|vision|gemma-?3|gemma-?4|qwen-?vl|qwen-?3\.6|qwen3_5_moe|llava|claude|gpt-4o|gpt-4-?turbo|minimax-m2)/.test(
      lower,
    );
  const tools =
    /(?:claude|gpt-4|gpt-3\.5|qwen|llama-?3|hermes|tool)/.test(lower);
  return { vision, tools };
}

export default modelsRoute;
