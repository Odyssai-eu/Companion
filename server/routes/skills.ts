/**
 * Skills CRUD — named system-prompt fragments.
 *
 *   GET    /api/skills          → list (user-scoped, alpha by name)
 *   POST   /api/skills          → create
 *   PATCH  /api/skills/:id      → update
 *   DELETE /api/skills/:id      → remove
 *
 * The "apply" action is purely client-side — the InferencePanel writes
 * the skill's body into the chat's systemPrompt state. No server-side
 * apply needed; the skill is just stored prose.
 */

import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { promptSkills } from "../db/schema";

type Env = { Variables: { userId: string } };
const skillsRoute = new Hono<Env>();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  body: z.string().min(1).max(100_000),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

const updateSchema = createSchema.partial();

skillsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(promptSkills)
    .where(eq(promptSkills.userId, userId))
    .orderBy(asc(promptSkills.name));
  return c.json({ skills: rows });
});

skillsRoute.post("/", zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const [row] = await db
    .insert(promptSkills)
    .values({
      userId,
      name: data.name,
      description: data.description ?? null,
      body: data.body,
      tags: data.tags ?? [],
    })
    .returning();
  return c.json({ skill: row });
});

skillsRoute.patch(
  "/:id",
  zValidator("json", updateSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const data = c.req.valid("json");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined)
      patch.description = data.description ?? null;
    if (data.body !== undefined) patch.body = data.body;
    if (data.tags !== undefined) patch.tags = data.tags;
    const [row] = await db
      .update(promptSkills)
      .set(patch)
      .where(and(eq(promptSkills.id, id), eq(promptSkills.userId, userId)))
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ skill: row });
  },
);

skillsRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const r = await db
    .delete(promptSkills)
    .where(and(eq(promptSkills.id, id), eq(promptSkills.userId, userId)))
    .returning({ id: promptSkills.id });
  if (r.length === 0) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});

export default skillsRoute;
