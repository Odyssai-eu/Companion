import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { nodeGroupMembers, nodeGroups, nodes } from "../db/schema";
import { logAuthEvent, reqMeta } from "../lib/auth-log";
import { decryptSecret, encryptSecret } from "../lib/secrets";
import { getOrchestratorPubkey, runSsh } from "../lib/ssh";
import { requireRole } from "../middleware/auth";

const adminNodesRoute = new Hono();

adminNodesRoute.use("*", requireRole("admin", "organiser"));

const createSchema = z.object({
  name: z.string().min(1).max(120),
  ip: z.string().min(1).max(255),
  sshUser: z.string().min(1).max(64).optional(),
  sshPassword: z.string().min(1).max(512).optional(),
  modelPath: z.string().min(1).max(512),
  groupIds: z.array(z.string().uuid()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  ip: z.string().min(1).max(255).optional(),
  sshUser: z.string().min(1).max(64).optional(),
  sshPassword: z.string().min(1).max(512).nullable().optional(),
  modelPath: z.string().min(1).max(512).optional(),
  status: z.string().min(1).max(32).optional(),
  groupIds: z.array(z.string().uuid()).optional(),
});

interface NodeRow {
  id: string;
  name: string;
  ip: string;
  sshUser: string;
  sshKeySetup: boolean;
  modelPath: string;
  status: string;
  lastSeenAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function publicNode(
  n: NodeRow,
  groups: Array<{ id: string; name: string }>,
) {
  return {
    id: n.id,
    name: n.name,
    ip: n.ip,
    sshUser: n.sshUser,
    sshKeySetup: n.sshKeySetup,
    modelPath: n.modelPath,
    status: n.status,
    lastSeenAt: n.lastSeenAt,
    lastError: n.lastError,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    groups,
  };
}

// GET /api/admin/nodes — list user's nodes with their groups
adminNodesRoute.get("/", async (c) => {
  const actor = c.get("user");
  const rows = await db
    .select({
      id: nodes.id,
      name: nodes.name,
      ip: nodes.ip,
      sshUser: nodes.sshUser,
      sshKeySetup: nodes.sshKeySetup,
      modelPath: nodes.modelPath,
      status: nodes.status,
      lastSeenAt: nodes.lastSeenAt,
      lastError: nodes.lastError,
      createdAt: nodes.createdAt,
      updatedAt: nodes.updatedAt,
    })
    .from(nodes)
    .where(eq(nodes.userId, actor.id))
    .orderBy(asc(nodes.name));

  if (rows.length === 0) {
    return c.json({ nodes: [] });
  }

  const memberships = await db
    .select({
      nodeId: nodeGroupMembers.nodeId,
      groupId: nodeGroups.id,
      groupName: nodeGroups.name,
    })
    .from(nodeGroupMembers)
    .innerJoin(nodeGroups, eq(nodeGroups.id, nodeGroupMembers.groupId))
    .where(
      inArray(
        nodeGroupMembers.nodeId,
        rows.map((r) => r.id),
      ),
    );

  const byNode = new Map<string, Array<{ id: string; name: string }>>();
  for (const m of memberships) {
    const list = byNode.get(m.nodeId) ?? [];
    list.push({ id: m.groupId, name: m.groupName });
    byNode.set(m.nodeId, list);
  }

  return c.json({
    nodes: rows.map((r) => publicNode(r, byNode.get(r.id) ?? [])),
  });
});

// POST /api/admin/nodes — create
adminNodesRoute.post("/", zValidator("json", createSchema), async (c) => {
  const body = c.req.valid("json");
  const actor = c.get("user");
  const meta = reqMeta(c);

  const encrypted = body.sshPassword
    ? encryptSecret(body.sshPassword)
    : null;

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(nodes)
      .values({
        userId: actor.id,
        name: body.name,
        ip: body.ip,
        sshUser: body.sshUser ?? "admin",
        sshPassword: encrypted,
        modelPath: body.modelPath,
      })
      .returning();

    if (body.groupIds && body.groupIds.length > 0) {
      const owned = await tx
        .select({ id: nodeGroups.id })
        .from(nodeGroups)
        .where(
          and(
            eq(nodeGroups.userId, actor.id),
            inArray(nodeGroups.id, body.groupIds),
          ),
        );
      if (owned.length > 0) {
        await tx.insert(nodeGroupMembers).values(
          owned.map((g) => ({ nodeId: row.id, groupId: g.id })),
        );
      }
    }
    return row;
  });

  logAuthEvent({
    userId: actor.id,
    event: "node.create",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { nodeId: created.id, name: created.name, ip: created.ip },
  });

  // Re-read with groups for the response
  const groupsRows = await db
    .select({ id: nodeGroups.id, name: nodeGroups.name })
    .from(nodeGroupMembers)
    .innerJoin(nodeGroups, eq(nodeGroups.id, nodeGroupMembers.groupId))
    .where(eq(nodeGroupMembers.nodeId, created.id));

  return c.json({ node: publicNode(created, groupsRows) }, 201);
});

// PATCH /api/admin/nodes/:id — update
adminNodesRoute.patch(
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

    try {
      const result = await db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(nodes)
          .where(and(eq(nodes.id, id), eq(nodes.userId, actor.id)))
          .limit(1);
        if (!target) throw new HttpError(404, "not_found");

        const set: Partial<typeof nodes.$inferInsert> = {};
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.ip !== undefined) set.ip = patch.ip;
        if (patch.sshUser !== undefined) set.sshUser = patch.sshUser;
        if (patch.modelPath !== undefined) set.modelPath = patch.modelPath;
        if (patch.status !== undefined) set.status = patch.status;
        if (patch.sshPassword !== undefined) {
          set.sshPassword =
            patch.sshPassword === null
              ? null
              : encryptSecret(patch.sshPassword);
        }
        set.updatedAt = new Date();

        const [row] = await tx
          .update(nodes)
          .set(set)
          .where(and(eq(nodes.id, id), eq(nodes.userId, actor.id)))
          .returning();

        if (patch.groupIds !== undefined) {
          await tx
            .delete(nodeGroupMembers)
            .where(eq(nodeGroupMembers.nodeId, id));
          if (patch.groupIds.length > 0) {
            const owned = await tx
              .select({ id: nodeGroups.id })
              .from(nodeGroups)
              .where(
                and(
                  eq(nodeGroups.userId, actor.id),
                  inArray(nodeGroups.id, patch.groupIds),
                ),
              );
            if (owned.length > 0) {
              await tx.insert(nodeGroupMembers).values(
                owned.map((g) => ({ nodeId: id, groupId: g.id })),
              );
            }
          }
        }

        return row;
      });

      const groupsRows = await db
        .select({ id: nodeGroups.id, name: nodeGroups.name })
        .from(nodeGroupMembers)
        .innerJoin(nodeGroups, eq(nodeGroups.id, nodeGroupMembers.groupId))
        .where(eq(nodeGroupMembers.nodeId, id));

      logAuthEvent({
        userId: actor.id,
        event: "node.update",
        ip: meta.ip,
        userAgent: meta.userAgent,
        meta: { nodeId: id, fields: Object.keys(patch) },
      });

      return c.json({ node: publicNode(result, groupsRows) });
    } catch (err) {
      if (err instanceof HttpError) {
        return c.json({ error: err.code }, err.status as 400 | 404);
      }
      throw err;
    }
  },
);

// DELETE /api/admin/nodes/:id — hard delete
adminNodesRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  const meta = reqMeta(c);

  const deleted = await db
    .delete(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.userId, actor.id)))
    .returning({ id: nodes.id });

  if (deleted.length === 0) {
    return c.json({ error: "not_found" }, 404);
  }

  logAuthEvent({
    userId: actor.id,
    event: "node.delete",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { nodeId: id },
  });
  return c.body(null, 204);
});

// POST /api/admin/nodes/:id/ssh-setup — bootstrap orchestrator's SSH key on remote
adminNodesRoute.post("/:id/ssh-setup", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  const meta = reqMeta(c);

  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.userId, actor.id)))
    .limit(1);
  if (!node) return c.json({ error: "not_found" }, 404);

  if (node.sshKeySetup) {
    return c.json({ error: "already_setup" }, 400);
  }
  if (!node.sshPassword) {
    return c.json({ error: "no_password" }, 400);
  }

  let password: string;
  try {
    password = decryptSecret(node.sshPassword);
  } catch (err) {
    return c.json(
      { error: "decrypt_failed", detail: (err as Error).message },
      500,
    );
  }

  let pubkey: string;
  try {
    pubkey = await getOrchestratorPubkey();
  } catch (err) {
    return c.json(
      { error: "pubkey_unavailable", detail: (err as Error).message },
      500,
    );
  }

  // Base64-encode the pubkey to avoid quoting issues on the remote.
  const pubkeyB64 = Buffer.from(pubkey + "\n", "utf8").toString("base64");
  const installCmd =
    `umask 077 && mkdir -p ~/.ssh && chmod 700 ~/.ssh && ` +
    `KEY="$(echo ${pubkeyB64} | base64 -d)" && ` +
    `touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && ` +
    `grep -qF "$KEY" ~/.ssh/authorized_keys || printf '%s' "$KEY" >> ~/.ssh/authorized_keys`;

  let installResult;
  try {
    installResult = await runSsh(node, installCmd, {
      usePassword: true,
      password,
    });
  } catch (err) {
    logAuthEvent({
      userId: actor.id,
      event: "node.ssh.setup",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { nodeId: id, ok: false, error: (err as Error).message },
    });
    return c.json(
      { error: "ssh_install_failed", detail: (err as Error).message },
      500,
    );
  }

  if (installResult.code !== 0) {
    await db
      .update(nodes)
      .set({
        lastError: installResult.stderr.slice(-2000),
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id));
    logAuthEvent({
      userId: actor.id,
      event: "node.ssh.setup",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { nodeId: id, ok: false, code: installResult.code },
    });
    return c.json(
      {
        error: "ssh_install_failed",
        code: installResult.code,
        stderr: installResult.stderr,
      },
      500,
    );
  }

  // Verify with key-based auth
  const verify = await runSsh(node, "echo ok", {});
  if (verify.code !== 0 || verify.stdout.trim() !== "ok") {
    await db
      .update(nodes)
      .set({
        lastError: (verify.stderr || verify.stdout).slice(-2000),
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id));
    logAuthEvent({
      userId: actor.id,
      event: "node.ssh.setup",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { nodeId: id, ok: false, phase: "verify" },
    });
    return c.json(
      {
        error: "ssh_verify_failed",
        code: verify.code,
        stdout: verify.stdout,
        stderr: verify.stderr,
      },
      500,
    );
  }

  await db
    .update(nodes)
    .set({
      sshKeySetup: true,
      sshPassword: null,
      status: "online",
      lastSeenAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id));

  logAuthEvent({
    userId: actor.id,
    event: "node.ssh.setup",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { nodeId: id, ok: true },
  });

  return c.json({ ok: true });
});

// POST /api/admin/nodes/:id/probe — quick liveness check
adminNodesRoute.post("/:id/probe", async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  const meta = reqMeta(c);

  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.userId, actor.id)))
    .limit(1);
  if (!node) return c.json({ error: "not_found" }, 404);

  const cmd = "hostname; uname -srm; df -h ~ | tail -1; sw_vers -productVersion 2>/dev/null || true";

  let result;
  try {
    if (node.sshKeySetup) {
      result = await runSsh(node, cmd, {});
    } else if (node.sshPassword) {
      const password = decryptSecret(node.sshPassword);
      result = await runSsh(node, cmd, { usePassword: true, password });
    } else {
      return c.json({ error: "no_credentials" }, 400);
    }
  } catch (err) {
    const msg = (err as Error).message;
    const now = new Date();
    await db
      .update(nodes)
      .set({ status: "offline", lastError: msg, updatedAt: now })
      .where(eq(nodes.id, id));
    logAuthEvent({
      userId: actor.id,
      event: "node.probe",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { nodeId: id, ok: false, error: msg },
    });
    return c.json({ ok: false, error: msg, status: "offline" }, 200);
  }

  const ok = result.code === 0;
  const now = new Date();
  const status = ok ? "online" : "offline";
  await db
    .update(nodes)
    .set({
      status,
      lastSeenAt: ok ? now : node.lastSeenAt,
      lastError: ok ? null : (result.stderr || result.stdout).slice(-2000),
      updatedAt: now,
    })
    .where(eq(nodes.id, id));

  logAuthEvent({
    userId: actor.id,
    event: "node.probe",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { nodeId: id, ok, code: result.code },
  });

  return c.json({
    ok,
    output: result.stdout,
    stderr: result.stderr,
    code: result.code,
    status,
    lastSeenAt: ok ? now : node.lastSeenAt,
  });
});

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

// Touch sql import to satisfy linter when not used (kept for future filters).
void sql;

export default adminNodesRoute;
