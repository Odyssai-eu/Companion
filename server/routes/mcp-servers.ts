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
 *
 * SINCE 0060 A CARD IS NOT A ROW. A server may be the caller's own or an
 * INSTANCE row (`user_id IS NULL`) that every account inherits, paired by
 * slug. Reads go through `resolveMcpServersForUser` /
 * `resolveMcpServerById`; writes go through `materializeUserMcpServer`, so
 * a user editing an inherited card gets a partial override of their own
 * and never mutates the shared row.
 *
 * AND THE OAUTH DANCE WRITES ON THE CALLER'S ROW, ALWAYS. /oauth/start
 * materialises the ghost first and points the pending row at it, so the
 * public callback — which has no session and resolves the server straight
 * from `pending.server_id` — can only ever land tokens on a user row. The
 * callback re-checks that anyway (`server.user_id === pending.user_id`),
 * because that invariant is the difference between "user B sees a shared
 * Notion server" and "user B is logged into user A's Notion account".
 */

import { and, eq, lt } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { mcpOauthPending, mcpServers } from "../db/schema";
import {
  invalidateInstanceMcpServers,
  materializeUserMcpServer,
  mcpStateTargetId,
  publicMcpView,
  resolveMcpServerById,
  resolveMcpServerBySlug,
  resolveMcpServersForUser,
} from "../lib/instance-rows";
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
  // Instance rows overridden by the caller's own, by slug. Secrets are
  // masked to booleans by publicMcpView, exactly as this handler always
  // did — and now that a row can be the shared one, that masking is what
  // stops the deployment's bearer token being echoed to every account.
  const rows = await resolveMcpServersForUser(userId);
  return c.json({ servers: rows.map(publicMcpView) });
});

mcpServersRoute.post("/", zValidator("json", createSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const slug = data.slug ?? slugify(data.name);
  if (!slug || !slugRegex.test(slug)) {
    return c.json({ error: "invalid_slug", detail: "Slug must be lowercase ascii letters/digits and dashes." }, 400);
  }
  try {
    await db.insert(mcpServers).values({
      userId,
      name: data.name,
      slug,
      transport: data.transport,
      url: data.url,
      authKind: data.authKind ?? "bearer",
      authHeader: data.authHeader ?? null,
      enabled: data.enabled ?? true,
    });
    // Re-resolve rather than return the raw row: if this slug matches an
    // instance server, what the caller just created is an OVERRIDE of it,
    // and the card has to render as such.
    const resolved = await resolveMcpServerBySlug(userId, slug);
    return c.json({ server: resolved ? publicMcpView(resolved) : null });
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
    const target = await resolveMcpServerById(userId, id);
    if (!target) return c.json({ error: "not_found" }, 404);
    // Copy-on-write. An instance row id reaches here whenever the caller
    // edits an inherited card; the patch has to land on a row of their
    // own, or one user toggling a shared server would toggle it for the
    // whole deployment through a route guarded only by requireUser.
    const ownId = await materializeUserMcpServer(userId, target.slug);

    // SUBMITTING THE VALUE YOU ALREADY HAVE IS NOT AN EDIT.
    //
    // The edit modal loads the EFFECTIVE server and posts every field back,
    // so opening an inherited card and pressing Save arrives here with
    // `url` and `transport` set to the instance's own values. Recording
    // them verbatim would snapshot the shared address onto the caller's
    // row — the copy the whole 0060 design refuses (see the header of
    // server/lib/instance-rows.ts): the day the operator repoints the
    // instance server, that account alone keeps hammering the dead one,
    // and `sameTarget()` stops matching so it loses the shared bearer
    // header too. Comparing against the resolved value keeps a genuine
    // move a move and a no-op a no-op.
    //
    // The same comparison gates the wipe below, which is why it is
    // computed before the patch is built rather than inline.
    const urlChanged = data.url !== undefined && data.url !== target.url;
    const transportChanged =
      data.transport !== undefined && data.transport !== target.transport;

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) patch.name = data.name;
    if (transportChanged) patch.transport = data.transport;
    if (urlChanged) patch.url = data.url;
    if (data.authKind !== undefined) patch.authKind = data.authKind;
    if (data.authHeader !== undefined) patch.authHeader = data.authHeader ?? null;
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    // Bust the cache when the URL/transport/auth kind ACTUALLY changes — a
    // different backend OR a different auth model means the cached
    // tools list is meaningless. Also clear OAuth credentials when the
    // URL changes (they only make sense paired with the URL).
    //
    // `!== undefined` was the wrong test: it fired on the unchanged `url`
    // every Save posts, so re-saving an OAuth server with nothing edited
    // silently destroyed the caller's access and refresh tokens and left
    // them re-authorizing a server they never touched.
    //
    // Only the caller's own columns are cleared. The shared row is
    // untouched, and it does not need clearing on their behalf: the
    // resolver already withholds the instance's auth header and cached
    // metadata from anyone who has overridden `url` (`canInheritHostBound`
    // in instance-rows.ts), which is the same protection this wipe
    // provides, applied at read time and to every user at once.
    if (urlChanged || transportChanged) {
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
    await db.update(mcpServers).set(patch).where(eq(mcpServers.id, ownId));
    const updated = await resolveMcpServerBySlug(userId, target.slug);
    return c.json({ server: updated ? publicMcpView(updated) : null });
  },
);

mcpServersRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const [row] = await db
    .select({ userId: mcpServers.userId })
    .from(mcpServers)
    .where(eq(mcpServers.id, id))
    .limit(1);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.userId === null) {
    // Removing the instance row would remove the server for every account
    // on the deployment, from a route any authenticated user can reach.
    // "Remove this card" for a user means dropping their own override
    // (DELETE of their row below) or switching it off; removing it for
    // everyone is an admin action on /api/admin/instance-mcp-servers.
    return c.json({ error: "instance_row_readonly" }, 403);
  }
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
  const row = await resolveMcpServerById(userId, id);
  if (!row) return c.json({ error: "not_found" }, 404);
  // Not `id`: the cache belongs to the (server, credential) pair. A shared
  // bearer server caches on the instance row so every inheritor benefits;
  // an OAuth server caches on the caller's own row, because the tools list
  // a provider returns is scoped to the account that authorized. null =
  // an OAuth server this user has not connected, so there is nothing to
  // persist and nowhere honest to persist it.
  const stateId = mcpStateTargetId(row);
  try {
    const tools = await fetchMcpTools(row);
    if (stateId) {
      await db
        .update(mcpServers)
        .set({ toolsCache: tools, toolsCacheAt: new Date(), lastError: null })
        .where(eq(mcpServers.id, stateId));
      if (stateId === row.instanceRowId) invalidateInstanceMcpServers();
    }
    return c.json({ ok: true, tools });
  } catch (e) {
    if (stateId) {
      await db
        .update(mcpServers)
        .set({ lastError: (e as Error).message })
        .where(eq(mcpServers.id, stateId));
      if (stateId === row.instanceRowId) invalidateInstanceMcpServers();
    }
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
        // In-memory only, nothing is persisted, so there is no row of
        // either kind behind this probe.
        ownRowId: null,
        instanceRowId: null,
        inherited: false,
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
  const row = await resolveMcpServerById(userId, id);
  if (!row) return c.json({ error: "not_found" }, 404);

  // THE GHOST. An instance row may declare an OAuth server; the
  // authorization is personal, so before a single OAuth column is written
  // we materialise the caller's own row and address THAT from here on.
  // Everything downstream — the pending row, the client registration, the
  // tokens the public callback writes — targets `ownId`.
  //
  // The ghost is empty: name / url / transport / auth_kind stay NULL and
  // keep resolving from the instance row. Copying them would leave a live
  // token pointed at a dead address the day the operator repoints the
  // shared server.
  const ownId = await materializeUserMcpServer(userId, row.slug);

  // Garbage-collect stale pending rows for this server (10-min TTL)
  // before creating a new one — otherwise the table grows on every
  // abandoned attempt.
  await db
    .delete(mcpOauthPending)
    .where(
      and(
        eq(mcpOauthPending.serverId, ownId),
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

    // 4. Persist pending row + cache metadata/client on the GHOST row.
    //    `serverId: ownId`, never `id`: the callback resolves the server
    //    from this field with no session of its own, so pointing it at the
    //    instance row is exactly how tokens would end up shared.
    await db.insert(mcpOauthPending).values({
      userId,
      serverId: ownId,
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
      .where(eq(mcpServers.id, ownId));

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
  // BELT AND BRACES on the 0060 boundary. /oauth/start already points
  // `pending.server_id` at the caller's ghost row, so this can only fail if
  // some future caller forgets — but this handler is PUBLIC (the provider's
  // redirect arrives with no session cookie) and the next statement writes
  // an access token and a refresh token. If that ever landed on an instance
  // row, every account inheriting the server would be authenticated as
  // whoever happened to authorize last. `pending.user_id` was carried in
  // the table since 0031 and never read; it is read now.
  if (server.userId === null || server.userId !== pending.userId) {
    await db.delete(mcpOauthPending).where(eq(mcpOauthPending.id, pending.id));
    return c.html(
      callbackHtml({ ok: false, message: "Authorization target mismatch — try again" }),
    );
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
    // `server.name` is NULL on a ghost — it inherits the instance row's.
    // The slug is always present and is what the user typed anyway.
    return c.html(
      callbackHtml({ ok: true, message: `Connected ${server.name ?? server.slug}` }),
    );
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
  const target = await resolveMcpServerById(userId, id);
  if (!target) return c.json({ error: "not_found" }, 404);
  // Tokens only ever live on the caller's own row, so this is a no-op when
  // they never authorized — and it must never fall back to the instance
  // row, which would disconnect everybody.
  const ownId = target.ownRowId;
  if (!ownId) return c.json({ ok: true });
  const r = await db
    .update(mcpServers)
    .set({
      oauthAccessToken: null,
      oauthRefreshToken: null,
      oauthExpiresAt: null,
      oauthScopes: null,
    })
    .where(and(eq(mcpServers.id, ownId), eq(mcpServers.userId, userId)))
    .returning({
      id: mcpServers.id,
      name: mcpServers.name,
      url: mcpServers.url,
      transport: mcpServers.transport,
      enabled: mcpServers.enabled,
      authHeader: mcpServers.authHeader,
      oauthClientId: mcpServers.oauthClientId,
    });
  if (r.length === 0) return c.json({ error: "not_found" }, 404);
  // A ghost that carried nothing but OAuth state is now an empty override
  // that shadows nothing and shows up as "not inherited" in the UI for no
  // reason. Drop it so the card goes back to being a plain inherited one.
  // (`oauth_client_id` and `oauth_metadata` are deliberately kept by this
  // endpoint for re-use — so a ghost that still holds a client id is NOT
  // empty and stays.)
  const g = r[0];
  const emptyGhost =
    g.name === null &&
    g.url === null &&
    g.transport === null &&
    g.enabled === null &&
    g.authHeader === null &&
    g.oauthClientId === null;
  if (emptyGhost) {
    await db.delete(mcpServers).where(eq(mcpServers.id, ownId));
  }
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
