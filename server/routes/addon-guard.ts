/**
 * Confidential Guard add-on. Classifies the user's outgoing message
 * against a PII/GDPR detection service (GLiNER2 sidecar) BEFORE it
 * reaches the provider, warns the user, and can force the turn onto
 * the local engine instead of a cloud provider. The classification
 * hook runs server-side in the chat handler (see ../lib/guard.ts) —
 * this add-on only stores the connection details + policy + on/off
 * switch, same shape as addon-parser.ts.
 *
 *   GET   /api/addons/guard/info    → status + config
 *   PUT   /api/addons/guard/config  → set url / policy / enabled
 *   POST  /api/addons/guard/test    → forward a text sample to the guard
 *                                      service, return the verdict so the
 *                                      panel can verify connectivity.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";
import { classifyText } from "../lib/guard";

type Env = { Variables: { userId: string } };
const guardRoute = new Hono<Env>();

const ADDON_NAME = "Confidential Guard";

// No hardcoded infra URL. The guard endpoint is config-driven — the user
// sets it in the add-on panel (empty until configured). See memory
// no-hardcoded-urls: a baked LAN IP breaks portability / client install.
export const DEFAULT_GUARD_URL = "";

export type GuardAddonConfig = {
  url?: string;
  /** warn = SSE banner only; force-local = banner + re-route the turn to
   *  the paired engine (requires localModel + engineUrl). */
  action?: "warn" | "force-local";
  /** Model id served by the local engine that sensitive turns are
   *  re-routed to when action = force-local. */
  localModel?: string;
  /** GLiNER2 span threshold (0..1). */
  threshold?: number;
};

export async function findOrInitGuardAddon(userId: string) {
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
        "Detect confidential content (GDPR identifiers, health data, " +
        "financials, credentials) in your message before it is sent, warn " +
        "you, and optionally keep the turn on your local engine instead of " +
        "a cloud provider.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

/** Loaded by the chat send path so the guard URL + policy are resolved
 *  per request, not at module import. Returns null when the add-on is
 *  disabled or not configured — mirrors loadParserConfigForUser. */
export async function loadGuardConfigForUser(
  userId: string,
): Promise<
  | {
      url: string;
      action: "warn" | "force-local";
      localModel: string;
      threshold: number;
      addonId: string;
    }
  | null
> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as GuardAddonConfig;
  // Enabled but no guard URL configured → treat as not configured so the
  // send-path skips classification (no hardcoded fallback).
  if (!cfg.url) return null;
  return {
    url: cfg.url,
    action: cfg.action === "force-local" ? "force-local" : "warn",
    localModel: cfg.localModel ?? "",
    threshold:
      typeof cfg.threshold === "number" && cfg.threshold > 0 && cfg.threshold <= 1
        ? cfg.threshold
        : 0.5,
    addonId: row.id,
  };
}

guardRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitGuardAddon(userId);
  const cfg = (addon.config ?? {}) as GuardAddonConfig;
  const url = cfg.url || DEFAULT_GUARD_URL;
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    url,
    action: cfg.action === "force-local" ? "force-local" : "warn",
    localModel: cfg.localModel ?? "",
    threshold:
      typeof cfg.threshold === "number" && cfg.threshold > 0 && cfg.threshold <= 1
        ? cfg.threshold
        : 0.5,
    configured: Boolean(url),
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().url().max(500).or(z.literal("")).optional(),
  action: z.enum(["warn", "force-local"]).optional(),
  localModel: z.string().max(200).optional(),
  threshold: z.number().gt(0).max(1).optional(),
});

guardRoute.put("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const addon = await findOrInitGuardAddon(userId);
  const cfg = { ...((addon.config ?? {}) as GuardAddonConfig) };
  if (data.url !== undefined) cfg.url = data.url;
  if (data.action !== undefined) cfg.action = data.action;
  if (data.localModel !== undefined) cfg.localModel = data.localModel;
  if (data.threshold !== undefined) cfg.threshold = data.threshold;
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
  const out = (updated.config ?? {}) as GuardAddonConfig;
  return c.json({
    ok: true,
    enabled: updated.enabled,
    url: out.url || DEFAULT_GUARD_URL,
    action: out.action === "force-local" ? "force-local" : "warn",
    localModel: out.localModel ?? "",
    threshold:
      typeof out.threshold === "number" && out.threshold > 0 && out.threshold <= 1
        ? out.threshold
        : 0.5,
    configured: Boolean(out.url || DEFAULT_GUARD_URL),
  });
});

/** Classify a text sample against the configured guard endpoint. Lets the
 *  settings panel verify connectivity end-to-end without going through
 *  the chat path. */
const testSchema = z.object({ text: z.string().min(1).max(8_000) });

guardRoute.post("/test", zValidator("json", testSchema), async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitGuardAddon(userId);
  const cfg = (addon.config ?? {}) as GuardAddonConfig;
  const url = cfg.url || DEFAULT_GUARD_URL;
  if (!url) return c.json({ ok: false, error: "no_url_configured" }, 400);

  const { text } = c.req.valid("json");
  const verdict = await classifyText(text, {
    url,
    threshold: cfg.threshold,
  });
  if (!verdict) {
    return c.json({ ok: false, error: "guard_service_unreachable" }, 502);
  }
  return c.json({ ok: true, ...verdict });
});

export default guardRoute;
