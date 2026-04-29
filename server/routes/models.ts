/**
 * Models — pure proxy on LiteLLM /v1/models.
 *
 * Whatever LiteLLM exposes, the user sees. The admin curates the model list
 * by editing ~/litellm/config.yaml on the proxy host. Tags & metadata flow
 * through if LiteLLM publishes them via model_info.
 */

import { Hono } from "hono";
import {
  listLoadedExoModels,
  resolveExoBaseUrl,
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

  let upstream: Response;
  try {
    upstream = await fetch(`${target.baseUrl}/v1/models`, {
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
      id?: string;
      model_info?: { name?: string; tags?: string[] };
    }>;
  } | null;

  const models: GlobalModel[] = (data?.data ?? [])
    .map((m) => {
      const id = m.id ?? "";
      if (!id) return null;
      const info = m.model_info ?? {};
      return {
        id,
        name: info.name ?? id,
        tags: info.tags ?? [],
        capabilities: heuristicCaps(id),
      };
    })
    .filter((m): m is GlobalModel => m !== null);

  // EXO Direct add-on: when enabled, append the currently-loaded models on
  // the user's EXO instance with the `exo-direct/` prefix. The chat route
  // recognises that prefix and bypasses LiteLLM, talking straight to EXO.
  // Useful for A/B-testing whether the proxy adds latency.
  const exoBase = await resolveExoBaseUrl(userId);
  if (exoBase) {
    const exoModels = await listLoadedExoModels(exoBase);
    for (const id of exoModels) {
      const prefixed = `exo-direct/${id}`;
      models.push({
        id: prefixed,
        name: `${id} (direct)`,
        tags: ["EXO Direct"],
        capabilities: heuristicCaps(id),
      });
    }
  }

  // Stable sort: tags grouped, then alpha.
  models.sort((a, b) => {
    const at = a.tags[0] ?? "~";
    const bt = b.tags[0] ?? "~";
    if (at !== bt) return at.localeCompare(bt);
    return a.id.localeCompare(b.id);
  });

  return c.json({ models });
});

/** Cheap heuristic: flag vision / tools by name patterns. The admin can
 *  override by surfacing capability flags in LiteLLM model_info if needed. */
function heuristicCaps(id: string): { vision: boolean; tools: boolean } {
  const s = id.toLowerCase();
  const vision =
    /(?:vl|vision|gemma-?3|gemma-?4|qwen-?vl|llava|claude|gpt-4o|gpt-4-?turbo)/.test(s);
  const tools =
    /(?:claude|gpt-4|gpt-3\.5|qwen|llama-?3|hermes|tool)/.test(s);
  return { vision, tools };
}

export default modelsRoute;
