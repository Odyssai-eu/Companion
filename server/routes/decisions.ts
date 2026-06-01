/**
 * Decision Log routes — scoped to a project.
 *
 * GET    /api/projects/:id/decisions        list (oldest first, active only)
 * POST   /api/projects/:id/decisions        create
 * DELETE /api/projects/:id/decisions/:did   soft-delete (sets deleted_at)
 *
 * Append-only contract: no PATCH/PUT. A wrong decision gets a superseding
 * entry — the record is never rewritten.
 *
 * Auth: requireUser is applied globally by index.ts on /api/projects/*.
 */
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { decisions, projects } from "../db/schema";

// The route is mounted at /api/projects/:id/decisions — Hono receives the
// :id param from the parent mount, not from sub-router params. We read it
// from the raw path instead.
export const decisionsRoute = new Hono<{ Variables: { userId: string } }>();

// ── helpers ───────────────────────────────────────────────────────────────

function publicDecision(d: typeof decisions.$inferSelect) {
  return {
    id: d.id,
    projectId: d.projectId,
    createdBy: d.createdBy,
    title: d.title,
    context: d.context,
    alternatives: d.alternatives,
    choice: d.choice,
    rationale: d.rationale,
    revisitBy: d.revisitBy,
    createdAt: d.createdAt,
  };
}

async function assertProjectAccess(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const [proj] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return !!proj;
}

// ── GET /api/projects/:id/decisions ──────────────────────────────────────

decisionsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("id");

  if (!projectId || !(await assertProjectAccess(projectId, userId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const rows = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.projectId, projectId), isNull(decisions.deletedAt)))
    .orderBy(decisions.createdAt);

  return c.json({ decisions: rows.map(publicDecision) });
});

// ── POST /api/projects/:id/decisions ─────────────────────────────────────

const createSchema = z.object({
  title: z.string().min(1).max(300),
  context: z.string().max(4000).default(""),
  alternatives: z.string().max(4000).default(""),
  choice: z.string().max(4000).default(""),
  rationale: z.string().max(4000).default(""),
  revisitBy: z.string().date().nullable().optional(),
});

decisionsRoute.post("/", zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("id");

  if (!projectId || !(await assertProjectAccess(projectId, userId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const body = c.req.valid("json");
  const [created] = await db
    .insert(decisions)
    .values({
      projectId,
      createdBy: userId,
      title: body.title,
      context: body.context,
      alternatives: body.alternatives,
      choice: body.choice,
      rationale: body.rationale,
      revisitBy: body.revisitBy ?? null,
    })
    .returning();

  return c.json({ decision: publicDecision(created) }, 201);
});

// ── DELETE /api/projects/:id/decisions/:did ───────────────────────────────
// Soft-delete only — append-only contract preserved.

decisionsRoute.delete("/:did", async (c) => {
  const userId = c.get("userId");
  const projectId = c.req.param("id");
  const did = c.req.param("did");

  if (!projectId || !(await assertProjectAccess(projectId, userId))) {
    return c.json({ error: "not_found" }, 404);
  }

  const [updated] = await db
    .update(decisions)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(decisions.id, did),
        eq(decisions.projectId, projectId),
        isNull(decisions.deletedAt),
      ),
    )
    .returning({ id: decisions.id });

  if (!updated) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});
