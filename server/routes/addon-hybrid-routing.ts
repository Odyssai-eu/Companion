/**
 * Hybrid Routing add-on (#40, scope A).
 *
 *   GET   /api/addons/hybrid-routing/info     → { addonId, enabled, mode, cloudModel }
 *   PATCH /api/addons/hybrid-routing/config    → set mode + cloudModel
 *
 * Two modes:
 *   - "local"  (default) — current behaviour. The Auto Router (or the
 *     explicit model pick) handles everything. Hybrid is a no-op.
 *   - "hybrid" — auto-routed traffic (body.model === "auto") goes to ONE
 *     user-chosen cloud model INSTEAD of the local Auto Router. An explicit
 *     model pick (body.model !== "auto") is always respected — hybrid never
 *     forces the cloud model over a deliberate choice.
 *
 * chat.ts consumes loadHybridConfigForUser() at the top of its
 * `if (body.model === "auto")` branch (modeled on loadRouterConfigForUser).
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const hybridRoutingRoute = new Hono<Env>();

const ADDON_NAME = "Hybrid Routing";
const ADDON_DESCRIPTION =
  "Route auto-picked chat to a cloud model instead of the local Auto Router. " +
  "Switch to Hybrid and choose one cloud model — auto-routed traffic goes " +
  "there. Explicit model picks are always respected. Local keeps everything " +
  "on the cluster.";

export type HybridMode = "local" | "hybrid";

type Config = {
  /** Which mode the add-on runs in. Defaults to 'local' (no-op). */
  mode?: HybridMode;
  /** The cloud model id auto-routed traffic goes to in hybrid mode. */
  cloudModel?: string;
};

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
      description: ADDON_DESCRIPTION,
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

const DEFAULT_MODE: HybridMode = "local";

hybridRoutingRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    mode: cfg.mode ?? DEFAULT_MODE,
    cloudModel: cfg.cloudModel ?? "",
  });
});

const configSchema = z.object({
  mode: z.enum(["local", "hybrid"]).optional(),
  cloudModel: z.string().max(300).optional(),
});

hybridRoutingRoute.patch(
  "/config",
  zValidator("json", configSchema),
  async (c) => {
    const userId = c.get("userId");
    const addon = await findOrInit(userId);
    const cfg = (addon.config ?? {}) as Config;
    const data = c.req.valid("json");
    if (data.mode !== undefined) cfg.mode = data.mode;
    if (data.cloudModel !== undefined) cfg.cloudModel = data.cloudModel;
    await db
      .update(addons)
      .set({ config: cfg, updatedAt: new Date() })
      .where(eq(addons.id, addon.id));
    return c.json({ ok: true });
  },
);

/**
 * Load the user's hybrid config in the form chat.ts needs it. Returns the
 * config ONLY when the add-on is enabled AND mode === "hybrid" AND a cloud
 * model is set; otherwise null (local path → existing Auto Router runs).
 * chat.ts calls this on every request with model="auto" — keep it fast.
 */
export async function loadHybridConfigForUser(
  userId: string,
): Promise<{ mode: "hybrid"; cloudModel: string } | null> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as Config;
  if (cfg.mode !== "hybrid" || !cfg.cloudModel) return null;
  return { mode: "hybrid", cloudModel: cfg.cloudModel };
}

export default hybridRoutingRoute;
