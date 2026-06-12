/**
 * POST /api/admin/nemo-sync
 *
 * One-shot sync of the user's memory into the LightRAG knowledge graph.
 * Sources merged:
 *   1. user_memory_files (vault, per-file)
 *   2. conversations.memory_snapshot (latest per-user Karpathy snapshot)
 *
 * Admin-only. Fire-and-forget option (stream=false returns immediately with
 * a count; stream=true waits for all inserts to complete — use for the
 * initial full sync, can take minutes depending on corpus size and whether
 * OdyssAI-X is up for entity extraction).
 *
 * When NEMO_MEMORY_URL is not set, returns 503 — no-op, won't crash.
 */

import { desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import {
  conversations,
  projectMemoryFiles,
  projects,
  userMemoryFiles,
} from "../db/schema";
import { requireRole } from "../middleware/auth";
import { isNemoAvailable, nemoIngest } from "../lib/memory";

const nemoSyncRoute = new Hono<{ Variables: { userId: string } }>();
nemoSyncRoute.use("*", requireRole("admin"));

nemoSyncRoute.post("/", async (c) => {
  if (!isNemoAvailable()) {
    return c.json({ error: "nemo_unavailable", detail: "NEMO_MEMORY_URL not configured." }, 503);
  }

  const userId = c.get("userId");
  const scope = c.req.query("scope") ?? "user";

  // ── scope=team : ingest the team's shared corpus into the team collection ──
  // The "team memory" level is the vaults of the projects that belong to the
  // team (projects.teamId). Collection = teamId; the service URL resolves from
  // the acting admin's RAG config. The query side already reads this collection
  // (chat.ts passes projectTeamId to nemoQuery) — this fills it.
  if (scope === "team") {
    const teamId = c.req.query("teamId");
    if (!teamId) return c.json({ error: "teamId_required" }, 400);
    const teamProjects = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.teamId, teamId));
    const projectIds = teamProjects.map((p) => p.id);
    const files = projectIds.length
      ? await db
          .select({
            projectId: projectMemoryFiles.projectId,
            path: projectMemoryFiles.path,
            content: projectMemoryFiles.content,
          })
          .from(projectMemoryFiles)
          .where(inArray(projectMemoryFiles.projectId, projectIds))
      : [];
    const runTeamSync = () => {
      let n = 0;
      for (const f of files) {
        if (!f.content?.trim()) continue;
        nemoIngest(
          teamId,
          `team-project:${f.projectId}:${f.path}`,
          f.content,
          "team",
        );
        n++;
      }
      return n;
    };
    const wantWait = c.req.query("wait") === "true";
    const ingested = wantWait ? runTeamSync() : (runTeamSync(), undefined);
    return c.json({
      ok: true,
      scope: "team",
      projects: projectIds.length,
      files: files.length,
      ...(wantWait ? { ingested } : { queued: true }),
    });
  }

  // ── scope=project : backfill a project's vault into its RAG collection ──
  // The project tier reads collection projectId (fed per-compile by
  // project-compile.ts); this seeds it from the existing vault files.
  if (scope === "project") {
    const projectId = c.req.query("projectId");
    if (!projectId) return c.json({ error: "projectId_required" }, 400);
    const files = await db
      .select({ path: projectMemoryFiles.path, content: projectMemoryFiles.content })
      .from(projectMemoryFiles)
      .where(eq(projectMemoryFiles.projectId, projectId));
    let n = 0;
    for (const f of files) {
      if (!f.content?.trim()) continue;
      nemoIngest(projectId, `project:${projectId}:${f.path}`, f.content, "project");
      n++;
    }
    return c.json({ ok: true, scope: "project", files: files.length, queued: n });
  }

  // 1. Vault files (user_memory_files)
  const vaultFiles = await db
    .select({ path: userMemoryFiles.path, content: userMemoryFiles.content })
    .from(userMemoryFiles)
    .where(eq(userMemoryFiles.userId, userId));

  // 2. Latest Karpathy snapshot (most recent non-null memory_snapshot)
  const snapshots = await db
    .select({ snap: conversations.memorySnapshot })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(desc(conversations.updatedAt))
    .limit(20);

  const latestSnapshot = snapshots.find((s) => s.snap)?.snap ?? null;

  const wait = c.req.query("wait") === "true";

  async function runSync() {
    let ingested = 0;

    // Vault files — one ingest per file
    for (const f of vaultFiles) {
      if (!f.content?.trim()) continue;
      nemoIngest(userId, `vault:${f.path}`, f.content, "vault");
      ingested++;
    }

    // Karpathy snapshot — ingest as a single article
    if (latestSnapshot?.trim()) {
      nemoIngest(userId, `wiki:${userId}`, latestSnapshot, "wiki");
      ingested++;
    }

    return ingested;
  }

  if (wait) {
    // Synchronous path: wait for all HTTP calls to fire (not for LightRAG
    // graph build, which is async inside nemo-memory)
    const count = await runSync();
    return c.json({
      ok: true,
      ingested: count,
      vault_files: vaultFiles.length,
      has_snapshot: !!latestSnapshot,
    });
  } else {
    // Fire-and-forget
    void runSync();
    return c.json({
      ok: true,
      queued: true,
      vault_files: vaultFiles.length,
      has_snapshot: !!latestSnapshot,
    });
  }
});

export default nemoSyncRoute;
