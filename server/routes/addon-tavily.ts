/**
 * Web Search (Tavily) add-on settings.
 *
 *   GET  /api/addons/tavily/info   → { addonId, enabled, hasKey }
 *   POST /api/addons/tavily/key    → set the API key (body: { key })
 *   DELETE /api/addons/tavily/key  → clear the key
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const tavilyRoute = new Hono<Env>();

const ADDON_NAME = "Web Search";

type Config = { apiKey?: string };

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
        "Give the assistant web access via Tavily — search and fetch URLs " +
        "as tool calls. Paste your Tavily API key to enable.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

tavilyRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    hasKey: Boolean(cfg.apiKey),
  });
});

const setKeySchema = z.object({
  key: z.string().min(8).max(200),
});

tavilyRoute.post("/key", zValidator("json", setKeySchema), async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = ((addon.config ?? {}) as Config);
  cfg.apiKey = c.req.valid("json").key.trim();
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, addon.id));
  return c.json({ ok: true });
});

tavilyRoute.delete("/key", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = ((addon.config ?? {}) as Config);
  cfg.apiKey = undefined;
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, addon.id));
  return c.body(null, 204);
});

export default tavilyRoute;
