/**
 * Web Search (Tavily) add-on settings.
 *
 *   GET  /api/addons/tavily/info   → { addonId, enabled, hasKey }
 *   POST /api/addons/tavily/key    → set the API key (body: { key })
 *   DELETE /api/addons/tavily/key  → clear the key
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";
import {
  materializeUserAddon,
  readOwnAddonConfig,
  resolveKnownAddon,
} from "../lib/instance-rows";

type Env = { Variables: { userId: string } };
const tavilyRoute = new Hono<Env>();

const ADDON_NAME = "Web Search";

type Config = { apiKey?: string };

/** Own row over instance row, key by key. Replaces findOrInit(): resolution
 *  never writes.
 *
 *  The Tavily key was deliberately NOT lifted onto the instance row by
 *  0060 — it bills a metered third-party account, which is a different
 *  decision from sharing a token for a service the deployment owns. It
 *  will inherit if an operator puts one there on purpose from
 *  Admin → Instance add-ons. */
async function loadTavilyAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
}

tavilyRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await loadTavilyAddon(userId);
  const cfg = addon.config as Config;
  return c.json({
    addonId: addon.id,
    inherited: addon.inherited,
    inheritedConfigKeys: addon.inheritedConfigKeys,
    enabled: addon.enabled,
    hasKey: Boolean(cfg.apiKey),
  });
});

const setKeySchema = z.object({
  key: z.string().min(8).max(200),
});

tavilyRoute.post("/key", zValidator("json", setKeySchema), async (c) => {
  const userId = c.get("userId");
  // Copy-on-write + delta write — see the note in addon-parser.ts.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as Config;
  cfg.apiKey = c.req.valid("json").key.trim();
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, ownId));
  return c.json({ ok: true });
});

tavilyRoute.delete("/key", async (c) => {
  const userId = c.get("userId");
  // Clears the caller's OWN key. If the instance publishes one they fall
  // back onto it, which is the same semantics as clearing any other
  // inherited field.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as Config;
  cfg.apiKey = undefined;
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, ownId));
  return c.body(null, 204);
});

export default tavilyRoute;
