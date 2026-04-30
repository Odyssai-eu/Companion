import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { nodeGroupMembers, nodeGroups } from "../db/schema";
import { logAuthEvent, reqMeta } from "../lib/auth-log";
import { requireRole } from "../middleware/auth";

const adminGroupsRoute = new Hono();

adminGroupsRoute.use("*", requireRole("admin", "organiser"));

const createSchema = z.object({
  name: z.string().min(1).max(80),
});

const renameSchema = z.object({
  name: z.string().min(1).max(80),
});

// GET /api/admin/groups — list user's groups with node counts
adminGroupsRoute.get("/", async (c) => {
  const actor = c.get("user");
  const rows = await db
    .select({
      id: nodeGroups.id,
      name: nodeGroups.name,
      createdAt: nodeGroups.createdAt,
      nodeCount: sql<number>`count(${nodeGroupMembers.nodeId})::int`,
    })
    .from(nodeGroups)
    .leftJoin(
      nodeGroupMembers,
      eq(nodeGroupMembers.groupId, nodeGroups.id),
    )
    .where(eq(nodeGroups.userId, actor.id))
    .groupBy(nodeGroups.id, nodeGroups.name, nodeGroups.createdAt)
    .orderBy(asc(nodeGroups.name));

  return c.json({ groups: rows });
});

// POST /api/admin/groups — create
adminGroupsRoute.post("/", zValidator("json", createSchema), async (c) => {
  const { name } = c.req.valid("json");
  const actor = c.get("user");
  const meta = reqMeta(c);

  try {
    const [row] = await db
      .insert(nodeGroups)
      .values({ userId: actor.id, name })
      .returning();

    logAuthEvent({
      userId: actor.id,
      event: "group.create",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { groupId: row.id, name: row.name },
    });
    return c.json({ group: { ...row, nodeCount: 0 } }, 201);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (
      msg.includes("duplicate key") ||
      msg.includes("unique constraint") ||
      msg.includes("node_groups_user_name_idx")
    ) {
      return c.json({ error: "name_taken" }, 409);
    }
    throw err;
  }
});

// PATCH /api/admin/groups/:id — rename
adminGroupsRoute.patch(
  "/:id",
  zValidator("json", renameSchema),
  async (c) => {
    const id = c.req.param("id");
    const { name } = c.req.valid("json");
    const actor = c.get("user");
    const meta = reqMeta(c);

    try {
      const [row] = await db
        .update(nodeGroups)
        .set({ name })
        .where(
          and(eq(nodeGroups.id, id), eq(nodeGroups.userId, actor.id)),
        )
        .returning();
      if (!row) return c.json({ error: "not_found" }, 404);

      logAuthEvent({
        userId: actor.id,
        event: "group.update",
        ip: meta.ip,
        userAgent: meta.userAgent,
        meta: { groupId: id, name },
      });
      return c.json({ group: row });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (
        msg.includes("duplicate key") ||
        msg.includes("unique constraint") ||
        msg.includes("node_groups_user_name_idx")
      ) {
        return c.json({ error: "name_taken" }, 409);
      }
      throw err;
    }
  },
);

// DELETE /api/admin/groups/:id — hard delete
adminGroupsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  const meta = reqMeta(c);

  const deleted = await db
    .delete(nodeGroups)
    .where(and(eq(nodeGroups.id, id), eq(nodeGroups.userId, actor.id)))
    .returning({ id: nodeGroups.id });
  if (deleted.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  logAuthEvent({
    userId: actor.id,
    event: "group.delete",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { groupId: id },
  });
  return c.body(null, 204);
});

// POST /api/admin/groups/seed-defaults — idempotent seed of 'exo' + 'MLX'
adminGroupsRoute.post("/seed-defaults", async (c) => {
  const actor = c.get("user");
  const meta = reqMeta(c);

  const created = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: nodeGroups.id })
      .from(nodeGroups)
      .where(eq(nodeGroups.userId, actor.id))
      .limit(1);
    if (existing.length > 0) return [];
    return tx
      .insert(nodeGroups)
      .values([
        { userId: actor.id, name: "exo" },
        { userId: actor.id, name: "MLX" },
      ])
      .returning();
  });

  if (created.length > 0) {
    logAuthEvent({
      userId: actor.id,
      event: "group.seed",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { count: created.length },
    });
  }

  return c.json({
    seeded: created.length > 0,
    groups: created.map((g) => ({ ...g, nodeCount: 0 })),
  });
});

export default adminGroupsRoute;
