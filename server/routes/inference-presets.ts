/**
 * Inference presets — CRUD on saved LLM sampling-param bundles.
 *
 *   GET    /api/inference/presets       → list (user-scoped)
 *   POST   /api/inference/presets       → create
 *   PATCH  /api/inference/presets/:id   → update
 *   DELETE /api/inference/presets/:id   → delete
 *
 * The "apply" action is purely client-side — frontend writes the
 * preset's values into the chat's localStorage inference state and
 * dispatches an event so useChat re-reads. No server "apply" endpoint
 * needed; the preset is just data.
 */

import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { inferencePresets } from "../db/schema";

type Env = { Variables: { userId: string } };
const inferencePresetsRoute = new Hono<Env>();

// Param values are all nullable: null = "leave default, don't push the
// param to upstream". This matches the chat-side InferenceParams semantics.
const paramSchema = z.object({
  temperature: z.number().min(0).max(2).nullable().optional(),
  topP: z.number().min(0).max(1).nullable().optional(),
  topK: z.number().int().min(1).max(1000).nullable().optional(),
  minP: z.number().min(0).max(1).nullable().optional(),
  repetitionPenalty: z.number().min(0).max(5).nullable().optional(),
  maxTokens: z.number().int().min(1).max(1_048_576).nullable().optional(),
  seed: z.number().int().nullable().optional(),
  thinking: z.boolean().nullable().optional(),
  reasoningEffort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
    .nullable()
    .optional(),
});

const createSchema = paramSchema.extend({
  name: z.string().min(1).max(120),
  modelId: z.string().max(200).nullable().optional(),
  hfReferenceUrl: z.string().url().max(500).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

const updateSchema = createSchema.partial();

inferencePresetsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(inferencePresets)
    .where(eq(inferencePresets.userId, userId))
    .orderBy(asc(inferencePresets.name));
  return c.json({ presets: rows });
});

inferencePresetsRoute.post(
  "/",
  zValidator("json", createSchema),
  async (c) => {
    const userId = c.get("userId");
    const data = c.req.valid("json");
    const [row] = await db
      .insert(inferencePresets)
      .values({
        userId,
        name: data.name,
        modelId: data.modelId ?? null,
        temperature: data.temperature ?? null,
        topP: data.topP ?? null,
        topK: data.topK ?? null,
        minP: data.minP ?? null,
        repetitionPenalty: data.repetitionPenalty ?? null,
        maxTokens: data.maxTokens ?? null,
        seed: data.seed ?? null,
        thinking: data.thinking ?? null,
        reasoningEffort: data.reasoningEffort ?? null,
        hfReferenceUrl: data.hfReferenceUrl ?? null,
        notes: data.notes ?? null,
      })
      .returning();
    return c.json({ preset: row });
  },
);

inferencePresetsRoute.patch(
  "/:id",
  zValidator("json", updateSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const data = c.req.valid("json");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.modelId !== undefined) patch.modelId = data.modelId ?? null;
    if (data.temperature !== undefined)
      patch.temperature = data.temperature ?? null;
    if (data.topP !== undefined) patch.topP = data.topP ?? null;
    if (data.topK !== undefined) patch.topK = data.topK ?? null;
    if (data.minP !== undefined) patch.minP = data.minP ?? null;
    if (data.repetitionPenalty !== undefined)
      patch.repetitionPenalty = data.repetitionPenalty ?? null;
    if (data.maxTokens !== undefined) patch.maxTokens = data.maxTokens ?? null;
    if (data.seed !== undefined) patch.seed = data.seed ?? null;
    if (data.thinking !== undefined) patch.thinking = data.thinking ?? null;
    if (data.reasoningEffort !== undefined)
      patch.reasoningEffort = data.reasoningEffort ?? null;
    if (data.hfReferenceUrl !== undefined)
      patch.hfReferenceUrl = data.hfReferenceUrl ?? null;
    if (data.notes !== undefined) patch.notes = data.notes ?? null;
    const [row] = await db
      .update(inferencePresets)
      .set(patch)
      .where(
        and(
          eq(inferencePresets.id, id),
          eq(inferencePresets.userId, userId),
        ),
      )
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ preset: row });
  },
);

inferencePresetsRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const r = await db
    .delete(inferencePresets)
    .where(
      and(
        eq(inferencePresets.id, id),
        eq(inferencePresets.userId, userId),
      ),
    )
    .returning({ id: inferencePresets.id });
  if (r.length === 0) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});

export default inferencePresetsRoute;
