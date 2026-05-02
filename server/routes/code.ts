import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { codeSessions } from "../db/schema";
import {
  runConfiguredCodePreflight,
  writeConfiguredTests,
  type CodeWriteFile,
} from "../lib/code-runner-client";
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

const hermesWriteSchema = z.object({
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
            "running",
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

codeRoute.post(
  "/:id/hermes-write-tests",
  zValidator("json", hermesWriteSchema),
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
    if ((session.blockers ?? []).length > 0) {
      return c.json({ error: "blocked_preflight", blockers: session.blockers }, 400);
    }

    const hermes = await loadHermesConfig(userId);
    if (!hermes) {
      return c.json({ error: "hermes_not_enabled" }, 400);
    }

    const model = body.model ?? session.model ?? hermes.defaultModel;
    const skills = body.skills ?? hermes.selectedSkills;
    const prompt = buildHermesWriteTestsPrompt({
      task: session.task,
      repoPath: session.repoPath,
      preflight: session.preflight,
    });

    await db
      .update(codeSessions)
      .set({
        model,
        status: "hermes_writing",
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
        timeoutMs: 240_000,
      });
      if (h.status !== "done") {
        const [updated] = await db
          .update(codeSessions)
          .set({
            model,
            status: "hermes_failed",
            hermesSessionId: h.id,
            hermesStatus: h.status,
            hermesOutput: h.output,
            hermesError: h.error,
            updatedAt: new Date(),
          })
          .where(eq(codeSessions.id, id))
          .returning();
        return c.json({ session: updated, hermes: h }, 502);
      }

      const proposal = parseHermesTestProposal(h.output);
      const write = await writeConfiguredTests({
        repoPath: session.repoPath,
        task: session.task,
        files: proposal.files,
      });
      const status = write.ok ? "write_done" : "write_blocked";
      const output = [
        h.output,
        "",
        "TheCompAI runner write result:",
        JSON.stringify(write, null, 2),
      ].join("\n");
      const [updated] = await db
        .update(codeSessions)
        .set({
          model,
          status,
          hermesSessionId: h.id,
          hermesStatus: h.status,
          hermesOutput: output,
          hermesError: write.ok ? h.error : write.blockers.join("\n"),
          updatedAt: new Date(),
        })
        .where(eq(codeSessions.id, id))
        .returning();
      return c.json({ session: updated, hermes: h, write });
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
      return c.json({ session: updated, error: (e as Error).message }, 502);
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
    "- If the thecompai-code-runner skill is available, use it for repository access. Do not inspect this path through Hermes' local filesystem.",
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

function buildHermesWriteTestsPrompt({
  task,
  repoPath,
  preflight,
}: {
  task: string;
  repoPath: string;
  preflight: Record<string, unknown>;
}) {
  return [
    "You are generating a constrained test-file write proposal for TheCompAI.",
    "",
    "Hard rules:",
    "- Return JSON only. No markdown fence, no prose.",
    "- Do not ask a question if the needed facts are in the preflight JSON.",
    "- Only propose test files. Allowed paths: tests/**, __tests__/**, **/*.test.ts, **/*.test.tsx, **/*.spec.ts, **/*.spec.tsx, and JS equivalents.",
    "- Do not propose edits to application/source files.",
    "- Do not propose package installs, git commands, deploy commands, or formatting runs.",
    "- If you cannot produce a useful test file, return {\"files\":[],\"blockers\":[\"reason\"]}.",
    "",
    `Repository path: ${repoPath}`,
    "",
    "User task:",
    task,
    "",
    "Context preflight JSON:",
    JSON.stringify(preflight, null, 2).slice(0, 24_000),
    "",
    "Required JSON shape:",
    "{\"files\":[{\"path\":\"tests/example.test.ts\",\"content\":\"...\"}],\"blockers\":[],\"summary\":\"...\"}",
  ].join("\n");
}

function parseHermesTestProposal(output: string): {
  files: CodeWriteFile[];
  blockers: string[];
  summary?: string;
} {
  const trimmed = output.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced?.[1]?.trim() ?? trimmed;
  const parsed = JSON.parse(jsonText) as {
    files?: Array<{ path?: unknown; content?: unknown }>;
    blockers?: unknown;
    summary?: unknown;
  };
  const files = Array.isArray(parsed.files)
    ? parsed.files
        .map((f) => ({
          path: String(f.path ?? "").trim(),
          content: String(f.content ?? ""),
        }))
        .filter((f) => f.path && f.content)
    : [];
  const blockers = Array.isArray(parsed.blockers)
    ? parsed.blockers.map((b) => String(b))
    : [];
  if (files.length === 0 && blockers.length === 0) {
    blockers.push("hermes_returned_no_files");
  }
  return {
    files,
    blockers,
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
  };
}

export default codeRoute;
