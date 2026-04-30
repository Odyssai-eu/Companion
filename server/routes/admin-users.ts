import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { hashPassword } from "../auth/password";
import { db } from "../db/index";
import { users } from "../db/schema";
import { logAuthEvent, reqMeta } from "../lib/auth-log";
import { requireRole } from "../middleware/auth";

const adminUsersRoute = new Hono();

// Only admins can touch this surface.
adminUsersRoute.use("*", requireRole("admin"));

const ROLES = ["admin", "organiser", "user", "guest"] as const;

const createSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(8).max(200),
  role: z.enum(ROLES),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(ROLES).optional(),
  active: z.boolean().optional(),
  password: z.string().min(8).max(200).optional(),
});

function publicUser(u: {
  id: string;
  email: string;
  name: string | null;
  role: string;
  active: boolean;
  createdAt: Date;
  lastInteractionAt: Date | null;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active,
    createdAt: u.createdAt,
    lastInteractionAt: u.lastInteractionAt,
  };
}

// GET /api/admin/users — list all (admin-first, then alpha by email)
adminUsersRoute.get("/", async (c) => {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      active: users.active,
      createdAt: users.createdAt,
      lastInteractionAt: users.lastInteractionAt,
    })
    .from(users)
    .orderBy(
      // admin first, everyone else after
      sql`case when ${users.role} = 'admin' then 0 else 1 end`,
      asc(users.email),
    );
  return c.json({ users: rows.map(publicUser) });
});

// POST /api/admin/users — create
adminUsersRoute.post("/", zValidator("json", createSchema), async (c) => {
  const { email, name, password, role } = c.req.valid("json");
  const normalized = email.toLowerCase().trim();
  const actor = c.get("user");
  const meta = reqMeta(c);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  if (existing) {
    return c.json(
      { error: "email_taken", detail: "Email is already registered." },
      409,
    );
  }

  const passwordHash = await hashPassword(password);
  const [created] = await db
    .insert(users)
    .values({
      email: normalized,
      name,
      passwordHash,
      role,
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      active: users.active,
      createdAt: users.createdAt,
      lastInteractionAt: users.lastInteractionAt,
    });

  logAuthEvent({
    userId: actor.id,
    event: "user.create",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { targetUserId: created.id, email: created.email, role: created.role },
  });

  return c.json({ user: publicUser(created) }, 201);
});

// PATCH /api/admin/users/:id — update
adminUsersRoute.patch(
  "/:id",
  zValidator("json", updateSchema),
  async (c) => {
    const id = c.req.param("id");
    const patch = c.req.valid("json");
    const actor = c.get("user");
    const meta = reqMeta(c);

    if (Object.keys(patch).length === 0) {
      return c.json({ error: "empty_patch" }, 400);
    }

    // Self-deactivation guard.
    if (patch.active === false && id === actor.id) {
      return c.json(
        { error: "cannot_deactivate_self" },
        400,
      );
    }

    try {
      const updated = await db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(users)
          .where(eq(users.id, id))
          .limit(1);
        if (!target) {
          throw new HttpError(404, "not_found");
        }

        // Last-admin protection. If this change would remove the last
        // active admin (via role demotion or deactivation), refuse.
        const wouldRemoveAdmin =
          (target.role === "admin" &&
            patch.role !== undefined &&
            patch.role !== "admin") ||
          (target.role === "admin" &&
            target.active &&
            patch.active === false);

        if (wouldRemoveAdmin) {
          const [{ count }] = await tx
            .select({ count: sql<number>`count(*)::int` })
            .from(users)
            .where(
              and(
                eq(users.role, "admin"),
                eq(users.active, true),
                ne(users.id, id),
              ),
            );
          if (count === 0) {
            throw new HttpError(400, "last_admin");
          }
        }

        const set: Partial<typeof users.$inferInsert> = {};
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.role !== undefined) set.role = patch.role;
        if (patch.active !== undefined) set.active = patch.active;
        if (patch.password !== undefined) {
          set.passwordHash = await hashPassword(patch.password);
        }

        const [row] = await tx
          .update(users)
          .set(set)
          .where(eq(users.id, id))
          .returning({
            id: users.id,
            email: users.email,
            name: users.name,
            role: users.role,
            active: users.active,
            createdAt: users.createdAt,
            lastInteractionAt: users.lastInteractionAt,
          });

        return { row, before: target };
      });

      // Audit events — outside the tx, fire-and-forget.
      if (
        patch.role !== undefined &&
        patch.role !== updated.before.role
      ) {
        logAuthEvent({
          userId: actor.id,
          event: "user.role.change",
          ip: meta.ip,
          userAgent: meta.userAgent,
          meta: {
            targetUserId: id,
            from: updated.before.role,
            to: patch.role,
          },
        });
      }
      if (
        patch.active !== undefined &&
        patch.active !== updated.before.active
      ) {
        logAuthEvent({
          userId: actor.id,
          event: patch.active ? "user.activate" : "user.deactivate",
          ip: meta.ip,
          userAgent: meta.userAgent,
          meta: { targetUserId: id },
        });
      }
      if (patch.password !== undefined) {
        logAuthEvent({
          userId: actor.id,
          event: "user.password.reset",
          ip: meta.ip,
          userAgent: meta.userAgent,
          meta: { targetUserId: id },
        });
      }
      if (patch.name !== undefined && patch.name !== updated.before.name) {
        logAuthEvent({
          userId: actor.id,
          event: "user.update",
          ip: meta.ip,
          userAgent: meta.userAgent,
          meta: { targetUserId: id, field: "name" },
        });
      }

      return c.json({ user: publicUser(updated.row) });
    } catch (err) {
      if (err instanceof HttpError) {
        return c.json({ error: err.code }, err.status as 400 | 404);
      }
      throw err;
    }
  },
);

// DELETE /api/admin/users/:id — soft-delete (active=false)
adminUsersRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  const meta = reqMeta(c);

  if (id === actor.id) {
    return c.json({ error: "cannot_delete_self" }, 400);
  }

  try {
    await db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      if (!target) {
        throw new HttpError(404, "not_found");
      }
      if (!target.active) {
        // already deactivated — no-op, still report success
        return;
      }
      if (target.role === "admin") {
        const [{ count }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(
            and(
              eq(users.role, "admin"),
              eq(users.active, true),
              ne(users.id, id),
            ),
          );
        if (count === 0) {
          throw new HttpError(400, "last_admin");
        }
      }
      await tx
        .update(users)
        .set({ active: false })
        .where(eq(users.id, id));
    });

    logAuthEvent({
      userId: actor.id,
      event: "user.deactivate",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { targetUserId: id, via: "delete" },
    });

    return c.body(null, 204);
  } catch (err) {
    if (err instanceof HttpError) {
      return c.json({ error: err.code }, err.status as 400 | 404);
    }
    throw err;
  }
});

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export default adminUsersRoute;
