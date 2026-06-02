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
 * Odysseus is up for entity extraction).
 *
 * When NEMO_MEMORY_URL is not set, returns 503 — no-op, won't crash.
 */

import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { conversations, userMemoryFiles } from "../db/schema";
import { requireRole } from "../middleware/auth";
import { isNemoAvailable, nemoIngest } from "../lib/memory";

const nemoSyncRoute = new Hono<{ Variables: { userId: string } }>();
nemoSyncRoute.use("*", requireRole("admin"));

nemoSyncRoute.post("/", async (c) => {
  if (!isNemoAvailable()) {
    return c.json({ error: "nemo_unavailable", detail: "NEMO_MEMORY_URL not configured." }, 503);
  }

  const userId = c.get("userId");

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
