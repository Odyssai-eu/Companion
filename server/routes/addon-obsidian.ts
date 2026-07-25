/**
 * Obsidian add-on routes — read-only sync of the user's memory wiki to an
 * Obsidian vault.
 *
 * Three endpoints:
 *
 *   GET  /api/addons/obsidian/info      → settings: enabled, syncToken, last
 *                                          synced, article count.
 *   POST /api/addons/obsidian/token     → regenerate the sync token.
 *   GET  /api/addons/obsidian/vault.zip → the vault as a downloadable ZIP.
 *                                          Authenticates via session cookie
 *                                          (browser "Download now") *or* via
 *                                          `Authorization: Bearer <token>`
 *                                          (the Obsidian plugin polling).
 *
 * The ZIP layout matches an Obsidian vault folder:
 *   _README.md          ← explains the folder
 *   _index.md           ← table of every article
 *   <category>/<slug>.md
 *
 * Each article carries YAML frontmatter so Obsidian shows it in the file
 * properties panel.
 */

import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import JSZip from "jszip";
import { db } from "../db/index";
import { addons, memoryArticles, projects } from "../db/schema";
import {
  materializeUserAddon,
  readOwnAddonConfig,
  resolveKnownAddon,
} from "../lib/instance-rows";

type Env = { Variables: { userId: string } };

const obsidianRoute = new Hono<Env>();

// ── Helpers ────────────────────────────────────────────────────────────────

const ADDON_NAME = "Obsidian";

type AddonConfig = {
  syncToken?: string;
  lastSyncedAt?: string; // ISO-8601 — set on each successful download
};

/**
 * Own row over instance row. Replaces findOrInitAddon(): resolution never
 * writes.
 *
 * `syncToken` and `lastSyncedAt` are in NEVER_INHERITED_CONFIG_KEYS
 * (server/lib/instance-rows.ts) and can therefore never arrive from the
 * instance row, whatever an operator puts there. The token is not
 * configuration — resolveBearerUser() below turns it into a user id — and
 * `lastSyncedAt` is per-account state.
 *
 * The switch itself still inherits, which is the useful half: an operator
 * can turn the Obsidian add-on on for the deployment and each user
 * generates their own token.
 */
async function loadObsidianAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
}

function newToken(): string {
  // 32 bytes base64url ≈ 43 chars, plenty of entropy.
  return `tcm_obs_${randomBytes(32).toString("base64url")}`;
}

function getConfig(addon: { config: unknown }): AddonConfig {
  return (addon.config ?? {}) as AddonConfig;
}

// ── /info ──────────────────────────────────────────────────────────────────

obsidianRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await loadObsidianAddon(userId);
  const cfg = getConfig(addon);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memoryArticles)
    .where(eq(memoryArticles.userId, userId));

  return c.json({
    addonId: addon.id,
    inherited: addon.inherited,
    enabled: addon.enabled,
    hasToken: Boolean(cfg.syncToken),
    lastSyncedAt: cfg.lastSyncedAt ?? null,
    articleCount: count,
    vaultUrl: "/api/addons/obsidian/vault.zip", // resolved against current origin client-side
  });
});

// ── /token ─────────────────────────────────────────────────────────────────

obsidianRoute.post("/token", async (c) => {
  const userId = c.get("userId");
  // Copy-on-write + delta write. Critical here specifically: a token
  // written onto the instance row would authenticate every vault download
  // as whoever's row it landed on.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as AddonConfig;
  const token = newToken();
  cfg.syncToken = token;
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, ownId));
  return c.json({ token });
});

obsidianRoute.delete("/token", async (c) => {
  const userId = c.get("userId");
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as AddonConfig;
  cfg.syncToken = undefined;
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, ownId));
  return c.body(null, 204);
});

// ── /vault.zip ─────────────────────────────────────────────────────────────

/** Look up `Authorization: Bearer tcm_obs_…` in the addons table and set
 *  c.var.userId so requireUser passes for the Obsidian plugin (it has no
 *  session cookie). Mounted ahead of requireUser in server/index.ts. */
async function resolveBearerUser(
  authHeader: string | undefined,
): Promise<string | null> {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(tcm_obs_[A-Za-z0-9_-]+)$/);
  if (!m) return null;
  const token = m[1];
  // Token is stored inside addons.config (jsonb). Find the addon by token.
  // We use a JSONB containment query — index-friendly with a GIN if we add
  // one later, fast enough without for our scale.
  const [row] = await db
    .select({ userId: addons.userId, addonId: addons.id })
    .from(addons)
    // 0060: instance rows have user_id NULL and this query has no user
    // filter by design (it is a token → user lookup). A token sitting on
    // an instance row cannot identify anybody, and matching one would
    // return null further down and read as a mysterious 401 — so exclude
    // them and keep looking. Belt and braces: the resolver already refuses
    // to inherit syncToken, and nothing writes one to an instance row.
    .where(
      and(
        isNotNull(addons.userId),
        sql`${addons.name} = ${ADDON_NAME} AND ${addons.config} @> ${JSON.stringify({ syncToken: token })}::jsonb`,
      ),
    )
    .limit(1);
  return row?.userId ?? null;
}

export const obsidianBearerLoader: MiddlewareHandler = async (c, next) => {
  if (!c.get("userId")) {
    const u = await resolveBearerUser(c.req.header("Authorization"));
    if (u) c.set("userId", u);
  }
  await next();
};

obsidianRoute.get("/vault.zip", async (c) => {
  const userId = c.get("userId");
  // requireUser already enforced this, but the type system doesn't know.
  if (!userId) return c.json({ error: "unauthorized" }, 401);

  // Make sure the add-on is enabled. If the user disabled it we don't serve.
  const addon = await loadObsidianAddon(userId);
  if (!addon.enabled) {
    return c.json({ error: "addon_disabled" }, 403);
  }

  // Fetch all articles + their projects (for project-name folders).
  const articles = await db
    .select({
      path: memoryArticles.path,
      title: memoryArticles.title,
      summary: memoryArticles.summary,
      body: memoryArticles.body,
      projectId: memoryArticles.projectId,
      editedByUser: memoryArticles.editedByUser,
      updatedAt: memoryArticles.updatedAt,
    })
    .from(memoryArticles)
    .where(eq(memoryArticles.userId, userId))
    .orderBy(memoryArticles.path);

  const projectRows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.userId, userId));
  const projectName = new Map(projectRows.map((p) => [p.id, p.name]));

  // Build the ZIP.
  const zip = new JSZip();

  zip.file(
    "_README.md",
    [
      "# Companion memory vault",
      "",
      "_Read-only mirror of the personal wiki that Companion compiled from",
      "your conversations._",
      "",
      "Files in this folder are overwritten on each sync. Edit them inside",
      "Companion if you want changes to stick.",
      "",
      "Layout:",
      "",
      "- `<category>/<slug>.md` — global articles (everything you've talked",
      "  about, regardless of project)",
      "- `_by-project/<project>/<category>/<slug>.md` — articles tied to a",
      "  specific project",
      "",
      `Generated: ${new Date().toISOString()}`,
    ].join("\n"),
  );

  // Index file
  const indexLines: string[] = [
    "# Index",
    "",
    "| Article | Scope | Summary |",
    "|---------|-------|---------|",
  ];
  for (const a of articles) {
    const slug = a.path.replace(/\.md$/, "");
    const scope = a.projectId
      ? `project: ${projectName.get(a.projectId) ?? "?"}`
      : "global";
    indexLines.push(
      `| [[${slug}]] | ${scope} | ${a.summary.replace(/\|/g, "\\|")} |`,
    );
  }
  zip.file("_index.md", indexLines.join("\n"));

  // Articles
  for (const a of articles) {
    const fm = [
      "---",
      `title: ${JSON.stringify(a.title)}`,
      `path: ${JSON.stringify(a.path)}`,
      `scope: ${a.projectId ? "project" : "global"}`,
      a.projectId
        ? `project: ${JSON.stringify(projectName.get(a.projectId) ?? a.projectId)}`
        : null,
      `edited_by_user: ${a.editedByUser}`,
      `updated: ${a.updatedAt.toISOString()}`,
      "source: companion-memory",
      "---",
      "",
    ]
      .filter((x): x is string => x !== null)
      .join("\n");

    const folder = a.projectId
      ? `_by-project/${sanitizeFolder(projectName.get(a.projectId) ?? a.projectId)}/${a.path}`
      : a.path;
    zip.file(folder, fm + a.body);
  }

  // Mark this as a successful sync. A write on a read path, so it needs
  // the same copy-on-write discipline as everything else: `addon.id` is
  // the INSTANCE row's id for a user who inherits the switch, and stamping
  // lastSyncedAt there would date every account's last sync from one
  // person's download.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as AddonConfig;
  cfg.lastSyncedAt = new Date().toISOString();
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, ownId));

  const buf = await zip.generateAsync({ type: "uint8array" });
  c.header("Content-Type", "application/zip");
  c.header(
    "Content-Disposition",
    `attachment; filename="companion-vault-${Date.now()}.zip"`,
  );
  return c.body(buf as unknown as ArrayBuffer);
});

function sanitizeFolder(name: string): string {
  return name.replace(/[\/\\:*?"<>|]/g, "_").trim() || "untitled";
}

export default obsidianRoute;
