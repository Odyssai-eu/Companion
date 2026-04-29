/**
 * EXO Direct add-on — bypasses LiteLLM and talks straight to one or more
 * EXO instances for chat completions.
 *
 *   GET    /api/addons/exo/info       → { addonId, enabled, endpoints: [{ id, label, baseUrl, models[] }] }
 *   POST   /api/addons/exo/endpoints  → add an endpoint (body: { label, url })
 *   PATCH  /api/addons/exo/endpoints/:id → update label/url (body: { label?, url? })
 *   DELETE /api/addons/exo/endpoints/:id → remove
 *   POST   /api/addons/exo/endpoints/:id/refresh → re-fetch loaded models
 *
 * Models exposed by enabled endpoints surface in the chat picker with the id
 * `exo-direct/<endpointId>/<modelId>`. The chat & prewarm routes recognise
 * that prefix, look up the endpoint by id, and route directly to its base
 * URL — bypassing LiteLLM entirely. Letting a user point at multiple EXO
 * instances at once means a model loaded on cluster A and a model loaded on
 * cluster B both appear in the same picker, each tagged with their cluster
 * label.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const exoRoute = new Hono<Env>();

const ADDON_NAME = "EXO Direct";

export type ExoEndpoint = {
  id: string;
  label: string;
  baseUrl: string;
};

type Config = {
  endpoints?: ExoEndpoint[];
  /** Legacy single-URL field — migrated to `endpoints` on first read. */
  baseUrl?: string;
};

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

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
        "Talk straight to one or more EXO instances, bypassing LiteLLM. " +
        "Add an endpoint per cluster — models loaded on each show up in the " +
        "chat picker tagged by cluster.",
      version: "0.2.0",
      enabled: false,
    })
    .returning();
  return created;
}

/** Read endpoints from the addon config, migrating from the legacy single-URL
 *  shape if needed. The migration writes back so subsequent reads are clean. */
async function readEndpoints(addonId: string, cfg: Config): Promise<ExoEndpoint[]> {
  if (cfg.endpoints && Array.isArray(cfg.endpoints)) return cfg.endpoints;
  // Legacy: single baseUrl field. Promote it to an endpoint and persist.
  if (cfg.baseUrl) {
    const migrated: ExoEndpoint[] = [
      {
        id: randomUUID().slice(0, 8),
        label: "default",
        baseUrl: normalizeUrl(cfg.baseUrl),
      },
    ];
    const newCfg: Config = { endpoints: migrated };
    await db
      .update(addons)
      .set({ config: newCfg, updatedAt: new Date() })
      .where(eq(addons.id, addonId));
    return migrated;
  }
  return [];
}

/** Resolve an EXO endpoint by id for routing. Returns null when the add-on
 *  is disabled, the endpoint isn't known, or the id is malformed. Used by
 *  chat.ts and the prewarm endpoint to pick the right base URL for a model
 *  carrying the `exo-direct/<endpointId>/<modelId>` prefix. */
export async function resolveExoEndpoint(
  userId: string,
  endpointId: string,
): Promise<ExoEndpoint | null> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return null;
  const cfg = (row.config ?? {}) as Config;
  const endpoints = await readEndpoints(row.id, cfg);
  return endpoints.find((e) => e.id === endpointId) ?? null;
}

/** All enabled endpoints for a user. Used by /api/models to surface every
 *  cluster's loaded models in the picker. */
export async function listExoEndpoints(
  userId: string,
): Promise<ExoEndpoint[]> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (!row || !row.enabled) return [];
  const cfg = (row.config ?? {}) as Config;
  return readEndpoints(row.id, cfg);
}

/** List the loaded models on a given EXO base URL (one model id per
 *  loaded instance, dedup'd). */
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

async function writeEndpoints(addonId: string, list: ExoEndpoint[]) {
  await db
    .update(addons)
    .set({ config: { endpoints: list } satisfies Config, updatedAt: new Date() })
    .where(eq(addons.id, addonId));
}

exoRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const endpoints = await readEndpoints(addon.id, cfg);
  // Resolve loaded models for each endpoint in parallel.
  const enriched = await Promise.all(
    endpoints.map(async (ep) => ({
      ...ep,
      models: addon.enabled ? await listLoadedExoModels(ep.baseUrl) : [],
    })),
  );
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    endpoints: enriched,
  });
});

const addEndpointSchema = z.object({
  label: z.string().min(1).max(60),
  url: z.string().url(),
});

exoRoute.post(
  "/endpoints",
  zValidator("json", addEndpointSchema),
  async (c) => {
    const userId = c.get("userId");
    const addon = await findOrInit(userId);
    const cfg = (addon.config ?? {}) as Config;
    const endpoints = await readEndpoints(addon.id, cfg);
    const data = c.req.valid("json");
    const baseUrl = normalizeUrl(data.url);
    if (endpoints.some((e) => e.baseUrl === baseUrl)) {
      return c.json({ error: "duplicate_url" }, 409);
    }
    const newEp: ExoEndpoint = {
      id: randomUUID().slice(0, 8),
      label: data.label.trim(),
      baseUrl,
    };
    await writeEndpoints(addon.id, [...endpoints, newEp]);
    return c.json({ endpoint: newEp });
  },
);

const patchEndpointSchema = z.object({
  label: z.string().min(1).max(60).optional(),
  url: z.string().url().optional(),
});

exoRoute.patch(
  "/endpoints/:id",
  zValidator("json", patchEndpointSchema),
  async (c) => {
    const userId = c.get("userId");
    const addon = await findOrInit(userId);
    const cfg = (addon.config ?? {}) as Config;
    const endpoints = await readEndpoints(addon.id, cfg);
    const id = c.req.param("id");
    const idx = endpoints.findIndex((e) => e.id === id);
    if (idx === -1) return c.json({ error: "not_found" }, 404);
    const data = c.req.valid("json");
    const updated: ExoEndpoint = {
      ...endpoints[idx],
      ...(data.label ? { label: data.label.trim() } : {}),
      ...(data.url ? { baseUrl: normalizeUrl(data.url) } : {}),
    };
    const next = [...endpoints];
    next[idx] = updated;
    await writeEndpoints(addon.id, next);
    return c.json({ endpoint: updated });
  },
);

exoRoute.delete("/endpoints/:id", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const endpoints = await readEndpoints(addon.id, cfg);
  const id = c.req.param("id");
  const next = endpoints.filter((e) => e.id !== id);
  if (next.length === endpoints.length) {
    return c.json({ error: "not_found" }, 404);
  }
  await writeEndpoints(addon.id, next);
  return c.body(null, 204);
});

exoRoute.post("/endpoints/:id/refresh", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const endpoints = await readEndpoints(addon.id, cfg);
  const ep = endpoints.find((e) => e.id === c.req.param("id"));
  if (!ep) return c.json({ error: "not_found" }, 404);
  const models = await listLoadedExoModels(ep.baseUrl);
  return c.json({ endpoint: { ...ep, models } });
});

export default exoRoute;
