import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import {
  nodeGroupMembers,
  nodeGroups,
  nodes,
  syncJobs,
} from "../db/schema";
import { logAuthEvent, reqMeta } from "../lib/auth-log";
import { listNodeModels } from "../lib/file-listing";
import {
  cancelJob,
  getJob,
  isTerminal,
  listJobs,
  startSyncJob,
  subscribe,
  type SyncEvent,
} from "../lib/sync-runner";
import { requireRole } from "../middleware/auth";

const adminSyncRoute = new Hono();

adminSyncRoute.use("*", requireRole("admin", "organiser"));

const ALL_STATUSES = ["queued", "running", "done", "failed", "canceled"] as const;

const startSchema = z
  .object({
    sourceNodeId: z.string().uuid(),
    targetNodeIds: z.array(z.string().uuid()).optional(),
    groupId: z.string().uuid().optional(),
    modelPath: z.string().min(1).max(512),
  })
  .refine(
    (v) =>
      (v.targetNodeIds && v.targetNodeIds.length > 0) || Boolean(v.groupId),
    { message: "targetNodeIds or groupId is required" },
  );

const listQuerySchema = z.object({
  status: z.enum(ALL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// ── GET /api/admin/sync — list user's jobs ──────────────────────────────
adminSyncRoute.get("/", zValidator("query", listQuerySchema), async (c) => {
  const actor = c.get("user");
  const { status, limit } = c.req.valid("query");
  const rows = await listJobs(actor.id, { status, limit });
  return c.json({ jobs: rows });
});

// ── GET /api/admin/sync/matrix — model presence matrix ──────────────────
// Returns one entry per node with:
//   - freeBytes: filesystem free space at modelPath
//   - models[]:  every direct subdir of modelPath with its sizeBytes
// The UI pivots this server payload into a per-model table where rows are
// models, columns are nodes, each cell shows ✓ + size, with a delete button
// per cell and a sync button per row.
adminSyncRoute.get("/matrix", async (c) => {
  const actor = c.get("user");
  const rows = await db
    .select({
      id: nodes.id,
      name: nodes.name,
      ip: nodes.ip,
      sshUser: nodes.sshUser,
      modelPath: nodes.modelPath,
      sshKeySetup: nodes.sshKeySetup,
      status: nodes.status,
    })
    .from(nodes)
    .where(eq(nodes.userId, actor.id));

  const results = await Promise.all(
    rows.map(async (n) => {
      if (!n.sshKeySetup) {
        return {
          nodeId: n.id,
          nodeName: n.name,
          freeBytes: null,
          models: [],
        };
      }
      const listing = await listNodeModels({
        id: n.id,
        ip: n.ip,
        sshUser: n.sshUser,
        modelPath: n.modelPath,
      });
      return {
        nodeId: n.id,
        nodeName: n.name,
        freeBytes: listing.freeBytes,
        models: listing.models,
      };
    }),
  );
  return c.json({ matrix: results });
});

// ── GET /api/admin/sync/:id ─────────────────────────────────────────────
adminSyncRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  const job = await getJob(id);
  if (!job || job.userId !== actor.id) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.json({ job });
});

// ── POST /api/admin/sync — start a sync ─────────────────────────────────
adminSyncRoute.post("/", zValidator("json", startSchema), async (c) => {
  const body = c.req.valid("json");
  const actor = c.get("user");
  const meta = reqMeta(c);

  // Resolve the source — must belong to the user.
  const [source] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, body.sourceNodeId), eq(nodes.userId, actor.id)))
    .limit(1);
  if (!source) {
    return c.json({ error: "source_not_found" }, 404);
  }
  if (!source.sshKeySetup) {
    return c.json({ error: "source_no_ssh_key" }, 400);
  }

  // Resolve targets.
  let targetIds: string[] = [];

  if (body.groupId) {
    const [group] = await db
      .select({ id: nodeGroups.id })
      .from(nodeGroups)
      .where(
        and(
          eq(nodeGroups.id, body.groupId),
          eq(nodeGroups.userId, actor.id),
        ),
      )
      .limit(1);
    if (!group) {
      return c.json({ error: "group_not_found" }, 404);
    }
    const members = await db
      .select({ nodeId: nodeGroupMembers.nodeId })
      .from(nodeGroupMembers)
      .innerJoin(nodes, eq(nodes.id, nodeGroupMembers.nodeId))
      .where(
        and(
          eq(nodeGroupMembers.groupId, body.groupId),
          eq(nodes.userId, actor.id),
        ),
      );
    targetIds = members.map((m) => m.nodeId);
  }

  if (body.targetNodeIds && body.targetNodeIds.length > 0) {
    // Validate ownership of explicit targets.
    const owned = await db
      .select({ id: nodes.id, sshKeySetup: nodes.sshKeySetup })
      .from(nodes)
      .where(
        and(
          eq(nodes.userId, actor.id),
          inArray(nodes.id, body.targetNodeIds),
        ),
      );
    if (owned.length !== body.targetNodeIds.length) {
      return c.json({ error: "target_ownership_mismatch" }, 403);
    }
    const notReady = owned.filter((n) => !n.sshKeySetup).map((n) => n.id);
    if (notReady.length > 0) {
      return c.json({ error: "target_no_ssh_key", nodeIds: notReady }, 400);
    }
    // Merge with group-derived targets, dedupe.
    targetIds = Array.from(new Set([...targetIds, ...body.targetNodeIds]));
  }

  // Drop the source from targets — pushing a model onto itself is a no-op
  // and would fail the rsync (path collision on staging push).
  targetIds = targetIds.filter((id) => id !== body.sourceNodeId);

  if (targetIds.length === 0) {
    return c.json({ error: "no_targets" }, 400);
  }

  const { jobId } = await startSyncJob({
    userId: actor.id,
    sourceNodeId: body.sourceNodeId,
    targetNodeIds: targetIds,
    modelPath: body.modelPath,
    groupId: body.groupId ?? null,
  });

  logAuthEvent({
    userId: actor.id,
    event: "sync.start",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: {
      jobId,
      sourceNodeId: body.sourceNodeId,
      targetCount: targetIds.length,
      modelPath: body.modelPath,
    },
  });

  return c.json({ jobId }, 202);
});

// ── POST /api/admin/sync/:id/cancel ─────────────────────────────────────
adminSyncRoute.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  const meta = reqMeta(c);

  // Ownership check via DB row before asking the runner.
  const [row] = await db
    .select({ id: syncJobs.id, userId: syncJobs.userId })
    .from(syncJobs)
    .where(eq(syncJobs.id, id))
    .limit(1);
  if (!row || row.userId !== actor.id) {
    return c.json({ error: "not_found" }, 404);
  }

  const ok = await cancelJob(id, actor.id);
  if (!ok) {
    return c.json({ error: "cannot_cancel" }, 409);
  }
  logAuthEvent({
    userId: actor.id,
    event: "sync.cancel",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { jobId: id },
  });
  return c.json({ ok: true });
});

// ── GET /api/admin/sync/:id/events — SSE stream ─────────────────────────
adminSyncRoute.get("/:id/events", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");

  const job = await getJob(id);
  if (!job || job.userId !== actor.id) {
    return c.json({ error: "not_found" }, 404);
  }

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const write = (s: string) => {
    writer.write(encoder.encode(s)).catch(() => undefined);
  };

  // Initial snapshot so the client can render immediately.
  write(":keepalive\n\n");
  write(
    `data: ${JSON.stringify({
      type: "snapshot",
      status: job.status,
      progress: job.progress,
      currentTarget: job.currentTarget ?? null,
    })}\n\n`,
  );

  const heartbeat = setInterval(() => {
    write(":keepalive\n\n");
  }, 25_000);

  const userId = actor.id;
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsub();
    try {
      void writer.close();
    } catch {
      /* noop */
    }
  };

  const handler = (ev: SyncEvent) => {
    write(`data: ${JSON.stringify(ev)}\n\n`);
    if (ev.type === "status" && isTerminal(ev.status)) {
      cleanup();
    }
  };
  const unsub = subscribe(id, handler);

  // If the job was already terminal when the request arrived, close right away
  // after sending the snapshot so clients don't hang.
  if (isTerminal(job.status)) {
    cleanup();
  }

  // Tie cleanup to the Hono context's abort signal (request closed).
  c.req.raw.signal.addEventListener("abort", cleanup);

  // Touch userId so the linter doesn't whine — useful if we later want to
  // cross-check on each event.
  void userId;

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return c.body(readable);
});

export default adminSyncRoute;
