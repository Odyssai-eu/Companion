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

type Env = { Variables: { userId: string } };
const piRoute = new Hono<Env>();

const ADDON_NAME = "Pi Agent";

export type PiAddonConfig = {
  bridgeUrl?: string;
  bridgeToken?: string;
  cwd?: string;
};

/** The add-on as this user sees it — own row over instance row, key by
 *  key. Replaces findOrInitPiAddon(): resolution never writes.
 *
 *  `bridgeToken` is inherited only while `bridgeUrl` is
 *  (PAIRED_CONFIG_KEYS in server/lib/instance-rows.ts). `cwd` is NOT
 *  paired: it is a plain preference, and inheriting the operator's working
 *  directory is a sensible starting point a user can override. */
async function loadPiAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
}

/** Loaded by chat-side code on `/pi` to know where to send prompts. */
export async function loadPiConfigForUser(
  userId: string,
): Promise<(PiAddonConfig & { addonId: string | null }) | null> {
  const row = await loadPiAddon(userId);
  if (!row.enabled) return null;
  const cfg = row.config as PiAddonConfig;
  if (!cfg.bridgeUrl) return null;
  return { ...cfg, addonId: row.id };
}

piRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await loadPiAddon(userId);
  const cfg = addon.config as PiAddonConfig;
  return c.json({
    addonId: addon.id,
    inherited: addon.inherited,
    inheritedConfigKeys: addon.inheritedConfigKeys,
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
  // Copy-on-write + delta write — see the note in addon-parser.ts.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as PiAddonConfig;
  // Which keys were ALREADY the user's own, before this request touched
  // anything. pruneInheritedEchoes needs it to tell a real override from the
  // form echoing back a value it only displayed because it was inherited.
  const before = { ...cfg } as Record<string, unknown>;
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
    config: await pruneInheritedEchoes(
      ADDON_NAME,
      before,
      cfg as unknown as Record<string, unknown>,
    ),
    updatedAt: new Date(),
  };
  if (typeof data.enabled === "boolean") patch.enabled = data.enabled;

  await db.update(addons).set(patch).where(eq(addons.id, ownId));
  const updated = await loadPiAddon(userId);
  const out = updated.config as PiAddonConfig;
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
  const addon = await loadPiAddon(userId);
  const cfg = addon.config as PiAddonConfig;
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
