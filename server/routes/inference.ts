/**
 * Inference settings + last-interaction read.
 *
 * GET  /api/inference/settings  → litellmUrl, defaultModel, timezone, hasKey
 * PATCH /api/inference/settings → update any subset
 * GET  /api/inference/status     → last_interaction_at + server time
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { users } from "../db/schema";
import { invalidateEngineCache } from "../lib/odyssai-capabilities";
import { probeEngine } from "../lib/odyssai-probe";

type Env = { Variables: { userId: string } };
const inferenceRoute = new Hono<Env>();

inferenceRoute.get("/settings", async (c) => {
  const userId = c.get("userId");
  const [u] = await db
    .select({
      defaultModel: users.defaultModel,
      litellmUrl: users.litellmUrl,
      hasApiKey: users.litellmApiKey,
      timezone: users.timezone,
      inferenceMode: users.inferenceMode,
      easyModel: users.easyModel,
      namedModels: users.namedModels,
      engineUrl: users.engineUrl,
      engineToken: users.engineToken,
      engineMeta: users.engineMeta,
      engineMode: users.engineMode,
      litellmDisabled: users.litellmDisabled,
      showMetrics: users.showMetrics,
      debugVerbose: users.debugVerbose,
      hiddenModels: users.hiddenModels,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return c.json({ error: "user_not_found" }, 404);
  return c.json({
    defaultModel: u.defaultModel,
    litellmUrl: u.litellmUrl,
    timezone: u.timezone,
    hasApiKey: Boolean(u.hasApiKey),
    envDefaultUrl: process.env.LITELLM_URL ?? "",
    inferenceMode: u.inferenceMode as "easy" | "advanced" | "expert",
    easyModel: u.easyModel,
    namedModels: u.namedModels ?? {},
    engineUrl: u.engineUrl,
    hasEngineToken: Boolean(u.engineToken),
    engineMeta: u.engineMeta,
    engineMode: u.engineMode as "gateway" | "hybrid" | "legacy",
    litellmDisabled: u.litellmDisabled,
    showMetrics: u.showMetrics,
    debugVerbose: u.debugVerbose,
    hiddenModels: u.hiddenModels ?? [],
  });
});

const namedModelsSchema = z
  .object({
    conversation: z.string().max(200).optional(),
    analyse: z.string().max(200).optional(),
    engineer: z.string().max(200).optional(),
    expert: z.string().max(200).optional(),
  })
  // .nullish() accepts both `undefined` (field omitted) and `null` (field
  // set to null) — the React client sends a full PATCH body where unset
  // fields come over as null, so .optional() rejected toggles like
  // "Show metrics" with 400 'namedModels: Expected object, received null'.
  // The handler at line ~102 already coerces `null` to a SQL NULL.
  .nullish();

const patchSchema = z.object({
  defaultModel: z.string().max(200).nullish(),
  litellmUrl: z.string().url().max(400).nullish(),
  litellmApiKey: z.string().max(400).nullish(),
  timezone: z.string().min(1).max(80).optional(),
  inferenceMode: z.enum(["easy", "advanced", "expert"]).optional(),
  easyModel: z.string().max(200).nullish(),
  namedModels: namedModelsSchema,
  engineUrl: z.string().url().max(400).nullish(),
  engineToken: z.string().max(400).nullish(),
  engineMode: z.enum(["gateway", "hybrid", "legacy"]).optional(),
  litellmDisabled: z.boolean().optional(),
  showMetrics: z.boolean().optional(),
  debugVerbose: z.boolean().optional(),
  // Picker hide list — full replacement on PATCH. Null clears it.
  hiddenModels: z.array(z.string().max(200)).max(200).nullish(),
});

inferenceRoute.patch("/settings", zValidator("json", patchSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const patch: Record<string, unknown> = {};
  if (data.defaultModel !== undefined) patch.defaultModel = data.defaultModel ?? null;
  if (data.litellmUrl !== undefined) patch.litellmUrl = data.litellmUrl ?? null;
  if (data.litellmApiKey !== undefined) patch.litellmApiKey = data.litellmApiKey ?? null;
  if (data.timezone !== undefined) patch.timezone = data.timezone;
  if (data.inferenceMode !== undefined) patch.inferenceMode = data.inferenceMode;
  if (data.easyModel !== undefined) patch.easyModel = data.easyModel ?? null;
  if (data.namedModels !== undefined) patch.namedModels = data.namedModels ?? null;
  if (data.engineUrl !== undefined) {
    patch.engineUrl = data.engineUrl ?? null;
    // Drop the cache when the URL changes so the next /api/models reads
    // fresh caps from the new target instead of the stale one.
    invalidateEngineCache();
  }
  if (data.engineToken !== undefined) {
    patch.engineToken = data.engineToken ?? null;
  }
  if (data.engineMode !== undefined) {
    patch.engineMode = data.engineMode;
  }
  if (data.litellmDisabled !== undefined) {
    patch.litellmDisabled = data.litellmDisabled;
  }
  if (data.showMetrics !== undefined) {
    patch.showMetrics = data.showMetrics;
  }
  if (data.debugVerbose !== undefined) {
    patch.debugVerbose = data.debugVerbose;
  }
  if (data.hiddenModels !== undefined) {
    // null / empty array both mean "no hide list" — store as null so the
    // default "show everything" reads naturally.
    const list = data.hiddenModels;
    patch.hiddenModels = list && list.length > 0 ? list : null;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no_fields_to_update" }, 400);
  }
  await db.update(users).set(patch).where(eq(users.id, userId));
  return c.json({ ok: true });
});

/**
 * Probe an engine URL on demand. Drives the "Test" button in Settings →
 * Inference. Body is { url, token? } — we don't read the user's saved
 * fields because the user is editing them in the form and may not have
 * saved yet.
 *
 * On a successful probe of an Odyssai engine, the engine_meta column is
 * cached so the UI can render version / features without re-probing.
 */
const probeSchema = z.object({
  url: z.string().url().max(400),
  token: z.string().max(400).optional(),
});

inferenceRoute.post(
  "/engine/probe",
  zValidator("json", probeSchema),
  async (c) => {
    const userId = c.get("userId");
    const { url, token } = c.req.valid("json");
    const result = await probeEngine(url, token);
    // Persist the meta snapshot only when it's an Odyssai engine (no
    // value in caching a 404 / generic OpenAI response). Async, no
    // await — the response is the source of truth for the UI.
    if (result.isOdyssai && result.meta) {
      void db
        .update(users)
        .set({
          engineMeta: result.meta as unknown as Record<string, unknown>,
        })
        .where(eq(users.id, userId))
        .catch(() => undefined);
    }
    // Caps cache may hold stale data from the previous URL — flush so
    // the next /api/models fetches fresh.
    invalidateEngineCache(url);
    return c.json(result);
  },
);

inferenceRoute.get("/status", async (c) => {
  const userId = c.get("userId");
  const [u] = await db
    .select({
      lastInteractionAt: users.lastInteractionAt,
      timezone: users.timezone,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return c.json({ error: "user_not_found" }, 404);
  return c.json({
    lastInteractionAt: u.lastInteractionAt,
    serverTime: new Date().toISOString(),
    timezone: u.timezone,
  });
});

export default inferenceRoute;
