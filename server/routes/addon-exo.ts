/**
 * EXO Direct add-on — bypasses LiteLLM and talks straight to an EXO
 * instance for chat completions.
 *
 *   GET    /api/addons/exo/info    → { addonId, enabled, baseUrl, modelCount }
 *   POST   /api/addons/exo/url     → set the EXO base URL
 *   DELETE /api/addons/exo/url     → clear the URL
 *   GET    /api/addons/exo/models  → list of CURRENTLY-LOADED model ids on EXO
 *
 * Models exposed via this add-on are surfaced in the chat model picker with
 * the prefix `exo-direct/`. When the chat route sees that prefix, it strips
 * it and routes directly to EXO's /v1/chat/completions on baseUrl, skipping
 * LiteLLM entirely. Useful to A/B whether LiteLLM proxying is responsible
 * for any latency / cache misses observed in the LiteLLM-routed path.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const exoRoute = new Hono<Env>();

const ADDON_NAME = "EXO Direct";

type Config = { baseUrl?: string };

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
        "Talk straight to an EXO instance, bypassing LiteLLM. Lets you compare " +
        "direct-to-engine latency against the proxied path. Set one base URL.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

/** Resolve the configured EXO base URL for this user, normalised
 *  (no trailing slash, no /v1 suffix). Returns null when the add-on is
 *  disabled or unconfigured. Exported so chat.ts can use it for direct
 *  routing without re-implementing the lookup. */
export async function resolveExoBaseUrl(
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as Config;
  if (!cfg.baseUrl) return null;
  return cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** List the EXO instances currently loaded (one model id per entry, dedup'd).
 *  Used both by GET /models and by the public model list when the add-on is on. */
export async function listLoadedExoModels(
  baseUrl: string,
): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${baseUrl}/state`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const d = (await r.json().catch(() => null)) as
      | { instances?: Record<string, unknown> }
      | null;
    if (!d?.instances) return [];
    const ids = new Set<string>();
    for (const inst of Object.values(d.instances)) {
      // EXO returns instances keyed by id, each with one of several
      // backend-specific shapes (MlxJacclInstance, MlxRingInstance, ...).
      // The shardAssignments.modelId is consistent across all of them.
      const wrapper = inst as Record<string, unknown>;
      for (const v of Object.values(wrapper)) {
        const sa = (v as { shardAssignments?: { modelId?: string } } | null)
          ?.shardAssignments;
        if (sa?.modelId) ids.add(sa.modelId);
      }
    }
    return [...ids];
  } catch {
    return [];
  }
}

exoRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const baseUrl = cfg.baseUrl ?? "";
  let models: string[] = [];
  if (addon.enabled && baseUrl) {
    models = await listLoadedExoModels(baseUrl.replace(/\/+$/, ""));
  }
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    baseUrl,
    models,
  });
});

const setUrlSchema = z.object({
  url: z.string().url(),
});

exoRoute.post("/url", zValidator("json", setUrlSchema), async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  cfg.baseUrl = c.req
    .valid("json")
    .url.trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, addon.id));
  return c.json({ ok: true, baseUrl: cfg.baseUrl });
});

exoRoute.delete("/url", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  cfg.baseUrl = undefined;
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, addon.id));
  return c.body(null, 204);
});

exoRoute.get("/models", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  if (!addon.enabled) return c.json({ models: [], reason: "disabled" });
  if (!cfg.baseUrl) return c.json({ models: [], reason: "no_url" });
  const models = await listLoadedExoModels(
    cfg.baseUrl.replace(/\/+$/, ""),
  );
  return c.json({ models });
});

export default exoRoute;
