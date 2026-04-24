import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { endpoints, servers, users } from "../db/schema";
import type { Endpoint } from "../db/schema";

const serversRoute = new Hono();

const createServerSchema = z.object({
  name: z.string().min(1).max(120),
  ip: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  hint: z.string().max(120).optional(),
  description: z.string().max(1000).optional(),
});

const createEndpointSchema = z.object({
  label: z.string().min(1).max(120),
  role: z.enum(["primary", "secondary"]),
  node: z.string().max(60).optional(),
  ip: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
});

async function currentUserId() {
  // Stub until auth lands: every call resolves to the seeded `sophie` user.
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!row) throw new Error("No user seeded yet");
  return row.id;
}

serversRoute.get("/", async (c) => {
  const userId = await currentUserId();
  const rows = await db
    .select()
    .from(servers)
    .where(eq(servers.userId, userId))
    .orderBy(asc(servers.createdAt));
  return c.json({ servers: rows });
});

serversRoute.post("/", zValidator("json", createServerSchema), async (c) => {
  const userId = await currentUserId();
  const { name, ip, port, hint, description } = c.req.valid("json");

  const url = `http://${ip}:${port}`;

  const [server] = await db
    .insert(servers)
    .values({ userId, name, url, hint, description })
    .returning();

  const [endpoint] = await db
    .insert(endpoints)
    .values({
      serverId: server.id,
      label: "Primary",
      role: "primary",
      ip,
      port,
    })
    .returning();

  return c.json({ server, endpoint }, 201);
});

serversRoute.get("/:id", async (c) => {
  const userId = await currentUserId();
  const id = c.req.param("id");
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  if (!server || server.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const eps = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.serverId, id))
    .orderBy(asc(endpoints.createdAt));
  return c.json({ server, endpoints: eps });
});

const updateServerSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  hint: z.string().max(120).nullish(),
  description: z.string().max(1000).nullish(),
  authBearer: z.string().max(500).nullish(),
  engineKind: z.enum(["openai-compat", "anthropic"]).optional(),
});

serversRoute.patch(
  "/:id",
  zValidator("json", updateServerSchema),
  async (c) => {
    const userId = await currentUserId();
    const id = c.req.param("id");
    const [existing] = await db
      .select({ userId: servers.userId })
      .from(servers)
      .where(eq(servers.id, id))
      .limit(1);
    if (!existing || existing.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }
    const data = c.req.valid("json");
    const updates: Partial<typeof servers.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (data.name !== undefined) updates.name = data.name;
    if (data.hint !== undefined) updates.hint = data.hint ?? null;
    if (data.description !== undefined)
      updates.description = data.description ?? null;
    if (data.authBearer !== undefined)
      updates.authBearer = data.authBearer ?? null;
    if (data.engineKind !== undefined) updates.engineKind = data.engineKind;

    const [updated] = await db
      .update(servers)
      .set(updates)
      .where(eq(servers.id, id))
      .returning();
    return c.json({ server: updated });
  },
);

serversRoute.delete("/:id", async (c) => {
  const userId = await currentUserId();
  const id = c.req.param("id");
  const result = await db
    .delete(servers)
    .where(eq(servers.id, id))
    .returning({ id: servers.id, userId: servers.userId });
  const row = result[0];
  if (!row || row.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  return c.body(null, 204);
});

serversRoute.post(
  "/:id/endpoints",
  zValidator("json", createEndpointSchema),
  async (c) => {
    const userId = await currentUserId();
    const id = c.req.param("id");
    const [server] = await db
      .select({ id: servers.id, userId: servers.userId })
      .from(servers)
      .where(eq(servers.id, id))
      .limit(1);
    if (!server || server.userId !== userId) {
      return c.json({ error: "not_found" }, 404);
    }
    const data = c.req.valid("json");
    const [row] = await db
      .insert(endpoints)
      .values({ ...data, serverId: id })
      .returning();
    return c.json({ endpoint: row }, 201);
  },
);

async function pingEndpoint(
  ep: Endpoint,
): Promise<{ healthy: boolean; latencyMs: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const start = Date.now();
  try {
    const res = await fetch(`http://${ep.ip}:${ep.port}/`, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    return { healthy: res.status < 500, latencyMs: Date.now() - start };
  } catch {
    return { healthy: false, latencyMs: null };
  } finally {
    clearTimeout(timer);
  }
}

async function pingAndUpdate(ep: Endpoint) {
  const result = await pingEndpoint(ep);
  const [updated] = await db
    .update(endpoints)
    .set(result)
    .where(eq(endpoints.id, ep.id))
    .returning();
  return updated;
}

serversRoute.post("/:id/test", async (c) => {
  const userId = await currentUserId();
  const id = c.req.param("id");
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  if (!server || server.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const eps = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.serverId, id))
    .orderBy(asc(endpoints.createdAt));
  const updated = await Promise.all(eps.map(pingAndUpdate));
  return c.json({ endpoints: updated });
});

serversRoute.get("/:id/models", async (c) => {
  const userId = await currentUserId();
  const id = c.req.param("id");
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, id))
    .limit(1);
  if (!server || server.userId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const eps = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.serverId, id))
    .orderBy(asc(endpoints.createdAt));
  const primary = eps.find((e) => e.role === "primary") ?? eps[0];
  if (!primary) {
    return c.json({ models: [] });
  }
  const base = `http://${primary.ip}:${primary.port}`;
  const headers: Record<string, string> = {};
  if (server.authBearer)
    headers.Authorization = `Bearer ${server.authBearer}`;

  try {
    const models = await listModels(base, headers, server.engineKind);
    return c.json({ models });
  } catch (err) {
    return c.json(
      { models: [], error: String(err) },
      200,
    );
  }
});

async function listModels(
  base: string,
  headers: Record<string, string>,
  engineKind: string,
): Promise<{ id: string; loaded: boolean }[]> {
  if (engineKind === "anthropic") {
    const res = await fetch(`${base}/v1/models`, { headers });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      .map((id) => ({ id, loaded: true }));
  }

  // OpenAI-compat (exo, Ollama, LM Studio, OpenRouter, vLLM)
  const placedFromState = await fetchExoPlacedModels(base, headers);
  const placedSet = new Set(placedFromState);

  try {
    const res = await fetch(`${base}/v1/models`, { headers });
    if (!res.ok) {
      return placedFromState.map((id) => ({ id, loaded: true }));
    }
    const body = (await res.json()) as { data?: { id?: string }[] };
    const ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string");
    // If we have placed info, mark loaded accordingly; else assume all loaded.
    if (placedFromState.length > 0) {
      const merged = Array.from(new Set([...placedFromState, ...ids]));
      return merged.map((id) => ({ id, loaded: placedSet.has(id) }));
    }
    return ids.map((id) => ({ id, loaded: true }));
  } catch {
    return placedFromState.map((id) => ({ id, loaded: true }));
  }
}

async function fetchExoPlacedModels(
  base: string,
  headers: Record<string, string>,
): Promise<string[]> {
  try {
    const res = await fetch(`${base}/state`, { headers });
    if (!res.ok) return [];
    const state = (await res.json()) as {
      instances?: Record<
        string,
        {
          MlxJacclInstance?: {
            shardAssignments?: { modelId?: string };
          };
        }
      >;
    };
    return Object.values(state.instances ?? {})
      .map((i) => i.MlxJacclInstance?.shardAssignments?.modelId)
      .filter((m): m is string => typeof m === "string" && m.length > 0);
  } catch {
    return [];
  }
}

serversRoute.post("/:id/endpoints/:eid/test", async (c) => {
  const userId = await currentUserId();
  const id = c.req.param("id");
  const eid = c.req.param("eid");
  const [row] = await db
    .select({
      ep: endpoints,
      serverUserId: servers.userId,
    })
    .from(endpoints)
    .innerJoin(servers, eq(endpoints.serverId, servers.id))
    .where(eq(endpoints.id, eid))
    .limit(1);
  if (!row || row.ep.serverId !== id || row.serverUserId !== userId) {
    return c.json({ error: "not_found" }, 404);
  }
  const updated = await pingAndUpdate(row.ep);
  return c.json({ endpoint: updated });
});

export default serversRoute;
