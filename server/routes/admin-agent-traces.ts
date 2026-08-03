// Admin agent traces (v2.0 δ) — aggregates + recent task spans from
// agent_spans. Read-only observability; the Trace panel in chat reads
// the sub-conversation messages, this page reads the telemetry
// (30-day window — the purge job trims beyond that).

import { Hono } from "hono";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { agentSpans, conversations, users } from "../db/schema";

type Env = { Variables: { userId: string } };

const r = new Hono<Env>();

async function requireAdminish(userId: string): Promise<boolean> {
  const [u] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u?.role === "admin" || u?.role === "organiser";
}

r.get("/", async (c) => {
  const userId = c.get("userId");
  if (!(await requireAdminish(userId))) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Per-agent aggregates over the retention window.
  const byAgent = await db
    .select({
      agent: agentSpans.agent,
      type: agentSpans.type,
      count: sql<number>`count(*)::int`,
      tokensIn: sql<number>`coalesce(sum(${agentSpans.tokensIn}), 0)::int`,
      tokensOut: sql<number>`coalesce(sum(${agentSpans.tokensOut}), 0)::int`,
      avgDurationMs: sql<number>`coalesce(avg(${agentSpans.durationMs}), 0)::int`,
      errors: sql<number>`count(*) filter (where ${agentSpans.status} not in ('ok', 'done'))::int`,
    })
    .from(agentSpans)
    .groupBy(agentSpans.agent, agentSpans.type)
    .orderBy(agentSpans.agent, agentSpans.type);

  // Recent task spans with their parent conversation title.
  const recentTasks = await db
    .select({
      spanId: agentSpans.spanId,
      agent: agentSpans.agent,
      status: agentSpans.status,
      tokensIn: agentSpans.tokensIn,
      tokensOut: agentSpans.tokensOut,
      durationMs: agentSpans.durationMs,
      payload: agentSpans.payload,
      createdAt: agentSpans.createdAt,
      conversationId: agentSpans.conversationId,
      conversationTitle: conversations.title,
    })
    .from(agentSpans)
    .leftJoin(conversations, eq(conversations.id, agentSpans.conversationId))
    .where(eq(agentSpans.type, "task"))
    .orderBy(desc(agentSpans.createdAt))
    .limit(50);

  return c.json({ byAgent, recentTasks });
});

export default r;
