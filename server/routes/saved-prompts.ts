/**
 * Saved prompts — user-owned library of named system prompts.
 *
 *   GET    /api/saved-prompts          → list all prompts for the user
 *   POST   /api/saved-prompts          → create {name, body}
 *   PATCH  /api/saved-prompts/:id      → update {name?, body?}
 *   DELETE /api/saved-prompts/:id      → remove
 *
 * Names are unique per user (DB-enforced). The chat InferencePanel
 * lists them in a `Load saved…` dropdown; loading sets the conv-level
 * system prompt without persisting back. Save current button captures
 * the current textarea into a new entry under a name the user types.
 */

import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { savedPrompts } from "../db/schema";

type Env = { Variables: { userId: string } };
const savedPromptsRoute = new Hono<Env>();

savedPromptsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(savedPrompts)
    .where(eq(savedPrompts.userId, userId))
    .orderBy(asc(savedPrompts.name));
  return c.json({ prompts: rows });
});

const createSchema = z.object({
  name: z.string().min(1).max(120).trim(),
  body: z.string().min(1).max(50_000),
});

savedPromptsRoute.post("/", zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  try {
    const [row] = await db
      .insert(savedPrompts)
      .values({ userId, name: data.name, body: data.body })
      .returning();
    return c.json({ prompt: row }, 201);
  } catch (e) {
    // Unique constraint violation on (user_id, name) → 409
    if ((e as { code?: string }).code === "23505") {
      return c.json({ error: "name_taken" }, 409);
    }
    throw e;
  }
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).trim().optional(),
  body: z.string().min(1).max(50_000).optional(),
});

savedPromptsRoute.patch("/:id", zValidator("json", updateSchema), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [existing] = await db
    .select({ userId: savedPrompts.userId })
    .from(savedPrompts)
    .where(eq(savedPrompts.id, id))
    .limit(1);
  if (!existing || existing.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const data = c.req.valid("json");
  const patch: { name?: string; body?: string; updatedAt: Date } = {
    updatedAt: new Date(),
  };
  if (data.name !== undefined) patch.name = data.name;
  if (data.body !== undefined) patch.body = data.body;
  try {
    const [row] = await db
      .update(savedPrompts)
      .set(patch)
      .where(and(eq(savedPrompts.id, id), eq(savedPrompts.userId, userId)))
      .returning();
    return c.json({ prompt: row });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return c.json({ error: "name_taken" }, 409);
    }
    throw e;
  }
});

savedPromptsRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [existing] = await db
    .select({ userId: savedPrompts.userId })
    .from(savedPrompts)
    .where(eq(savedPrompts.id, id))
    .limit(1);
  if (!existing || existing.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  await db
    .delete(savedPrompts)
    .where(and(eq(savedPrompts.id, id), eq(savedPrompts.userId, userId)));
  return c.body(null, 204);
});

export default savedPromptsRoute;
