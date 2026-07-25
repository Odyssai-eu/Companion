/**
 * Semantic Router add-on.
 *
 *   GET   /api/addons/router/info        → { addonId, enabled, configured, embeddingsUrl, policy, fallbackModel, anchorsBuiltAt }
 *   PUT   /api/addons/router/config      → set URL + policy + fallback model, rebuild centroids
 *   POST  /api/addons/router/test        → { input: "…" } → { label, model, score, scores, ms }
 *   POST  /api/addons/router/rebuild     → force re-embed anchors with current URL
 *   GET   /api/addons/router/anchors     → read-only list of bucket anchors (for the UI)
 *
 * The add-on is opt-in. Until the user enables it and sets a valid
 * embeddings URL, the chat can't route: it surfaces the reason to the user
 * and completes the turn on `fallbackModel` if one is configured, or fails
 * with a helpful error if not.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";
import {
  materializeUserAddon,
  pruneInheritedEchoes,
  readOwnAddonConfig,
  resolveKnownAddon,
} from "../lib/instance-rows";
import {
  buildAnchorCentroids,
  routeMessage,
  getAnchors,
  DEFAULT_POLICY,
  DEFAULT_EMBEDDINGS_URL,
  EmbeddingServiceError,
  type RouterConfig,
  type RouterPolicy,
} from "../lib/semantic-router";

type Env = { Variables: { userId: string } };
const routerRoute = new Hono<Env>();

const ADDON_NAME = "Auto Router";

/** Own row over instance row, key by key. Replaces findOrInit(): resolution
 *  never writes.
 *
 *  `embeddingsModel`, `anchorCentroids` and `anchorsBuiltAt` are paired to
 *  `embeddingsUrl` (PAIRED_CONFIG_KEYS in server/lib/instance-rows.ts): a
 *  user pointing at their own embedding service inherits none of the
 *  three, because centroids computed elsewhere have the wrong dimensions
 *  and the wrong geometry — this route already rebuilds them whenever the
 *  URL changes, for exactly that reason. */
async function loadRouterAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
}

function readConfig(addon: { config: Record<string, unknown> | null }): RouterConfig {
  const raw = (addon.config ?? {}) as Partial<RouterConfig>;
  return {
    embeddingsUrl: typeof raw.embeddingsUrl === "string" ? raw.embeddingsUrl : undefined,
    embeddingsModel: typeof raw.embeddingsModel === "string" ? raw.embeddingsModel : undefined,
    policy: (raw.policy as RouterPolicy) ?? DEFAULT_POLICY,
    fallbackModel: typeof raw.fallbackModel === "string" ? raw.fallbackModel : undefined,
    anchorCentroids: raw.anchorCentroids,
    anchorsBuiltAt: typeof raw.anchorsBuiltAt === "string" ? raw.anchorsBuiltAt : undefined,
  };
}

/** What `loadRouterAddonForUser` hands back. `ready` is the old
 *  "can we actually route?" predicate; `cfg` is present whenever the
 *  add-on row exists, ready or not, so callers can still read the
 *  fallback model out of a router that can't route. */
export type RouterAddonState = {
  cfg: RouterConfig | null;
  ready: boolean;
  /** Human-readable reason `ready` is false. null when ready. */
  reason: string | null;
};

/**
 * Load the user's Auto Router add-on state in one query.
 *
 * Split out of `loadRouterConfigForUser` (0058) because the fallback path
 * needs the config precisely in the cases where routing is NOT possible —
 * the old function returned null there, throwing away the fallback model
 * along with everything else.
 *
 * chat.ts calls this on every request whose model id is the routing
 * sentinel — keep it to a single indexed lookup.
 */
export async function loadRouterAddonForUser(
  userId: string,
): Promise<RouterAddonState> {
  const row = await loadRouterAddon(userId);
  // "No row" no longer exists as a state: the catalogue always resolves, so
  // the honest reason for an unconfigured router is now "never set up",
  // meaning neither this account nor the instance has configured it.
  const cfg = readConfig(row);
  if (!row.enabled) {
    return { cfg, ready: false, reason: "the Auto Router add-on is turned off" };
  }
  if (!cfg.embeddingsUrl) {
    return { cfg, ready: false, reason: "the Auto Router has no embedding service URL" };
  }
  if (!cfg.anchorCentroids) {
    return { cfg, ready: false, reason: "the Auto Router's anchors have never been built" };
  }
  return { cfg, ready: true, reason: null };
}

/**
 * Load the user's router config in the form the tool-intent callers need
 * it. Returns null if the add-on doesn't exist, is disabled, or has no
 * centroids — i.e. "we cannot route".
 *
 * Thin wrapper over `loadRouterAddonForUser` kept for the callers that
 * only care about the ready/not-ready binary (chat-tools, help).
 */
export async function loadRouterConfigForUser(
  userId: string,
): Promise<RouterConfig | null> {
  const { cfg, ready } = await loadRouterAddonForUser(userId);
  return ready ? cfg : null;
}

// ── Endpoints ─────────────────────────────────────────────────────────────

routerRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await loadRouterAddon(userId);
  const cfg = readConfig(addon);
  return c.json({
    addonId: addon.id,
    inherited: addon.inherited,
    inheritedConfigKeys: addon.inheritedConfigKeys,
    enabled: addon.enabled,
    configured: Boolean(cfg.embeddingsUrl && cfg.anchorCentroids),
    embeddingsUrl: cfg.embeddingsUrl ?? "",
    embeddingsUrlDefault: DEFAULT_EMBEDDINGS_URL,
    embeddingsModel: cfg.embeddingsModel ?? "",
    policy: cfg.policy,
    policyDefault: DEFAULT_POLICY,
    fallbackModel: cfg.fallbackModel ?? "",
    anchorsBuiltAt: cfg.anchorsBuiltAt ?? null,
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  embeddingsUrl: z.string().url().max(300).optional(),
  embeddingsModel: z.string().max(200).nullish(),
  policy: z
    .object({
      chat: z.string().min(1).max(120),
      deep: z.string().min(1).max(120),
      code: z.string().min(1).max(120),
    })
    .optional(),
  // Model that answers when routing can't run. "" / null clears it, which
  // restores the fail-loud behaviour (no answer, just the error).
  fallbackModel: z.string().max(120).nullish(),
  rebuildAnchors: z.boolean().optional(),
});

/**
 * The routing sentinel is not a real model — chat.ts intercepts it. Bind a
 * bucket or the fallback to it and the router hands "auto" back to itself:
 * the chat route has already passed its interception point, so the literal
 * string goes upstream and the engine 404s on a model that doesn't exist.
 *
 * The UI can't produce this (its pickers pass includeAuto={false} and
 * filter the id out), but the API is reachable directly, so the guard
 * lives here. Kept case-insensitive because model ids are matched
 * case-insensitively elsewhere in the stack.
 */
const SENTINEL_MODEL_ID = "auto";
function isSentinel(id: string | null | undefined): boolean {
  return (id ?? "").trim().toLowerCase() === SENTINEL_MODEL_ID;
}

routerRoute.put(
  "/config",
  zValidator("json", configSchema),
  async (c) => {
    const userId = c.get("userId");
    const data = c.req.valid("json");

    const selfReferential = [
      ["fallbackModel", data.fallbackModel] as const,
      ["policy.chat", data.policy?.chat] as const,
      ["policy.deep", data.policy?.deep] as const,
      ["policy.code", data.policy?.code] as const,
    ].filter(([, v]) => isSentinel(v));
    if (selfReferential.length > 0) {
      return c.json(
        {
          error: "self_referential_model",
          detail:
            `"${SENTINEL_MODEL_ID}" is the router's own id and can't be used as ` +
            `a target (${selfReferential.map(([k]) => k).join(", ")}). ` +
            "Pick a concrete model your engine publishes.",
        },
        422,
      );
    }

    // Copy-on-write + delta write — see the note in addon-parser.ts. `eff`
    // is what the router is actually running on right now (own over
    // instance); `cfg` is the caller's own config and the only thing that
    // gets written back.
    const eff = readConfig(await loadRouterAddon(userId));
    const ownId = await materializeUserAddon(userId, ADDON_NAME);
    // The RAW own blob, not readConfig()'s output: readConfig substitutes
    // DEFAULT_POLICY for an absent `policy` (l.61), so writing its result
    // back would stamp an empty {chat:"",deep:"",code:""} onto the caller's
    // row as a real override the moment they save anything else — and that
    // override then shadows the instance policy for good. Absent stays
    // absent; a key is written only when this request carries it, and
    // clearing a field DELETES the key so it inherits again.
    const own = { ...((await readOwnAddonConfig(userId, ADDON_NAME)) ?? {}) };
    // Own keys before this request — see pruneInheritedEchoes.
    const before = { ...own };
    const setOrClear = (key: string, value: string | undefined) => {
      if (value) own[key] = value;
      else delete own[key];
    };

    if (typeof data.embeddingsUrl === "string") {
      setOrClear("embeddingsUrl", data.embeddingsUrl);
    }
    if (data.embeddingsModel !== undefined) {
      setOrClear("embeddingsModel", data.embeddingsModel ?? undefined);
    }
    if (data.policy) own.policy = data.policy;
    if (data.fallbackModel !== undefined) {
      setOrClear("fallbackModel", data.fallbackModel?.trim() || undefined);
    }
    const cfg = readConfig({ config: own });

    // Rebuild centroids if URL changed or explicitly requested. A URL
    // change implies the old embeddings may come from a different model
    // (different dim, different geometry) so the centroids are useless.
    //
    // Compared against the caller's OWN previous URL, not the effective
    // one: the moment they write a URL of their own they stop inheriting
    // the instance's centroids (they are paired to the URL — see
    // instance-rows.ts), so a first personal URL always needs a rebuild
    // even when it happens to equal the instance's.
    const ownBefore = readConfig({
      config: await readOwnAddonConfig(userId, ADDON_NAME),
    });
    const urlChanged =
      typeof data.embeddingsUrl === "string" &&
      data.embeddingsUrl !== ownBefore.embeddingsUrl;
    const needRebuild = data.rebuildAnchors === true || urlChanged;

    // Fall back to the inherited endpoint so a plain "rebuild" from an
    // account that inherits everything still works; the centroids it
    // produces land on that account's own row.
    const rebuildUrl = cfg.embeddingsUrl ?? eff.embeddingsUrl;
    const rebuildModel = cfg.embeddingsModel ?? eff.embeddingsModel;
    if (needRebuild && rebuildUrl) {
      try {
        own.anchorCentroids = await buildAnchorCentroids(
          rebuildUrl,
          rebuildModel,
        );
        own.anchorsBuiltAt = new Date().toISOString();
      } catch (e) {
        const msg =
          e instanceof EmbeddingServiceError
            ? e.message
            : `rebuild failed: ${(e as Error).message}`;
        return c.json({ error: "rebuild_failed", detail: msg }, 502);
      }
    }

    const updatedPatch: {
      config: Record<string, unknown>;
      updatedAt: Date;
      enabled?: boolean;
    } = {
      config: await pruneInheritedEchoes(ADDON_NAME, before, own),
      updatedAt: new Date(),
    };
    if (typeof data.enabled === "boolean") updatedPatch.enabled = data.enabled;

    await db.update(addons).set(updatedPatch).where(eq(addons.id, ownId));

    const updated = await loadRouterAddon(userId);
    const out = readConfig(updated);
    return c.json({
      ok: true,
      enabled: updated.enabled,
      configured: Boolean(out.embeddingsUrl && out.anchorCentroids),
      embeddingsUrl: out.embeddingsUrl ?? "",
      embeddingsModel: out.embeddingsModel ?? "",
      policy: out.policy,
      fallbackModel: out.fallbackModel ?? "",
      anchorsBuiltAt: out.anchorsBuiltAt ?? null,
    });
  },
);

routerRoute.post("/rebuild", async (c) => {
  const userId = c.get("userId");
  // Rebuild against the EFFECTIVE endpoint, persist onto the caller's OWN
  // row. Anything else would have this route write a shared cache from an
  // unprivileged request.
  const eff = readConfig(await loadRouterAddon(userId));
  if (!eff.embeddingsUrl) {
    return c.json({ error: "not_configured" }, 400);
  }
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  // Patch the RAW own config, never the object `readConfig()` returns.
  // readConfig substitutes DEFAULT_POLICY for an absent `policy` (l.61) and
  // spells every other key out as undefined; persisting its output would
  // write those materialised defaults onto the caller's row. For an inheritor
  // that means an empty {chat:"",deep:"",code:""} policy landing as a real
  // override that shadows the instance's — after which every turn hits the
  // "no model is mapped to that bucket" guard in chat.ts. One click on
  // Rebuild, and the routing this add-on exists to do is silently dead.
  // Only the two anchor keys belong to this route.
  const own = { ...((await readOwnAddonConfig(userId, ADDON_NAME)) ?? {}) };
  let anchorsBuiltAt: string;
  try {
    own.anchorCentroids = await buildAnchorCentroids(
      eff.embeddingsUrl,
      eff.embeddingsModel,
    );
    anchorsBuiltAt = new Date().toISOString();
    own.anchorsBuiltAt = anchorsBuiltAt;
  } catch (e) {
    const msg =
      e instanceof EmbeddingServiceError
        ? e.message
        : `rebuild failed: ${(e as Error).message}`;
    return c.json({ error: "rebuild_failed", detail: msg }, 502);
  }
  await db
    .update(addons)
    .set({ config: own, updatedAt: new Date() })
    .where(eq(addons.id, ownId));
  return c.json({ ok: true, anchorsBuiltAt });
});

const testSchema = z.object({
  input: z.string().min(1).max(4000),
});

routerRoute.post("/test", zValidator("json", testSchema), async (c) => {
  const userId = c.get("userId");
  const addon = await loadRouterAddon(userId);
  const cfg = readConfig(addon);
  if (!cfg.embeddingsUrl) {
    return c.json({ error: "not_configured" }, 400);
  }
  if (!cfg.anchorCentroids) {
    return c.json({ error: "anchors_not_built" }, 400);
  }
  try {
    const result = await routeMessage(c.req.valid("json").input, cfg);
    return c.json(result);
  } catch (e) {
    const msg =
      e instanceof EmbeddingServiceError
        ? e.message
        : `route_failed: ${(e as Error).message}`;
    return c.json({ error: "route_failed", detail: msg }, 502);
  }
});

routerRoute.get("/anchors", (c) => {
  return c.json({ anchors: getAnchors() });
});

export default routerRoute;
