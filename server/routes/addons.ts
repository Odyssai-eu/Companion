import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { addons } from "../db/schema";

const addonsRoute = new Hono();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(["core", "plugin", "mcp"]).default("plugin"),
  description: z.string().max(500).optional(),
  version: z.string().max(40).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullish(),
  version: z.string().max(40).nullish(),
  enabled: z.boolean().optional(),
  config: z.record(z.unknown()).nullish(),
});

addonsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(addons)
    .where(eq(addons.userId, userId))
    .orderBy(asc(addons.createdAt));
  return c.json({ addons: rows });
});

addonsRoute.post("/", zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const [row] = await db
    .insert(addons)
    .values({
      userId,
      name: data.name,
      kind: data.kind,
      description: data.description,
      version: data.version,
      enabled: data.enabled ?? false,
      config: data.config,
    })
    .returning();
  return c.json({ addon: row }, 201);
});

addonsRoute.patch(
  "/:id",
  zValidator("json", updateSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const [existing] = await db
      .select()
      .from(addons)
      .where(eq(addons.id, id))
      .limit(1);
    if (!existing || existing.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }
    const data = c.req.valid("json");
    const patch: Partial<typeof addons.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (data.name !== undefined) patch.name = data.name;
    if (data.description !== undefined)
      patch.description = data.description ?? null;
    if (data.version !== undefined) patch.version = data.version ?? null;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.config !== undefined) patch.config = data.config ?? null;
    const [updated] = await db
      .update(addons)
      .set(patch)
      .where(eq(addons.id, id))
      .returning();
    return c.json({ addon: updated });
  },
);

addonsRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [existing] = await db
    .select({ userId: addons.userId, kind: addons.kind })
    .from(addons)
    .where(eq(addons.id, id))
    .limit(1);
  if (!existing || existing.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  if (existing.kind === "core") {
    return c.json({ error: "cannot_delete_core" }, 400);
  }
  await db.delete(addons).where(eq(addons.id, id));
  return c.body(null, 204);
});

export default addonsRoute;
