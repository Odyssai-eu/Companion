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
    envDefaultUrl: process.env.LITELLM_URL ?? "http://192.168.86.44:4000",
    inferenceMode: u.inferenceMode as "easy" | "advanced" | "expert",
    easyModel: u.easyModel,
    namedModels: u.namedModels ?? {},
  });
});

const namedModelsSchema = z
  .object({
    conversation: z.string().max(200).optional(),
    analyse: z.string().max(200).optional(),
    engineer: z.string().max(200).optional(),
    expert: z.string().max(200).optional(),
  })
  .optional();

const patchSchema = z.object({
  defaultModel: z.string().max(200).nullish(),
  litellmUrl: z.string().url().max(400).nullish(),
  litellmApiKey: z.string().max(400).nullish(),
  timezone: z.string().min(1).max(80).optional(),
  inferenceMode: z.enum(["easy", "advanced", "expert"]).optional(),
  easyModel: z.string().max(200).nullish(),
  namedModels: namedModelsSchema,
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
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no_fields_to_update" }, 400);
  }
  await db.update(users).set(patch).where(eq(users.id, userId));
  return c.json({ ok: true });
});

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
