import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { codeSessions } from "../db/schema";
import { runConfiguredCodePreflight } from "../lib/code-runner-client";
import { loadHermesConfig, startHermesSession } from "../lib/hermes-client";

type Env = { Variables: { userId: string } };
const codeRoute = new Hono<Env>();

const preflightSchema = z.object({
  repoPath: z.string().min(1).max(600),
  task: z.string().min(1).max(8000),
  model: z.string().max(160).optional(),
  project: z.string().max(120).optional(),
});

const hermesPreflightSchema = z.object({
  model: z.string().min(1).max(160).optional(),
  skills: z.array(z.string().min(1).max(120)).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const clearQuerySchema = z.object({
  scope: z.enum(["terminal", "all"]).optional(),
});

codeRoute.get("/", zValidator("query", listQuerySchema), async (c) => {
  const userId = c.get("userId");
  const { limit = 30 } = c.req.valid("query");
  const rows = await db
    .select()
    .from(codeSessions)
    .where(eq(codeSessions.userId, userId))
    .orderBy(desc(codeSessions.createdAt))
    .limit(limit);
  return c.json({ sessions: rows });
});

codeRoute.get("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(codeSessions)
    .where(eq(codeSessions.id, id))
    .limit(1);
  if (!row || row.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ session: row });
});

codeRoute.delete("/", zValidator("query", clearQuerySchema), async (c) => {
  const userId = c.get("userId");
  const { scope = "terminal" } = c.req.valid("query");
  const where =
    scope === "all"
      ? eq(codeSessions.userId, userId)
      : and(
          eq(codeSessions.userId, userId),
          inArray(codeSessions.status, [
            "blocked",
            "failed",
            "cancelled",
            "canceled",
            "hermes_failed",
          ]),
        );
  const deleted = await db.delete(codeSessions).where(where).returning({
    id: codeSessions.id,
  });
  return c.json({ deleted: deleted.length });
});

codeRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [existing] = await db
    .select({ userId: codeSessions.userId })
    .from(codeSessions)
    .where(eq(codeSessions.id, id))
    .limit(1);
  if (!existing || existing.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  await db.delete(codeSessions).where(eq(codeSessions.id, id));
  return c.body(null, 204);
});

codeRoute.post("/preflight", zValidator("json", preflightSchema), async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");
  const preflight = await runConfiguredCodePreflight(body);
  const status = preflight.blockers.length > 0 ? "blocked" : "preflight";
  const [session] = await db
    .insert(codeSessions)
    .values({
      userId,
      repoPath: preflight.repoPath,
      repoName: preflight.repoName,
      task: body.task,
      model: body.model ?? null,
      status,
      risk: preflight.risk,
      preflight: preflight as unknown as Record<string, unknown>,
      blockers: preflight.blockers,
    })
    .returning();
  return c.json({ session, preflight });
});

codeRoute.post(
  "/:id/hermes-preflight",
  zValidator("json", hermesPreflightSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const [session] = await db
      .select()
      .from(codeSessions)
      .where(eq(codeSessions.id, id))
      .limit(1);
    if (!session || session.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }
    if (!session.preflight) {
      return c.json({ error: "missing_preflight" }, 400);
    }

    const hermes = await loadHermesConfig(userId);
    if (!hermes) {
      return c.json({ error: "hermes_not_enabled" }, 400);
    }

    const model = body.model ?? session.model ?? hermes.defaultModel;
    const skills = body.skills ?? hermes.selectedSkills;
    const prompt = buildHermesReadOnlyPrompt({
      task: session.task,
      repoPath: session.repoPath,
      preflight: session.preflight,
    });

    await db
      .update(codeSessions)
      .set({
        model,
        status: "hermes_preflight",
        hermesStatus: "running",
        updatedAt: new Date(),
      })
      .where(eq(codeSessions.id, id));

    try {
      const h = await startHermesSession({
        bridgeUrl: hermes.bridgeUrl,
        prompt,
        mode: "quick",
        model,
        skills,
        yolo: false,
        timeoutMs: 200_000,
      });
      const status = h.status === "done" ? "hermes_done" : "hermes_failed";
      const [updated] = await db
        .update(codeSessions)
        .set({
          model,
          status,
          hermesSessionId: h.id,
          hermesStatus: h.status,
          hermesOutput: h.output,
          hermesError: h.error,
          updatedAt: new Date(),
        })
        .where(eq(codeSessions.id, id))
        .returning();
      return c.json({ session: updated, hermes: h });
    } catch (e) {
      const [updated] = await db
        .update(codeSessions)
        .set({
          model,
          status: "hermes_failed",
          hermesStatus: "failed",
          hermesError: (e as Error).message,
          updatedAt: new Date(),
        })
        .where(eq(codeSessions.id, id))
        .returning();
      return c.json(
        { session: updated, error: (e as Error).message },
        502,
      );
    }
  },
);

function buildHermesReadOnlyPrompt({
  task,
  repoPath,
  preflight,
}: {
  task: string;
  repoPath: string;
  preflight: Record<string, unknown>;
}) {
  return [
    "You are running a READ-ONLY coding preflight for TheCompAI.",
    "",
    "Hard rules:",
    "- Do not modify files.",
    "- Do not create files.",
    "- Do not run formatters, migrations, package installs, git checkout, git reset, git commit, rsync, or deploy commands.",
    "- You may only inspect with read-only commands such as pwd, ls, find, rg, sed, git status, git log, git diff --stat, and package manifest reads.",
    "- If access is missing, report BLOCKED and the exact missing access. Do not invent workarounds.",
    "",
    `Repository path: ${repoPath}`,
    "",
    "User task:",
    task,
    "",
    "Context preflight JSON:",
    JSON.stringify(preflight, null, 2).slice(0, 24_000),
    "",
    "Return a concise report with:",
    "1. repo/access status",
    "2. files/docs inspected",
    "3. facts used from context",
    "4. whether Hermes can later write tests for this task",
    "5. exact blockers, if any",
  ].join("\n");
}

export default codeRoute;
