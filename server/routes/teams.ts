/**
 * Teams routes.
 *
 * GET    /api/teams                    list teams the current user belongs to
 * POST   /api/teams                    create team (admin only)
 * GET    /api/teams/:id                get team + members
 * PATCH  /api/teams/:id                update name/description (team admin)
 * DELETE /api/teams/:id                delete team (admin only)
 * GET    /api/teams/:id/members        list members
 * POST   /api/teams/:id/members        add member
 * DELETE /api/teams/:id/members/:uid   remove member
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { teamMembers, teams, users } from "../db/schema";
import { requireRole } from "../middleware/auth";

export const teamsRoute = new Hono<{ Variables: { userId: string } }>();

// ── helpers ───────────────────────────────────────────────────────────────

async function assertTeamAccess(
  teamId: string,
  userId: string,
  adminOnly = false,
): Promise<boolean> {
  const [m] = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  if (!m) return false;
  if (adminOnly) return m.role === "admin";
  return true;
}

function publicTeam(t: typeof teams.$inferSelect) {
  return { id: t.id, name: t.name, description: t.description, createdAt: t.createdAt };
}

// ── GET /api/teams ────────────────────────────────────────────────────────

teamsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select({ team: teams })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId));
  return c.json({ teams: rows.map((r) => publicTeam(r.team)) });
});

// ── POST /api/teams ───────────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(""),
});

teamsRoute.post("/", requireRole("admin"), zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const { name, description } = c.req.valid("json");

  const [team] = await db
    .insert(teams)
    .values({ name, description, createdBy: userId })
    .returning();

  // Creator becomes admin of the team
  await db.insert(teamMembers).values({ teamId: team.id, userId, role: "admin" });

  return c.json({ team: publicTeam(team) }, 201);
});

// ── GET /api/teams/:id ────────────────────────────────────────────────────

teamsRoute.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await assertTeamAccess(id, userId))) return c.json({ error: "not_found" }, 404);

  const [team] = await db.select().from(teams).where(eq(teams.id, id)).limit(1);
  if (!team) return c.json({ error: "not_found" }, 404);

  const members = await db
    .select({ userId: teamMembers.userId, role: teamMembers.role,
               email: users.email, name: users.name })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, id));

  return c.json({ team: publicTeam(team), members });
});

// ── PATCH /api/teams/:id ──────────────────────────────────────────────────

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
});

teamsRoute.patch("/:id", zValidator("json", updateSchema), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await assertTeamAccess(id, userId, true))) return c.json({ error: "forbidden" }, 403);

  const body = c.req.valid("json");
  const patch: Partial<typeof teams.$inferInsert> = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.description !== undefined) patch.description = body.description;

  const [updated] = await db.update(teams).set(patch).where(eq(teams.id, id)).returning();
  return c.json({ team: publicTeam(updated) });
});

// ── DELETE /api/teams/:id ─────────────────────────────────────────────────

teamsRoute.delete("/:id", requireRole("admin"), async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await assertTeamAccess(id, userId, true))) return c.json({ error: "forbidden" }, 403);
  await db.delete(teams).where(eq(teams.id, id));
  return c.body(null, 204);
});

// ── POST /api/teams/:id/members ───────────────────────────────────────────

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["admin", "member"]).default("member"),
});

teamsRoute.post("/:id/members", zValidator("json", addMemberSchema), async (c) => {
  const actorId = c.get("userId");
  const teamId = c.req.param("id");
  if (!(await assertTeamAccess(teamId, actorId, true))) return c.json({ error: "forbidden" }, 403);

  const { userId, role } = c.req.valid("json");
  await db
    .insert(teamMembers)
    .values({ teamId, userId, role })
    .onConflictDoUpdate({ target: [teamMembers.teamId, teamMembers.userId],
                          set: { role } });
  return c.json({ ok: true }, 201);
});

// ── DELETE /api/teams/:id/members/:uid ────────────────────────────────────

teamsRoute.delete("/:id/members/:uid", async (c) => {
  const actorId = c.get("userId");
  const teamId = c.req.param("id");
  const uid = c.req.param("uid");
  if (!(await assertTeamAccess(teamId, actorId, true))) return c.json({ error: "forbidden" }, 403);
  await db.delete(teamMembers).where(
    and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, uid)),
  );
  return c.body(null, 204);
});
