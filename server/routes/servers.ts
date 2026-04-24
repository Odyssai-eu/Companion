import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { endpoints, servers, users } from "../db/schema";

const serversRoute = new Hono();

const createServerSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
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
  const data = c.req.valid("json");
  const [row] = await db
    .insert(servers)
    .values({ ...data, userId })
    .returning();
  return c.json({ server: row }, 201);
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

export default serversRoute;
