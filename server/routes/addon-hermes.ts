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
const hermesRoute = new Hono<Env>();

const ADDON_NAME = "Hermes Agent";

export type HermesAddonConfig = {
  bridgeUrl?: string;
  bridgeToken?: string;
};

/** The add-on as this user sees it — own row over instance row, key by
 *  key. Replaces findOrInitHermesAddon(): resolution never writes.
 *
 *  `bridgeToken` is inherited only while `bridgeUrl` is (PAIRED_CONFIG_KEYS
 *  in server/lib/instance-rows.ts): the token authenticates against one
 *  host, so a user who repoints the bridge gets no shared credential. */
async function loadHermesAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
}

/** Loaded by chat-side code on `/hermes` to know where to send prompts. */
export async function loadHermesConfigForUser(
  userId: string,
): Promise<(HermesAddonConfig & { addonId: string | null }) | null> {
  const row = await loadHermesAddon(userId);
  if (!row.enabled) return null;
  const cfg = row.config as HermesAddonConfig;
  if (!cfg.bridgeUrl) return null;
  return { ...cfg, addonId: row.id };
}

hermesRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await loadHermesAddon(userId);
  const cfg = addon.config as HermesAddonConfig;
  // #25 — enterprise default: when the operator sets HERMES_DASHBOARD_URL the
  // shared Hermes dashboard is used out of the box, so a user only needs to
  // flip the add-on on. Since 0060 that env var is the LAST link, behind the
  // instance row an admin can actually see and edit (same ordering as
  // LITELLM_URL in global-settings.ts): own bridgeUrl, then instance, then
  // env.
  const bridgeUrl = cfg.bridgeUrl || process.env.HERMES_DASHBOARD_URL || "";
  return c.json({
    addonId: addon.id,
    inherited: addon.inherited,
    inheritedConfigKeys: addon.inheritedConfigKeys,
    enabled: addon.enabled,
    configured: Boolean(bridgeUrl),
    bridgeUrl,
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
  // Copy-on-write + delta write — see the note in addon-parser.ts.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as HermesAddonConfig;
  // Which keys were ALREADY the user's own, before this request touched
  // anything. pruneInheritedEchoes needs it to tell a real override from the
  // form echoing back a value it only displayed because it was inherited.
  const before = { ...cfg } as Record<string, unknown>;
  if (data.bridgeUrl !== undefined) cfg.bridgeUrl = data.bridgeUrl;
  if (data.bridgeToken !== undefined) {
    cfg.bridgeToken = data.bridgeToken ?? undefined;
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
  const updated = await loadHermesAddon(userId);
  const out = updated.config as HermesAddonConfig;
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
  const addon = await loadHermesAddon(userId);
  const cfg = addon.config as HermesAddonConfig;
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
