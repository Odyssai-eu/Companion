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

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const comfyuiRoute = new Hono<Env>();

const ADDON_NAME = "ComfyUI Imager";

export type ComfyuiAddonConfig = {
  bridgeUrl?: string;
  bridgeToken?: string;
};

export async function findOrInitComfyuiAddon(userId: string) {
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
        "Image generation via the OdyssAI-Imager bridge. Type /comfyui " +
        "<prompt> in chat or use the panel below to render with Flux.1 " +
        "(schnell or dev) on your local ComfyUI host. Requires the bridge " +
        "endpoint reachable from Companion.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

/** Loaded by chat-side code on `/comfyui` and by the tools dispatcher so the
 *  bridge URL + token are resolved per request, not at module import. */
export async function loadComfyuiConfigForUser(
  userId: string,
): Promise<(ComfyuiAddonConfig & { addonId: string }) | null> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as ComfyuiAddonConfig;
  if (!cfg.bridgeUrl) return null;
  return { ...cfg, addonId: row.id };
}

comfyuiRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitComfyuiAddon(userId);
  const cfg = (addon.config ?? {}) as ComfyuiAddonConfig;
  // Optional operator-wide default. Per-user bridgeUrl always wins.
  const bridgeUrl =
    cfg.bridgeUrl || process.env.IMAGER_BRIDGE_URL || "";
  return c.json({
    addonId: addon.id,
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
  const addon = await findOrInitComfyuiAddon(userId);
  const cfg = { ...((addon.config ?? {}) as ComfyuiAddonConfig) };
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
  const out = (updated.config ?? {}) as ComfyuiAddonConfig;
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
  const addon = await findOrInitComfyuiAddon(userId);
  const cfg = (addon.config ?? {}) as ComfyuiAddonConfig;
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
