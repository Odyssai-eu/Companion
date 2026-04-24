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
