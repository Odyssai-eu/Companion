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
  if (eps.length === 0) return c.json({ models: [] });

  const headers: Record<string, string> = {};
  if (server.authBearer)
    headers.Authorization = `Bearer ${server.authBearer}`;

  const models = await listModelsForServer(eps, headers, server.engineKind);
  return c.json({ models });
});

type ModelEntry = {
  id: string;
  name: string;
  loaded: boolean;
  endpoints: string[];
};

/**
 * Merge model availability across a server's endpoints. Exoscopy pattern:
 *   - For exo, fetch `/state` per endpoint → placed (loaded) modelIds
 *   - Also fetch `/v1/models?status=downloaded` → downloaded but not loaded (registered)
 *   - For OpenAI-compat cloud (OpenRouter, Anthropic-compat), primary endpoint
 *     is enough; hit /v1/models directly
 * Duplicates across endpoints are merged (same modelId surfaced once with the
 * list of endpoints that carry it). `name` is the model id without the `maker/`
 * prefix so the UI doesn't have to parse it.
 */
async function listModelsForServer(
  eps: Endpoint[],
  headers: Record<string, string>,
  engineKind: string,
): Promise<ModelEntry[]> {
  if (engineKind === "anthropic") {
    // Anthropic-style: primary endpoint only, /v1/models
    const primary = eps.find((e) => e.role === "primary") ?? eps[0];
    const base = `http://${primary.ip}:${primary.port}`;
    const res = await fetch(`${base}/v1/models`, { headers }).catch(() => null);
    if (!res || !res.ok) return [];
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => !!id)
      .map<ModelEntry>((id) => ({
        id,
        name: stripMakerPrefix(id),
        loaded: true,
        endpoints: [primary.node ?? primary.ip],
      }));
  }

  // OpenAI-compat path — merge across every endpoint in parallel.
  const perEndpoint = await Promise.all(
    eps.map((ep) => fetchEndpointModels(ep, headers)),
  );

  const merged = new Map<string, ModelEntry>();
  for (const { endpointLabel, loaded, downloaded } of perEndpoint) {
    for (const id of loaded) {
      const existing = merged.get(id);
      if (existing) {
        existing.loaded = true;
        if (!existing.endpoints.includes(endpointLabel))
          existing.endpoints.push(endpointLabel);
      } else {
        merged.set(id, {
          id,
          name: stripMakerPrefix(id),
          loaded: true,
          endpoints: [endpointLabel],
        });
      }
    }
    for (const id of downloaded) {
      if (merged.has(id)) continue;
      merged.set(id, {
        id,
        name: stripMakerPrefix(id),
        loaded: false,
        endpoints: [endpointLabel],
      });
    }
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function fetchEndpointModels(
  ep: Endpoint,
  headers: Record<string, string>,
): Promise<{
  endpointLabel: string;
  loaded: string[];
  downloaded: string[];
}> {
  const base = `http://${ep.ip}:${ep.port}`;
  const label = ep.node ?? ep.ip;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);

  try {
    const [stateRes, downloadedRes] = await Promise.all([
      fetch(`${base}/state`, { headers, signal: controller.signal }).catch(
        () => null,
      ),
      fetch(`${base}/v1/models?status=downloaded`, {
        headers,
        signal: controller.signal,
      }).catch(() => null),
    ]);

    const loaded: string[] = [];
    if (stateRes?.ok) {
      const state = (await stateRes.json()) as {
        instances?: Record<
          string,
          {
            MlxJacclInstance?: { shardAssignments?: { modelId?: string } };
            MlxInstance?: { shardAssignments?: { modelId?: string } };
          }
        >;
      };
      for (const inst of Object.values(state.instances ?? {})) {
        const inner = inst.MlxJacclInstance ?? inst.MlxInstance;
        const modelId = inner?.shardAssignments?.modelId;
        if (modelId && !loaded.includes(modelId)) loaded.push(modelId);
      }
    }

    const downloaded: string[] = [];
    if (downloadedRes?.ok) {
      const body = (await downloadedRes.json()) as {
        data?: { id?: string }[];
      };
      for (const m of body.data ?? []) {
        if (m.id && !downloaded.includes(m.id)) downloaded.push(m.id);
      }
    }

    // Fallback for non-exo OpenAI-compat: /v1/models without the filter
    if (loaded.length === 0 && downloaded.length === 0) {
      const plain = await fetch(`${base}/v1/models`, {
        headers,
        signal: controller.signal,
      }).catch(() => null);
      if (plain?.ok) {
        const body = (await plain.json()) as { data?: { id?: string }[] };
        for (const m of body.data ?? []) {
          if (m.id) loaded.push(m.id); // assume served = loaded for cloud
        }
      }
    }

    return { endpointLabel: label, loaded, downloaded };
  } finally {
    clearTimeout(timer);
  }
}

function stripMakerPrefix(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
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
