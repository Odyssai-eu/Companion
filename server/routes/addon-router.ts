/**
 * Semantic Router add-on.
 *
 *   GET   /api/addons/router/info        → { addonId, enabled, configured, embeddingsUrl, policy, anchorsBuiltAt }
 *   PUT   /api/addons/router/config      → set URL + policy, rebuild centroids
 *   POST  /api/addons/router/test        → { input: "…" } → { label, model, score, scores, ms }
 *   POST  /api/addons/router/rebuild     → force re-embed anchors with current URL
 *   GET   /api/addons/router/anchors     → read-only list of bucket anchors (for the UI)
 *
 * The add-on is opt-in. Until the user enables it and sets a valid
 * embeddings URL, model="auto" in chat will 400 with a helpful error.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";
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

async function findOrInit(userId: string) {
  const [existing] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(addons)
    .values({
      userId,
      name: ADDON_NAME,
      kind: "plugin",
      description:
        "Pick the right model automatically based on what you're asking. " +
        "Routes conversation, deep analysis, and code to the model that " +
        "handles each best. Requires an OpenAI-compatible embeddings " +
        "endpoint — point it at any service that exposes one.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

function readConfig(addon: { config: Record<string, unknown> | null }): RouterConfig {
  const raw = (addon.config ?? {}) as Partial<RouterConfig>;
  return {
    embeddingsUrl: typeof raw.embeddingsUrl === "string" ? raw.embeddingsUrl : undefined,
    embeddingsModel: typeof raw.embeddingsModel === "string" ? raw.embeddingsModel : undefined,
    policy: (raw.policy as RouterPolicy) ?? DEFAULT_POLICY,
    anchorCentroids: raw.anchorCentroids,
    anchorsBuiltAt: typeof raw.anchorsBuiltAt === "string" ? raw.anchorsBuiltAt : undefined,
  };
}

/**
 * Load the user's router config in the form chat.ts needs it. Returns
 * null if the add-on doesn't exist, is disabled, or has no centroids.
 * chat.ts calls this on every request with model="auto" — keep it fast.
 */
export async function loadRouterConfigForUser(
  userId: string,
): Promise<RouterConfig | null> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = readConfig(row);
  if (!cfg.embeddingsUrl || !cfg.anchorCentroids) return null;
  return cfg;
}

// ── Endpoints ─────────────────────────────────────────────────────────────

routerRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = readConfig(addon);
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    configured: Boolean(cfg.embeddingsUrl && cfg.anchorCentroids),
    embeddingsUrl: cfg.embeddingsUrl ?? "",
    embeddingsUrlDefault: DEFAULT_EMBEDDINGS_URL,
    embeddingsModel: cfg.embeddingsModel ?? "",
    policy: cfg.policy,
    policyDefault: DEFAULT_POLICY,
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
  rebuildAnchors: z.boolean().optional(),
});

routerRoute.put(
  "/config",
  zValidator("json", configSchema),
  async (c) => {
    const userId = c.get("userId");
    const data = c.req.valid("json");
    const addon = await findOrInit(userId);
    const cfg = readConfig(addon);

    if (typeof data.embeddingsUrl === "string") cfg.embeddingsUrl = data.embeddingsUrl;
    if (data.embeddingsModel !== undefined) {
      cfg.embeddingsModel = data.embeddingsModel ?? undefined;
    }
    if (data.policy) cfg.policy = data.policy;

    // Rebuild centroids if URL changed or explicitly requested. A URL
    // change implies the old embeddings may come from a different model
    // (different dim, different geometry) so the centroids are useless.
    const urlChanged =
      typeof data.embeddingsUrl === "string" &&
      data.embeddingsUrl !== readConfig(addon).embeddingsUrl;
    const needRebuild = data.rebuildAnchors === true || urlChanged;

    if (needRebuild && cfg.embeddingsUrl) {
      try {
        cfg.anchorCentroids = await buildAnchorCentroids(
          cfg.embeddingsUrl,
          cfg.embeddingsModel,
        );
        cfg.anchorsBuiltAt = new Date().toISOString();
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
      config: cfg as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    };
    if (typeof data.enabled === "boolean") updatedPatch.enabled = data.enabled;

    const [updated] = await db
      .update(addons)
      .set(updatedPatch)
      .where(eq(addons.id, addon.id))
      .returning();

    const out = readConfig(updated);
    return c.json({
      ok: true,
      enabled: updated.enabled,
      configured: Boolean(out.embeddingsUrl && out.anchorCentroids),
      embeddingsUrl: out.embeddingsUrl ?? "",
      embeddingsModel: out.embeddingsModel ?? "",
      policy: out.policy,
      anchorsBuiltAt: out.anchorsBuiltAt ?? null,
    });
  },
);

routerRoute.post("/rebuild", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = readConfig(addon);
  if (!cfg.embeddingsUrl) {
    return c.json({ error: "not_configured" }, 400);
  }
  try {
    cfg.anchorCentroids = await buildAnchorCentroids(
      cfg.embeddingsUrl,
      cfg.embeddingsModel,
    );
    cfg.anchorsBuiltAt = new Date().toISOString();
  } catch (e) {
    const msg =
      e instanceof EmbeddingServiceError
        ? e.message
        : `rebuild failed: ${(e as Error).message}`;
    return c.json({ error: "rebuild_failed", detail: msg }, 502);
  }
  await db
    .update(addons)
    .set({ config: cfg as unknown as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(addons.id, addon.id));
  return c.json({ ok: true, anchorsBuiltAt: cfg.anchorsBuiltAt });
});

const testSchema = z.object({
  input: z.string().min(1).max(4000),
});

routerRoute.post("/test", zValidator("json", testSchema), async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
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
