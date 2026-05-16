/**
 * MCP servers CRUD — Settings → Extensions → "MCP servers".
 *
 *   GET    /api/mcp-servers         → list (user-scoped)
 *   POST   /api/mcp-servers         → register a new server
 *   PATCH  /api/mcp-servers/:id     → edit fields
 *   DELETE /api/mcp-servers/:id     → remove
 *   POST   /api/mcp-servers/:id/refresh → force re-fetch tools/list
 *   POST   /api/mcp-servers/:id/test    → live ping (tools/list, no persist)
 *
 * The slug is auto-derived from the name on create if not provided.
 * Slugs are lowercased ascii without underscores so the
 * `mcp_<slug>_<tool>` tool-name convention can be parsed unambiguously
 * by splitting on the first underscore (see parseMcpToolName).
 */

import { and, asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { mcpServers } from "../db/schema";
import { fetchTools as fetchMcpTools } from "../lib/mcp-client";

type Env = { Variables: { userId: string } };
const mcpServersRoute = new Hono<Env>();

const slugRegex = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(slugRegex).optional(),
  transport: z.enum(["streamable_http", "sse"]),
  url: z.string().url().max(500),
  authHeader: z.string().max(2000).nullable().optional(),
  enabled: z.boolean().optional(),
});

const updateSchema = createSchema
  .partial()
  // Don't let users mutate the slug post-create — that would orphan
  // any tool-name reference the LLM is mid-emitting. Re-create if
  // they really want a new slug.
  .omit({ slug: true });

mcpServersRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.userId, userId))
    .orderBy(asc(mcpServers.name));
  // Mask the auth header in the list response — we only need to tell
  // the UI whether one is set, not its value.
  return c.json({
    servers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      transport: r.transport,
      url: r.url,
      hasAuthHeader: Boolean(r.authHeader),
      enabled: r.enabled,
      toolsCount: Array.isArray(r.toolsCache) ? r.toolsCache.length : 0,
      toolsCacheAt: r.toolsCacheAt,
      lastError: r.lastError,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
});

mcpServersRoute.post("/", zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const slug = data.slug ?? slugify(data.name);
  if (!slug || !slugRegex.test(slug)) {
    return c.json({ error: "invalid_slug", detail: "Slug must be lowercase ascii letters/digits and dashes." }, 400);
  }
  try {
    const [row] = await db
      .insert(mcpServers)
      .values({
        userId,
        name: data.name,
        slug,
        transport: data.transport,
        url: data.url,
        authHeader: data.authHeader ?? null,
        enabled: data.enabled ?? true,
      })
      .returning();
    return c.json({ server: { ...row, authHeader: undefined, hasAuthHeader: Boolean(row.authHeader) } });
  } catch (e) {
    // Unique constraint on (user_id, slug)
    if (/unique/i.test((e as Error).message)) {
      return c.json({ error: "slug_taken" }, 409);
    }
    throw e;
  }
});

mcpServersRoute.patch(
  "/:id",
  zValidator("json", updateSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const data = c.req.valid("json");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) patch.name = data.name;
    if (data.transport !== undefined) patch.transport = data.transport;
    if (data.url !== undefined) patch.url = data.url;
    if (data.authHeader !== undefined) patch.authHeader = data.authHeader ?? null;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    // Bust the cache when the URL or transport changes — a different
    // backend means the cached tools list is meaningless.
    if (data.url !== undefined || data.transport !== undefined) {
      patch.toolsCache = null;
      patch.toolsCacheAt = null;
      patch.lastError = null;
    }
    const [row] = await db
      .update(mcpServers)
      .set(patch)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ server: { ...row, authHeader: undefined, hasAuthHeader: Boolean(row.authHeader) } });
  },
);

mcpServersRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const r = await db
    .delete(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
    .returning({ id: mcpServers.id });
  if (r.length === 0) return c.json({ error: "not_found" }, 404);
  return c.body(null, 204);
});

/**
 * Refresh — fetches tools/list synchronously, persists. Returns the
 * fresh tools list so the UI can render counts/names immediately. On
 * failure, persists last_error and returns 502 with the message — the
 * cached entries (if any) stay intact so the chat path keeps working.
 */
mcpServersRoute.post("/:id/refresh", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
    .limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  try {
    const tools = await fetchMcpTools(row);
    await db
      .update(mcpServers)
      .set({ toolsCache: tools, toolsCacheAt: new Date(), lastError: null })
      .where(eq(mcpServers.id, id));
    return c.json({ ok: true, tools });
  } catch (e) {
    await db
      .update(mcpServers)
      .set({ lastError: (e as Error).message })
      .where(eq(mcpServers.id, id));
    return c.json({ error: "refresh_failed", detail: (e as Error).message }, 502);
  }
});

/**
 * Test — live probe without persisting. Used by the "Test connection"
 * button in the create/edit form, before the user has committed the
 * row. Body: full create payload.
 */
mcpServersRoute.post(
  "/test",
  zValidator("json", createSchema),
  async (c) => {
    const data = c.req.valid("json");
    try {
      const tools = await fetchMcpTools({
        id: "test",
        userId: "test",
        name: data.name,
        slug: data.slug ?? slugify(data.name),
        transport: data.transport,
        url: data.url,
        authKind: "bearer",
        authHeader: data.authHeader ?? null,
        oauthMetadata: null,
        oauthClientId: null,
        oauthClientSecret: null,
        oauthAccessToken: null,
        oauthRefreshToken: null,
        oauthExpiresAt: null,
        oauthScopes: null,
        enabled: true,
        toolsCache: null,
        toolsCacheAt: null,
        lastError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return c.json({ ok: true, toolsCount: tools.length, tools: tools.slice(0, 50) });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 200);
    }
  },
);

export default mcpServersRoute;
