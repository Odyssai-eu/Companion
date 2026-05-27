/**
 * Pi Agent add-on. Points Companion at the thecompai-pi-bridge running
 * alongside the `pi` CLI on a backend host (currently .50).
 *
 *   GET   /api/addons/pi/info        → status + config
 *   PUT   /api/addons/pi/config      → set bridgeUrl, bridgeToken, enabled
 *   POST  /api/addons/pi/probe       → curl the bridge /health, return result
 *
 * The actual agent invocation happens on the chat route at
 * /api/agents/pi/* — this add-on only stores connection details and
 * serves as the on/off switch (mirror of addon-hermes.ts).
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const piRoute = new Hono<Env>();

const ADDON_NAME = "Pi Agent";

export type PiAddonConfig = {
  bridgeUrl?: string;
  bridgeToken?: string;
  cwd?: string;
};

export async function findOrInitPiAddon(userId: string) {
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
        "Type /pi in chat to open a Pi coding-agent sub-thread. Pi can " +
        "read, write, edit files and run shell commands on its host " +
        "machine. Requires a thecompai-pi-bridge HTTP endpoint " +
        "reachable from Companion.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

/** Loaded by chat-side code on `/pi` to know where to send prompts. */
export async function loadPiConfigForUser(
  userId: string,
): Promise<(PiAddonConfig & { addonId: string }) | null> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as PiAddonConfig;
  if (!cfg.bridgeUrl) return null;
  return { ...cfg, addonId: row.id };
}

piRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitPiAddon(userId);
  const cfg = (addon.config ?? {}) as PiAddonConfig;
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    configured: Boolean(cfg.bridgeUrl),
    bridgeUrl: cfg.bridgeUrl ?? "",
    cwd: cfg.cwd ?? "",
    hasToken: Boolean(cfg.bridgeToken),
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  bridgeUrl: z.string().url().max(300).optional(),
  bridgeToken: z.string().max(500).nullish(),
  cwd: z.string().max(500).nullish(),
});

piRoute.put("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const addon = await findOrInitPiAddon(userId);
  const cfg = { ...((addon.config ?? {}) as PiAddonConfig) };
  if (data.bridgeUrl !== undefined) cfg.bridgeUrl = data.bridgeUrl;
  if (data.bridgeToken !== undefined) {
    cfg.bridgeToken = data.bridgeToken ?? undefined;
  }
  if (data.cwd !== undefined) {
    cfg.cwd = data.cwd ?? undefined;
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
  const out = (updated.config ?? {}) as PiAddonConfig;
  return c.json({
    ok: true,
    enabled: updated.enabled,
    configured: Boolean(out.bridgeUrl),
    bridgeUrl: out.bridgeUrl ?? "",
    cwd: out.cwd ?? "",
    hasToken: Boolean(out.bridgeToken),
  });
});

piRoute.post("/probe", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitPiAddon(userId);
  const cfg = (addon.config ?? {}) as PiAddonConfig;
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

export default piRoute;
