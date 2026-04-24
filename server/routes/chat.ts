import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { endpoints, servers, users } from "../db/schema";

const chatRoute = new Hono();

async function currentUserId() {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);
  if (!row) throw new Error("No user seeded yet");
  return row.id;
}

chatRoute.post("/completions", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_json" }, 400);
  }
  const { serverId, messages, model, temperature, max_tokens } = body as {
    serverId?: string;
    messages?: unknown;
    model?: string;
    temperature?: number;
    max_tokens?: number;
  };
  if (!serverId || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "missing_serverId_or_messages" }, 400);
  }

  const userId = await currentUserId();
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (!server || server.userId !== userId) {
    return c.json({ error: "server_not_found" }, 404);
  }
  const eps = await db
    .select()
    .from(endpoints)
    .where(eq(endpoints.serverId, serverId))
    .orderBy(asc(endpoints.createdAt));
  const primary = eps.find((e) => e.role === "primary") ?? eps[0];
  if (!primary) {
    return c.json({ error: "no_endpoint" }, 400);
  }

  const target = `http://${primary.ip}:${primary.port}/v1/chat/completions`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model ?? "auto",
        messages,
        stream: true,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(max_tokens !== undefined ? { max_tokens } : {}),
      }),
    });
  } catch (err) {
    return c.json(
      { error: "upstream_unreachable", detail: String(err) },
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return c.json(
      { error: "upstream_error", status: upstream.status, body: text },
      upstream.status as 400 | 401 | 403 | 404 | 500 | 502,
    );
  }

  c.header(
    "Content-Type",
    upstream.headers.get("content-type") ?? "text/event-stream",
  );
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return c.body(upstream.body);
});

export default chatRoute;
