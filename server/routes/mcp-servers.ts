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

import { and, asc, eq, lt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { mcpOauthPending, mcpServers } from "../db/schema";
import { fetchTools as fetchMcpTools } from "../lib/mcp-client";
import {
  buildAuthorizationUrl,
  discoverMetadata,
  exchangeCode,
  generatePkce,
  generateState,
  registerClient,
  type AuthServerMetadata,
} from "../lib/mcp-oauth";

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
  authKind: z.enum(["bearer", "oauth", "none"]).optional(),
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
      authKind: r.authKind,
      hasAuthHeader: Boolean(r.authHeader),
      oauthConnected: Boolean(r.oauthAccessToken),
      oauthExpiresAt: r.oauthExpiresAt,
      oauthScopes: r.oauthScopes,
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
        authKind: data.authKind ?? "bearer",
        authHeader: data.authHeader ?? null,
        enabled: data.enabled ?? true,
      })
      .returning();
    return c.json({
      server: {
        ...row,
        authHeader: undefined,
        oauthAccessToken: undefined,
        oauthRefreshToken: undefined,
        oauthClientSecret: undefined,
        hasAuthHeader: Boolean(row.authHeader),
        oauthConnected: Boolean(row.oauthAccessToken),
      },
    });
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
    if (data.authKind !== undefined) patch.authKind = data.authKind;
    if (data.authHeader !== undefined) patch.authHeader = data.authHeader ?? null;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    // Bust the cache when the URL/transport/auth kind changes — a
    // different backend OR a different auth model means the cached
    // tools list is meaningless. Also clear OAuth credentials when the
    // URL changes (they only make sense paired with the URL).
    if (data.url !== undefined || data.transport !== undefined) {
      patch.toolsCache = null;
      patch.toolsCacheAt = null;
      patch.lastError = null;
      patch.oauthMetadata = null;
      patch.oauthClientId = null;
      patch.oauthClientSecret = null;
      patch.oauthAccessToken = null;
      patch.oauthRefreshToken = null;
      patch.oauthExpiresAt = null;
      patch.oauthScopes = null;
    }
    const [row] = await db
      .update(mcpServers)
      .set(patch)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
      .returning();
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({
      server: {
        ...row,
        authHeader: undefined,
        oauthAccessToken: undefined,
        oauthRefreshToken: undefined,
        oauthClientSecret: undefined,
        hasAuthHeader: Boolean(row.authHeader),
        oauthConnected: Boolean(row.oauthAccessToken),
      },
    });
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

// ── OAuth flow ──────────────────────────────────────────────────────────

/**
 * The redirect URI Notion (and any OAuth provider we register against)
 * needs to know. Must be reachable from the user's browser — so it's
 * the public URL of Companion, not the internal Docker hostname.
 *
 * Derived once at request time from the X-Forwarded-* headers + Host,
 * with a process.env override for non-proxied dev setups.
 */
function buildRedirectUri(c: {
  req: { header: (name: string) => string | undefined; url: string };
}): string {
  // The path lives on a separate public mount (no auth gate) — see
  // server/index.ts. The auth server's browser redirect arrives
  // without a session cookie, so /api/mcp-servers/* would 401 it.
  const override = process.env.PUBLIC_BASE_URL;
  if (override) return `${override.replace(/\/+$/, "")}/api/mcp-oauth/callback`;
  const host = c.req.header("x-forwarded-host") || c.req.header("host") || "localhost:3001";
  const proto = c.req.header("x-forwarded-proto") || "http";
  return `${proto}://${host}/api/mcp-oauth/callback`;
}

/**
 * Start the OAuth flow: discover → register client (DCR) → mint PKCE
 * + state → persist pending row → return authorization URL for the
 * frontend to open in a popup.
 */
mcpServersRoute.post("/:id/oauth/start", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
    .limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);

  // Garbage-collect stale pending rows for this server (10-min TTL)
  // before creating a new one — otherwise the table grows on every
  // abandoned attempt.
  await db
    .delete(mcpOauthPending)
    .where(
      and(
        eq(mcpOauthPending.serverId, id),
        lt(mcpOauthPending.createdAt, new Date(Date.now() - 10 * 60 * 1000)),
      ),
    );

  const redirectUri = buildRedirectUri(c);

  try {
    // 1. Discover the auth server metadata (cached on the row for
    //    later refresh calls — saves a round-trip).
    const metadata =
      (row.oauthMetadata as AuthServerMetadata | null) ??
      (await discoverMetadata(row.url));

    // 2. Register a client if we don't have one yet for this server.
    //    Re-use across attempts — registered clients can be re-used
    //    forever per RFC 7591.
    let clientId = row.oauthClientId;
    let clientSecret = row.oauthClientSecret;
    if (!clientId) {
      const reg = await registerClient(metadata, redirectUri);
      clientId = reg.clientId;
      clientSecret = reg.clientSecret;
    }

    // 3. Mint PKCE + state.
    const { codeVerifier, codeChallenge } = generatePkce();
    const state = generateState();

    // 4. Persist pending row + cache metadata/client on the server row.
    await db.insert(mcpOauthPending).values({
      userId,
      serverId: id,
      state,
      codeVerifier,
      redirectUri,
      scopes: metadata.scopes_supported ?? null,
    });
    await db
      .update(mcpServers)
      .set({
        authKind: "oauth",
        oauthMetadata: metadata as unknown as Record<string, unknown>,
        oauthClientId: clientId,
        oauthClientSecret: clientSecret,
      })
      .where(eq(mcpServers.id, id));

    // 5. Return the URL — frontend opens this in a popup.
    const authorizationUrl = buildAuthorizationUrl({
      metadata,
      clientId,
      redirectUri,
      codeChallenge,
      state,
      scopes: metadata.scopes_supported,
    });

    return c.json({ authorizationUrl, state });
  } catch (e) {
    return c.json(
      { error: "oauth_start_failed", detail: (e as Error).message },
      502,
    );
  }
});

/**
 * Callback handler factory — used by the public mount at
 * /api/mcp-oauth/callback (see server/index.ts). We don't require an
 * authenticated session here — the `state` is the trust anchor
 * (single-use, server-side, time-limited).
 *
 * Exported and mounted separately rather than under /api/mcp-servers/*
 * because Notion's redirect lands here as a cross-origin top-level
 * navigation without our session cookie; the auth gate on
 * /api/mcp-servers/* would 401 it before we can read the state.
 */
export const handleOauthCallback = async (c: Context) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");

  if (error) {
    return c.html(callbackHtml({ ok: false, message: `${error}: ${errorDescription ?? ""}` }));
  }
  if (!code || !state) {
    return c.html(callbackHtml({ ok: false, message: "Missing code or state" }));
  }

  const [pending] = await db
    .select()
    .from(mcpOauthPending)
    .where(eq(mcpOauthPending.state, state))
    .limit(1);
  if (!pending) {
    return c.html(
      callbackHtml({ ok: false, message: "Unknown or expired state token" }),
    );
  }
  // Expire ≥10 min old states.
  if (Date.now() - new Date(pending.createdAt).getTime() > 10 * 60 * 1000) {
    await db.delete(mcpOauthPending).where(eq(mcpOauthPending.id, pending.id));
    return c.html(callbackHtml({ ok: false, message: "Authorization expired (>10 min)" }));
  }

  const [server] = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.id, pending.serverId))
    .limit(1);
  if (!server || !server.oauthMetadata || !server.oauthClientId) {
    return c.html(callbackHtml({ ok: false, message: "Server state corrupt — try again" }));
  }

  try {
    const tokens = await exchangeCode({
      metadata: server.oauthMetadata as AuthServerMetadata,
      clientId: server.oauthClientId,
      clientSecret: server.oauthClientSecret,
      code,
      codeVerifier: pending.codeVerifier,
      redirectUri: pending.redirectUri,
    });
    const expiresAt = tokens.expiresInSec
      ? new Date(Date.now() + tokens.expiresInSec * 1000)
      : null;
    await db
      .update(mcpServers)
      .set({
        oauthAccessToken: tokens.accessToken,
        oauthRefreshToken: tokens.refreshToken,
        oauthExpiresAt: expiresAt,
        oauthScopes: tokens.scope ? tokens.scope.split(/\s+/) : null,
        lastError: null,
      })
      .where(eq(mcpServers.id, server.id));
    await db.delete(mcpOauthPending).where(eq(mcpOauthPending.id, pending.id));
    return c.html(callbackHtml({ ok: true, message: `Connected ${server.name}` }));
  } catch (e) {
    return c.html(callbackHtml({ ok: false, message: (e as Error).message }));
  }
};

/**
 * Disconnect — wipe tokens and metadata. We don't call the revocation
 * endpoint by default because not every server implements it; users
 * who care can do it manually in their account's app settings.
 */
mcpServersRoute.post("/:id/oauth/disconnect", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const r = await db
    .update(mcpServers)
    .set({
      oauthAccessToken: null,
      oauthRefreshToken: null,
      oauthExpiresAt: null,
      oauthScopes: null,
    })
    .where(and(eq(mcpServers.id, id), eq(mcpServers.userId, userId)))
    .returning({ id: mcpServers.id });
  if (r.length === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

/**
 * Self-closing HTML page returned at the end of the OAuth dance. The
 * popup window posts a message to its opener, then closes itself.
 */
function callbackHtml(opts: { ok: boolean; message: string }): string {
  const safeMessage = opts.message.replace(/[<&]/g, (m) =>
    m === "<" ? "&lt;" : "&amp;",
  );
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>OAuth callback</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; padding: 2rem; text-align: center; color: #0A0A0A; }
  .ok { color: #059669; } .err { color: #DC2626; }
  .box { max-width: 480px; margin: 4rem auto; padding: 2rem; border: 1px solid #E5E7EB; border-radius: 12px; }
</style></head>
<body>
<div class="box">
  <p class="${opts.ok ? "ok" : "err"}">${opts.ok ? "✓" : "✕"} ${safeMessage}</p>
  <p style="font-size: 12px; color: #6B7280;">You can close this window.</p>
</div>
<script>
  (function() {
    try {
      if (window.opener) {
        window.opener.postMessage({ type: "mcp-oauth", ok: ${opts.ok}, message: ${JSON.stringify(opts.message)} }, "*");
      }
    } catch (e) { /* ignore */ }
    setTimeout(function() { try { window.close(); } catch (e) {} }, 1500);
  })();
</script>
</body></html>`;
}

export default mcpServersRoute;
