/**
 * Hermes Agent add-on. Points Companion at a Hermes ACP bridge running
 * on the user's machine (niveau-1) or, later, at a daemon connecting out
 * from the user's machine (niveau-2). The bridge translates Companion
 * HTTP+SSE ↔ Hermes ACP JSON-RPC.
 *
 *   GET   /api/addons/hermes/info        → status + config
 *   PUT   /api/addons/hermes/config      → set bridgeUrl, bridgeToken, enabled
 *   POST  /api/addons/hermes/probe       → curl the bridge /health, return result
 *
 * The actual agent invocation happens on the chat route at
 * /api/agents/hermes/* — this add-on only stores connection details
 * and serves as the on/off switch.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const hermesRoute = new Hono<Env>();

const ADDON_NAME = "Hermes Agent";

export type HermesAddonConfig = {
  bridgeUrl?: string;
  bridgeToken?: string;
};

export async function findOrInitHermesAddon(userId: string) {
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
        "Type /hermes in chat to open an agent sub-thread that can read " +
        "files, write files, and run shell commands on your machine. " +
        "Requires a Hermes ACP bridge endpoint reachable from Companion.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

/** Loaded by chat-side code on `/hermes` to know where to send prompts. */
export async function loadHermesConfigForUser(
  userId: string,
): Promise<(HermesAddonConfig & { addonId: string }) | null> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as HermesAddonConfig;
  if (!cfg.bridgeUrl) return null;
  return { ...cfg, addonId: row.id };
}

hermesRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitHermesAddon(userId);
  const cfg = (addon.config ?? {}) as HermesAddonConfig;
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    configured: Boolean(cfg.bridgeUrl),
    bridgeUrl: cfg.bridgeUrl ?? "",
    hasToken: Boolean(cfg.bridgeToken),
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  bridgeUrl: z.string().url().max(300).optional(),
  bridgeToken: z.string().max(500).nullish(),
});

hermesRoute.put("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const addon = await findOrInitHermesAddon(userId);
  const cfg = { ...((addon.config ?? {}) as HermesAddonConfig) };
  if (data.bridgeUrl !== undefined) cfg.bridgeUrl = data.bridgeUrl;
  if (data.bridgeToken !== undefined) {
    cfg.bridgeToken = data.bridgeToken ?? undefined;
  }
  const patch: {
    config: Record<string, unknown>;
    updatedAt: Date;
    enabled?: boolean;
  } = {
    config: cfg as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };
  if (typeof data.enabled === "boolean") patch.enabled = data.enabled;

  const [updated] = await db
    .update(addons)
    .set(patch)
    .where(eq(addons.id, addon.id))
    .returning();
  const out = (updated.config ?? {}) as HermesAddonConfig;
  return c.json({
    ok: true,
    enabled: updated.enabled,
    configured: Boolean(out.bridgeUrl),
    bridgeUrl: out.bridgeUrl ?? "",
    hasToken: Boolean(out.bridgeToken),
  });
});

hermesRoute.post("/probe", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitHermesAddon(userId);
  const cfg = (addon.config ?? {}) as HermesAddonConfig;
  if (!cfg.bridgeUrl) {
    return c.json({ error: "not_configured" }, 400);
  }
  const url = cfg.bridgeUrl.replace(/\/+$/, "") + "/health";
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: cfg.bridgeToken
        ? { Authorization: `Bearer ${cfg.bridgeToken}` }
        : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return c.json({ ok: false, status: res.status }, 502);
    }
    const body = await res.json();
    return c.json({ ok: true, health: body });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 502);
  }
});

export default hermesRoute;
