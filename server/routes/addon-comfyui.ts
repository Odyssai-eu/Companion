/**
 * ComfyUI Imager add-on. Points Companion at the OdyssAI-Imager FastAPI
 * bridge running on .141:8008. The bridge talks to ComfyUI on a compute
 * host (.42 sandbox / .33 prod) and returns images.
 *
 *   GET   /api/addons/comfyui/info        → status + config
 *   PUT   /api/addons/comfyui/config      → set bridgeUrl, bridgeToken, enabled
 *   POST  /api/addons/comfyui/probe       → curl the bridge /health, return result
 *
 * The actual generation call happens at /api/agents/comfyui/generate
 * (see ./agent-comfyui.ts). This add-on only stores connection details
 * and serves as the on/off switch — same shape as addon-hermes.ts.
 *
 * No shared-secret default: the bridge lives on the LAN and is
 * opt-in per user. Set IMAGER_BRIDGE_URL on the Companion server to
 * expose a sensible default for the operator's own deployment.
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
const comfyuiRoute = new Hono<Env>();

const ADDON_NAME = "ComfyUI Imager";

export type ComfyuiAddonConfig = {
  bridgeUrl?: string;
  bridgeToken?: string;
};

/** The add-on as this user sees it — own row over instance row, key by
 *  key. Replaces findOrInitComfyuiAddon(): resolution never writes.
 *
 *  `bridgeToken` is inherited only while `bridgeUrl` is (see
 *  PAIRED_CONFIG_KEYS in server/lib/instance-rows.ts) — a user who points
 *  the bridge at their own host must not have the deployment's token sent
 *  there. Same rule as engineToken/ownEngine in 0059. */
async function loadComfyuiAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
}

/** Loaded by chat-side code on `/comfyui` and by the tools dispatcher so the
 *  bridge URL + token are resolved per request, not at module import. */
export async function loadComfyuiConfigForUser(
  userId: string,
): Promise<(ComfyuiAddonConfig & { addonId: string | null }) | null> {
  const row = await loadComfyuiAddon(userId);
  if (!row.enabled) return null;
  const cfg = row.config as ComfyuiAddonConfig;
  if (!cfg.bridgeUrl) return null;
  return { ...cfg, addonId: row.id };
}

comfyuiRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await loadComfyuiAddon(userId);
  const cfg = addon.config as ComfyuiAddonConfig;
  // Optional operator-wide default, now the LAST link: the user's own
  // bridgeUrl wins, then the instance row's, then the env var. Same
  // ordering as LITELLM_URL in global-settings.ts — a value an admin can
  // see and edit beats a container env nobody remembers setting.
  const bridgeUrl =
    cfg.bridgeUrl || process.env.IMAGER_BRIDGE_URL || "";
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

comfyuiRoute.put("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  // Copy-on-write + delta write — see the note in addon-parser.ts.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as ComfyuiAddonConfig;
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
  const updated = await loadComfyuiAddon(userId);
  const out = updated.config as ComfyuiAddonConfig;
  return c.json({
    ok: true,
    enabled: updated.enabled,
    configured: Boolean(out.bridgeUrl),
    bridgeUrl: out.bridgeUrl ?? "",
    hasToken: Boolean(out.bridgeToken),
  });
});

comfyuiRoute.post("/probe", async (c) => {
  const userId = c.get("userId");
  const addon = await loadComfyuiAddon(userId);
  const cfg = addon.config as ComfyuiAddonConfig;
  const fallback = process.env.IMAGER_BRIDGE_URL || "";
  const bridgeUrl = cfg.bridgeUrl || fallback;
  if (!bridgeUrl) {
    return c.json({ error: "not_configured" }, 400);
  }
  const url = bridgeUrl.replace(/\/+$/, "") + "/health";
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

export default comfyuiRoute;
