/**
 * Confidential Guard add-on. Classifies the user's outgoing message
 * against a PII/GDPR detection service (Guardian / GLiNER2 sidecar)
 * BEFORE it reaches the provider, warns the user, and can force the
 * turn onto the local engine instead of a cloud provider. The
 * classification hook runs server-side in the chat handler (see
 * ../lib/guard.ts) — this add-on only stores the connection details +
 * policy + on/off switch, same shape as addon-parser.ts.
 *
 *   GET   /api/addons/guard/info    → status + config
 *   PUT   /api/addons/guard/config  → set url / policy / enabled
 *   POST  /api/addons/guard/test    → forward a text sample to the guard
 *                                      service, return the verdict so the
 *                                      panel can verify connectivity.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";
import { classifyText } from "../lib/guard";
import {
  materializeUserAddon,
  pruneInheritedEchoes,
  readOwnAddonConfig,
  resolveKnownAddon,
} from "../lib/instance-rows";

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
   *  the paired engine (requires localModel + a resolved engineUrl). */
  action?: "warn" | "force-local";
  /** Model id served by the local engine that sensitive turns are
   *  re-routed to when action = force-local. */
  localModel?: string;
  /** GLiNER2 span threshold (0..1). */
  threshold?: number;
  /** Stage-2 contextual detection LLM endpoint (OpenAI-compatible), relayed to
   *  Guardian per request. Empty = stage 2 off. No hardcoded URL — this field
   *  is the single config surface for the guard's LLM dependency. */
  contextualLlmUrl?: string;
  /** Model id served at contextualLlmUrl (e.g. "tele-fast"). */
  contextualLlmModel?: string;
};

/** The add-on as this user sees it: their own row on top of the instance
 *  row, key by key. Resolution writes nothing (no findOrInit — the 0060
 *  rule); the user's row is created only when they actually save. */
async function loadGuardAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
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
      contextualLlmUrl: string;
      contextualLlmModel: string;
      addonId: string | null;
    }
  | null
> {
  const row = await loadGuardAddon(userId);
  if (!row.enabled) return null;
  const cfg = row.config as GuardAddonConfig;
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
    contextualLlmUrl: cfg.contextualLlmUrl ?? "",
    contextualLlmModel: cfg.contextualLlmModel || "tele-fast",
    addonId: row.id,
  };
}

guardRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await loadGuardAddon(userId);
  const cfg = addon.config as GuardAddonConfig;
  const url = cfg.url || DEFAULT_GUARD_URL;
  return c.json({
    addonId: addon.id,
    inherited: addon.inherited,
    inheritedConfigKeys: addon.inheritedConfigKeys,
    enabled: addon.enabled,
    url,
    action: cfg.action === "force-local" ? "force-local" : "warn",
    localModel: cfg.localModel ?? "",
    threshold:
      typeof cfg.threshold === "number" && cfg.threshold > 0 && cfg.threshold <= 1
        ? cfg.threshold
        : 0.5,
    contextualLlmUrl: cfg.contextualLlmUrl ?? "",
    contextualLlmModel: cfg.contextualLlmModel || "tele-fast",
    configured: Boolean(url),
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().url().max(500).or(z.literal("")).optional(),
  action: z.enum(["warn", "force-local"]).optional(),
  localModel: z.string().max(200).optional(),
  threshold: z.number().gt(0).max(1).optional(),
  contextualLlmUrl: z.string().url().max(500).or(z.literal("")).optional(),
  contextualLlmModel: z.string().max(200).optional(),
});

guardRoute.put("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  // Copy-on-write, then a DELTA write — the patch is layered on the
  // caller's OWN config, never on the resolved one, so an untouched key
  // stays absent and keeps inheriting (see addon-parser.ts for the full
  // argument). An empty string is a soft clear: mergeAddonConfig treats
  // it as unset, so the key falls back to the instance value.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as GuardAddonConfig;
  const before = { ...cfg } as Record<string, unknown>;
  if (data.url !== undefined) cfg.url = data.url;
  if (data.action !== undefined) cfg.action = data.action;
  if (data.localModel !== undefined) cfg.localModel = data.localModel;
  if (data.threshold !== undefined) cfg.threshold = data.threshold;
  if (data.contextualLlmUrl !== undefined) cfg.contextualLlmUrl = data.contextualLlmUrl;
  if (data.contextualLlmModel !== undefined) cfg.contextualLlmModel = data.contextualLlmModel;
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
  const updated = await loadGuardAddon(userId);
  const out = updated.config as GuardAddonConfig;
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
    contextualLlmUrl: out.contextualLlmUrl ?? "",
    contextualLlmModel: out.contextualLlmModel || "tele-fast",
    configured: Boolean(out.url || DEFAULT_GUARD_URL),
  });
});

/** Classify a text sample against the configured guard endpoint. Lets the
 *  settings panel verify connectivity end-to-end without going through
 *  the chat path. Reads the RESOLVED config so the test exercises exactly
 *  what the chat hook would use — inherited URL included. */
const testSchema = z.object({ text: z.string().min(1).max(8_000) });

guardRoute.post("/test", zValidator("json", testSchema), async (c) => {
  const userId = c.get("userId");
  const addon = await loadGuardAddon(userId);
  const cfg = addon.config as GuardAddonConfig;
  const url = cfg.url || DEFAULT_GUARD_URL;
  if (!url) return c.json({ ok: false, error: "no_url_configured" }, 400);

  const { text } = c.req.valid("json");
  const verdict = await classifyText(text, {
    url,
    threshold: cfg.threshold,
    contextualLlmUrl: cfg.contextualLlmUrl,
    contextualLlmModel: cfg.contextualLlmModel,
  });
  if (!verdict) {
    return c.json({ ok: false, error: "guard_service_unreachable" }, 502);
  }
  return c.json({ ok: true, ...verdict });
});

export default guardRoute;
