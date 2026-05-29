/**
 * Models — resolves the model list per provider mode.
 *
 *   gateway → single GET on engine /v1/models, every entry already
 *             carries x_odyssai. No LiteLLM call. Cloud aliases (backend
 *             "http-proxy") appear side-by-side with local pools.
 *   hybrid  → LiteLLM /model/info is the source of truth for ids and
 *             tags, engine /v1/models is merged in for caps. Used when
 *             the engine doesn't declare cloud-passthrough or when the
 *             admin keeps LiteLLM for budget / cascade fallback.
 *   legacy  → LiteLLM only. Caps come from explicit model_info flags
 *             + a name-pattern heuristic. No engine paired.
 *
 * When `litellm_disabled` is true the user has explicitly turned off
 * the LiteLLM rail — hybrid degrades to gateway-style listing if an
 * engine is paired, otherwise we return an empty list with an error.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { users } from "../db/schema";
import { authHeaders, resolveLiteLLM } from "../lib/litellm";
import { fetchEngineCapabilities } from "../lib/odyssai-capabilities";
import type {
  OdyssaiModelCapabilities,
  OdyssaiModelList,
} from "../lib/odyssai-contract";

type Env = { Variables: { userId: string } };
const modelsRoute = new Hono<Env>();

export type GlobalModel = {
  id: string;
  name: string;
  tags: string[];
  capabilities: {
    vision: boolean;
    tools: boolean;
  };
  odyssai?: OdyssaiModelCapabilities;
};

modelsRoute.get("/", async (c) => {
  const userId = c.get("userId");

  const [me] = await db
    .select({
      engineUrl: users.engineUrl,
      engineToken: users.engineToken,
      engineMode: users.engineMode,
      litellmDisabled: users.litellmDisabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!me) return c.json({ error: "user_not_found", models: [] }, 404);

  const effectiveMode: "gateway" | "hybrid" | "legacy" = (() => {
    // If LiteLLM is off and we have an engine, force gateway-style
    // listing regardless of whether the engine declared
    // cloud-passthrough. The user explicitly said "go direct".
    if (me.litellmDisabled && me.engineUrl) return "gateway";
    return (me.engineMode ?? "legacy") as "gateway" | "hybrid" | "legacy";
  })();

  if (effectiveMode === "gateway") {
    if (!me.engineUrl) {
      return c.json(
        { error: "no_engine_configured", models: [] },
        400,
      );
    }
    return c.json({ models: await listGateway(me.engineUrl, me.engineToken) });
  }

  if (effectiveMode === "legacy" && me.litellmDisabled) {
    return c.json(
      {
        error: "no_provider",
        detail:
          "LiteLLM is disabled and no Odyssai engine is paired. Join the Odyssai or re-enable LiteLLM.",
        models: [],
      },
      400,
    );
  }

  // Hybrid + legacy both go through LiteLLM. Hybrid layers Odyssai
  // capabilities on top when an engine_url is set.
  const target = await resolveLiteLLM(userId);
  const odyssaiCaps =
    effectiveMode === "hybrid" && me.engineUrl
      ? await fetchEngineCapabilities(me.engineUrl, me.engineToken)
      : new Map<string, OdyssaiModelCapabilities>();

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
      {
        error: "litellm_error",
        status: upstream.status,
        body: text,
        models: [],
      },
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
      const heuristic = heuristicCaps(`${id} ${upstreamModel}`);
      const odyssai = odyssaiCaps.get(id.toLowerCase());
      const visionFinal =
        odyssai?.supports_vision ??
        info.supports_vision ??
        heuristic.vision;
      const toolsFinal =
        odyssai?.supports_tools ??
        info.supports_function_calling ??
        heuristic.tools;
      return {
        id,
        name: info.name ?? id,
        tags: info.tags ?? [],
        capabilities: {
          vision: visionFinal,
          tools: toolsFinal,
        },
        ...(odyssai ? { odyssai } : {}),
      };
    })
    .filter((m): m is GlobalModel => m !== null);

  models.sort((a, b) => {
    const at = a.tags[0] ?? "~";
    const bt = b.tags[0] ?? "~";
    if (at !== bt) return at.localeCompare(bt);
    return a.id.localeCompare(b.id);
  });

  return c.json({ models });
});

/**
 * Gateway listing — single source of truth, single round-trip. Every
 * model in the response already carries x_odyssai, which we copy into
 * the GlobalModel.odyssai field and use to derive the coarse capability
 * flags (vision/tools). No heuristic fallback needed — if the engine
 * doesn't declare a flag, we treat it as false, deliberately.
 */
async function listGateway(
  engineUrl: string,
  engineToken: string | null,
): Promise<GlobalModel[]> {
  const url = engineUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (engineToken) headers.authorization = `Bearer ${engineToken}`;

  let r: Response;
  try {
    r = await fetch(`${url}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return [];
  }
  if (!r.ok) return [];

  const list = (await r.json().catch(() => null)) as OdyssaiModelList | null;
  if (!list?.data) return [];

  const models: GlobalModel[] = list.data.map((m) => {
    const caps = m.x_odyssai;
    // Group bucket derivation, in priority order :
    //   1. kind=telemak  → "telemak" (all Telemak clusters bucketed together)
    //   2. kind=mlx-distributed → cluster_label (e.g. "Argo") so the heading
    //      reflects the operator-chosen display name instead of the pool id
    //      ("main") which long ago lost its "main" meaning.
    //   3. http-proxy backend without kind = legacy cloud alias  → "cloud"
    //   4. anything else → caps.pool ?? "local" (back-compat)
    const tag = (() => {
      if (caps?.kind === "telemak") return "telemak";
      if (caps?.kind === "mlx-distributed" && caps.cluster_label) {
        return caps.cluster_label.toLowerCase();
      }
      if (caps?.backend === "http-proxy") return "cloud";
      return caps?.pool ?? "local";
    })();
    // Display name : for Telemak entries we surface the cluster's display
    // label ("TeleCoder") rather than the cluster id ("telemak-code-next").
    // Loaded model + quant flow into the subtitle via caps.family /
    // caps.quantization so the row still shows what's running.
    const name = caps?.kind === "telemak" && caps.cluster_label
      ? caps.cluster_label
      : m.id;
    return {
      id: m.id,
      name,
      tags: [tag],
      capabilities: {
        vision: caps?.supports_vision ?? false,
        tools: caps?.supports_tools ?? false,
      },
      ...(caps ? { odyssai: caps } : {}),
    };
  });

  models.sort((a, b) => {
    const at = a.tags[0] ?? "~";
    const bt = b.tags[0] ?? "~";
    if (at !== bt) return at.localeCompare(bt);
    return a.id.localeCompare(b.id);
  });

  return models;
}

function heuristicCaps(s: string): { vision: boolean; tools: boolean } {
  const lower = s.toLowerCase();
  const vision =
    /(?:vl|vision|gemma-?3|gemma-?4|qwen-?vl|qwen-?3\.6|qwen3_5_moe|llava|claude|gpt-4o|gpt-4-?turbo|minimax-m2)/.test(
      lower,
    );
  const tools = /(?:claude|gpt-4|gpt-3\.5|qwen|llama-?3|hermes|tool)/.test(
    lower,
  );
  return { vision, tools };
}

export default modelsRoute;
