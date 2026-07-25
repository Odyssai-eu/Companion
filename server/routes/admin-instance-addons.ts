/**
 * Admin — INSTANCE add-ons and INSTANCE MCP servers (0060).
 *
 *   GET    /api/admin/instance-addons          list the shared add-ons
 *   PUT    /api/admin/instance-addons/:name    create / edit one
 *   DELETE /api/admin/instance-addons/:name    remove one
 *
 *   GET    /api/admin/instance-mcp-servers         list the shared servers
 *   PUT    /api/admin/instance-mcp-servers/:slug   create / edit one
 *   DELETE /api/admin/instance-mcp-servers/:slug   remove one
 *
 * WHY THIS EXISTS
 * The sibling of admin-instance-settings.ts, which owns the connection
 * block. 0060 moved add-ons and MCP servers to the same model — a row with
 * `user_id IS NULL` that every account inherits — and /api/addons and
 * /api/mcp-servers are behind `requireUser`, so they deliberately refuse to
 * write those rows: a user editing an inherited card gets a private
 * override, not a change for the whole deployment. Editing the shared
 * values is this route, and this route is `requireRole("admin")`.
 *
 * ADDRESSED BY IDENTITY, NOT BY ROW ID. `name` for add-ons and `slug` for
 * MCP servers are the keys the resolver pairs on; a PUT is an upsert on
 * that identity, which makes "configure the Parser for everyone" one call
 * whether or not the row already exists.
 *
 * SECRETS ARE WRITE-ONLY, same contract as admin-instance-settings.ts. GET
 * masks them to `configHas.<key>` / `hasAuthHeader` booleans, so they
 * cannot be round-tripped through a form: omit a secret to keep the stored
 * one, send null to clear it, send a string to replace it.
 *
 * THE OAUTH BOUNDARY IS ENFORCED HERE TOO. An instance MCP row may declare
 * an OAuth server — name, url, transport, auth_kind and the cached
 * .well-known metadata — and nothing else. The five credential columns are
 * not in the schema this route accepts and are actively cleared on write,
 * because a shared access token or refresh token would give every account
 * the third-party account of whoever authorized. Same hole 0059 closed on
 * engine_token; see the header of drizzle/0060.
 */
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { db } from "../db/index";
import { addons, mcpServers } from "../db/schema";
import {
  ADDON_CATALOG,
  catalogEntry,
  getInstanceAddons,
  getInstanceMcpServers,
  invalidateInstanceAddons,
  invalidateInstanceMcpServers,
  SECRET_CONFIG_KEYS,
} from "../lib/instance-rows";
import { requireRole } from "../middleware/auth";

type Env = { Variables: { userId: string } };
const adminInstanceAddonsRoute = new Hono<Env>();
adminInstanceAddonsRoute.use("*", requireRole("admin"));

// ── Add-ons ──────────────────────────────────────────────────────────────

function asConfig(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/** Config with the secret keys reduced to booleans — never in clear. */
function maskConfig(raw: unknown) {
  const src = asConfig(raw);
  const config: Record<string, unknown> = {};
  const configHas: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(src)) {
    if (SECRET_CONFIG_KEYS.includes(k)) {
      configHas[k] = typeof v === "string" ? v.trim().length > 0 : v != null;
      continue;
    }
    // Not a secret, just enormous and unreadable: a few hundred kilobytes
    // of embedding floats no admin form can usefully render.
    if (k === "anchorCentroids") {
      configHas[k] = Array.isArray(v) || (v != null && typeof v === "object");
      continue;
    }
    config[k] = v;
  }
  return { config, configHas };
}

adminInstanceAddonsRoute.get("/instance-addons", async (c) => {
  const rows = await getInstanceAddons();
  const byName = new Map(rows.map((r) => [r.name, r]));
  // Catalogue first so the page lists every add-on the build knows how to
  // render, configured or not — an operator cannot publish a Parser URL
  // for the deployment if the Parser has no card until somebody creates
  // the row by hand.
  const names = ADDON_CATALOG.map((e) => e.name);
  for (const n of byName.keys()) if (!names.includes(n)) names.push(n);
  return c.json({
    addons: names.map((name) => {
      const row = byName.get(name);
      const cat = catalogEntry(name);
      const masked = maskConfig(row?.config);
      return {
        name,
        exists: Boolean(row),
        kind: row?.kind ?? cat?.kind ?? "plugin",
        description: row?.description ?? cat?.description ?? null,
        version: row?.version ?? cat?.version ?? null,
        enabled: row?.enabled ?? false,
        ...masked,
        updatedAt: row?.updatedAt ?? null,
      };
    }),
  });
});

const addonPutSchema = z.object({
  enabled: z.boolean(),
  /**
   * Full replacement of the shared config. Secret keys work like the
   * secrets in admin-instance-settings.ts: absent from the body means
   * "keep whatever is stored" (they are never sent back to the form in
   * clear, so a round-trip would otherwise erase them), null means clear,
   * a string means replace.
   */
  config: z.record(z.unknown()).default({}),
});

adminInstanceAddonsRoute.put(
  "/instance-addons/:name",
  zValidator("json", addonPutSchema),
  async (c) => {
    const name = decodeURIComponent(c.req.param("name"));
    const data = c.req.valid("json");
    const cat = catalogEntry(name);
    const [existing] = await db
      .select()
      .from(addons)
      .where(and(isNull(addons.userId), eq(addons.name, name)))
      .limit(1);
    if (!existing && !cat) {
      // Refusing an unknown name keeps the instance list to add-ons the
      // build can actually render; a typo would otherwise create a card
      // nobody has a panel for and no user can configure.
      return c.json({ error: "unknown_addon" }, 400);
    }

    const prev = asConfig(existing?.config);
    const next: Record<string, unknown> = { ...data.config };
    for (const k of SECRET_CONFIG_KEYS) {
      if (!(k in data.config)) {
        // Omitted → keep. GET never returned it, so the form could not
        // have echoed it back.
        if (k in prev) next[k] = prev[k];
      } else if (data.config[k] === null || data.config[k] === "") {
        delete next[k];
      }
    }
    // anchorCentroids is the same case for a different reason: masked out
    // of GET because of its size, so a form round-trip would drop it.
    if (!("anchorCentroids" in data.config) && "anchorCentroids" in prev) {
      next.anchorCentroids = prev.anchorCentroids;
      if ("anchorsBuiltAt" in prev) next.anchorsBuiltAt = prev.anchorsBuiltAt;
    }

    if (existing) {
      await db
        .update(addons)
        .set({ enabled: data.enabled, config: next, updatedAt: new Date() })
        .where(eq(addons.id, existing.id));
    } else {
      await db.insert(addons).values({
        userId: null,
        name,
        kind: cat?.kind ?? "plugin",
        description: cat?.description ?? null,
        version: cat?.version ?? null,
        enabled: data.enabled,
        config: next,
      });
    }
    invalidateInstanceAddons();
    return c.json({ ok: true });
  },
);

adminInstanceAddonsRoute.delete("/instance-addons/:name", async (c) => {
  const name = decodeURIComponent(c.req.param("name"));
  const r = await db
    .delete(addons)
    .where(and(isNull(addons.userId), eq(addons.name, name)))
    .returning({ id: addons.id });
  invalidateInstanceAddons();
  if (r.length === 0) return c.json({ error: "not_found" }, 404);
  // User overrides of this add-on are deliberately left alone: they are
  // configuration those accounts entered themselves, and deleting them
  // would be destroying data on N accounts to tidy up one shared row.
  // They simply stop having anything to inherit.
  return c.json({ ok: true });
});

// ── MCP servers ──────────────────────────────────────────────────────────

adminInstanceAddonsRoute.get("/instance-mcp-servers", async (c) => {
  const rows = await getInstanceMcpServers();
  return c.json({
    servers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      transport: r.transport,
      url: r.url,
      authKind: r.authKind,
      hasAuthHeader: Boolean(r.authHeader),
      hasOauthMetadata: Boolean(r.oauthMetadata),
      enabled: r.enabled ?? false,
      toolsCount: Array.isArray(r.toolsCache) ? r.toolsCache.length : 0,
      toolsCacheAt: r.toolsCacheAt,
      lastError: r.lastError,
      updatedAt: r.updatedAt,
    })),
  });
});

const slugRegex = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$|^[a-z0-9]$/;

const mcpPutSchema = z.object({
  name: z.string().min(1).max(120),
  transport: z.enum(["streamable_http", "sse"]),
  url: z.string().url().max(500),
  authKind: z.enum(["bearer", "oauth", "none"]),
  /**
   * Shared bearer credential. Write-only like every other secret here:
   * omit to keep, null to clear, string to replace.
   *
   * Sharing it is the product owner's explicit decision — these tokens
   * address services the deployment owns. The resolver still refuses to
   * hand it to a user who overrode `url`, so it can never be posted to an
   * address of that user's choosing (instance-rows.ts,
   * `canInheritHostBound`).
   */
  authHeader: z.string().max(2000).nullish(),
  enabled: z.boolean(),
});

adminInstanceAddonsRoute.put(
  "/instance-mcp-servers/:slug",
  zValidator("json", mcpPutSchema),
  async (c) => {
    const slug = c.req.param("slug");
    if (!slugRegex.test(slug)) {
      return c.json({ error: "invalid_slug" }, 400);
    }
    const data = c.req.valid("json");
    const [existing] = await db
      .select()
      .from(mcpServers)
      .where(and(isNull(mcpServers.userId), eq(mcpServers.slug, slug)))
      .limit(1);

    const urlChanged = existing ? existing.url !== data.url : false;
    const patch: Record<string, unknown> = {
      name: data.name,
      transport: data.transport,
      url: data.url,
      authKind: data.authKind,
      enabled: data.enabled,
      updatedAt: new Date(),
    };
    if (data.authHeader !== undefined) {
      patch.authHeader = data.authHeader ?? null;
    }
    // A bearer header belongs to the auth model it was entered under;
    // leaving it behind on a server switched to OAuth or to none would
    // keep sending it.
    if (data.authKind !== "bearer") patch.authHeader = null;
    if (urlChanged) {
      // The cached tools list and the cached .well-known both describe the
      // OLD address. Same wipe /api/mcp-servers does on a user row.
      patch.toolsCache = null;
      patch.toolsCacheAt = null;
      patch.lastError = null;
      patch.oauthMetadata = null;
    }
    // Belt and braces on the hard boundary: whatever else happens, an
    // instance row never carries a credential that identifies a person.
    // The schema above cannot even express these, but a row could have
    // acquired them from a hand-written INSERT or a restored dump.
    patch.oauthClientId = null;
    patch.oauthClientSecret = null;
    patch.oauthAccessToken = null;
    patch.oauthRefreshToken = null;
    patch.oauthExpiresAt = null;
    patch.oauthScopes = null;

    if (existing) {
      await db.update(mcpServers).set(patch).where(eq(mcpServers.id, existing.id));
    } else {
      await db.insert(mcpServers).values({ userId: null, slug, ...patch });
    }
    invalidateInstanceMcpServers();
    return c.json({ ok: true });
  },
);

adminInstanceAddonsRoute.delete("/instance-mcp-servers/:slug", async (c) => {
  const slug = c.req.param("slug");
  // Ghost rows (a user's OAuth tokens for this server, with everything
  // else NULL) become unresolvable orphans the moment the instance row
  // goes: nothing can supply their url or transport any more. The resolver
  // already skips them, but leaving dead tokens in the table is worse than
  // useless, so they go with it.
  //
  // A user row that is COMPLETE on its own — somebody who overrode the
  // shared server with their own address — is left alone: it stops being
  // an override and simply becomes their own server, which still works.
  const orphans = await db
    .select({ id: mcpServers.id, url: mcpServers.url, transport: mcpServers.transport })
    .from(mcpServers)
    .where(eq(mcpServers.slug, slug))
    .orderBy(asc(mcpServers.createdAt));
  const r = await db
    .delete(mcpServers)
    .where(and(isNull(mcpServers.userId), eq(mcpServers.slug, slug)))
    .returning({ id: mcpServers.id });
  for (const o of orphans) {
    if (o.url === null || o.transport === null) {
      await db.delete(mcpServers).where(eq(mcpServers.id, o.id));
    }
  }
  invalidateInstanceMcpServers();
  if (r.length === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

export default adminInstanceAddonsRoute;
