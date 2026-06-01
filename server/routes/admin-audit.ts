/**
 * Admin audit log — enterprise-grade access log for DPO/compliance.
 *
 * GET /api/admin/audit   list recent entries (admin only), filterable
 * GET /api/admin/audit/export.csv   CSV export for DPO
 */
import { and, desc, gte, lte, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { authLog } from "../db/schema";
import { requireRole } from "../middleware/auth";

const auditRoute = new Hono();
auditRoute.use("*", requireRole("admin"));

// ── GET /api/admin/audit ──────────────────────────────────────────────────

auditRoute.get("/", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
  const offset = Number(c.req.query("offset") ?? "0");
  const userId = c.req.query("userId");
  const event = c.req.query("event");
  const resourceType = c.req.query("resourceType");
  const from = c.req.query("from");
  const to = c.req.query("to");

  const conditions = [];
  if (userId) conditions.push(eq(authLog.userId, userId));
  if (event) conditions.push(eq(authLog.event, event));
  if (resourceType) conditions.push(eq(authLog.resourceType, resourceType));
  if (from) conditions.push(gte(authLog.createdAt, new Date(from)));
  if (to) conditions.push(lte(authLog.createdAt, new Date(to)));

  const rows = await db
    .select({
      id: authLog.id,
      userId: authLog.userId,
      event: authLog.event,
      ip: authLog.ip,
      projectId: authLog.projectId,
      resourceType: authLog.resourceType,
      resourceId: authLog.resourceId,
      meta: authLog.meta,
      createdAt: authLog.createdAt,
    })
    .from(authLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(authLog.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ entries: rows, limit, offset });
});

// ── GET /api/admin/audit/export.csv ──────────────────────────────────────

auditRoute.get("/export.csv", async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");

  const conditions = [];
  if (from) conditions.push(gte(authLog.createdAt, new Date(from)));
  if (to) conditions.push(lte(authLog.createdAt, new Date(to)));

  const rows = await db
    .select()
    .from(authLog)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(authLog.createdAt))
    .limit(10_000);

  const header = "id,user_id,event,ip,project_id,resource_type,resource_id,created_at\n";
  const body = rows.map((r) =>
    [
      r.id,
      r.userId ?? "",
      r.event,
      r.ip ?? "",
      r.projectId ?? "",
      r.resourceType ?? "",
      r.resourceId ?? "",
      r.createdAt.toISOString(),
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(","),
  ).join("\n");

  const date = new Date().toISOString().slice(0, 10);
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="audit-${date}.csv"`);
  return c.body(header + body);
});

export default auditRoute;
