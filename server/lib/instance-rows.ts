/**
 * Instance rows for `addons` and `mcp_servers`, and the user ← instance
 * resolution layer on top of them (0060).
 *
 * The sibling of server/lib/global-settings.ts, which does the same job for
 * the connection block. Read that file first: the rules here are the same
 * rules, and where they differ the difference is called out.
 *
 * WHAT AN INSTANCE ROW IS
 * A row with `user_id IS NULL`. It carries the deployment's configuration
 * for one add-on (paired by `name`) or one MCP server (paired by `slug`).
 * Every account inherits it. A user row of the same identity overrides it:
 *
 *   - `mcp_servers`: column by column, `own.X ?? instance.X`.
 *   - `addons`: the same, plus the `config` jsonb merges KEY BY KEY.
 *
 * The per-key merge is the whole point. Blob-level precedence would mean a
 * user who once set `pdfMode` loses the inherited Docling `url` and the
 * Parser silently stops parsing — which is the exact bug 0060 exists to
 * fix, reintroduced one level up.
 *
 * EMPTY STRING IS "UNSET", same as global-settings.ts: the settings forms
 * submit "" for a cleared field and "" is not a usable URL / token / model
 * id anywhere, so it must not pin the user to a broken override.
 *
 * NOTHING IS EVER COPIED ONTO A USER ROW. `materializeUserAddon` /
 * `materializeUserMcpServer` create a row that is almost entirely NULL —
 * an EMPTY override, not a snapshot. A snapshot drifts the moment the
 * operator repoints a service, and for `mcp_servers` it would leave ghost
 * rows holding a live OAuth token pointed at a dead address.
 *
 * SECRETS FOLLOW THEIR HOST. 0059 found that inheriting `engine_token`
 * field-by-field let any account PATCH `engine_url` to a server it
 * controlled and receive the deployment's shared token on the next
 * message. The same shape exists here three times over — `bridgeToken`
 * next to `bridgeUrl` on the Hermes / Pi / ComfyUI add-ons, and
 * `auth_header` next to `url` on a bearer MCP server. So a credential is
 * inherited only when the URL it authenticates against is ALSO inherited.
 * `PAIRED_CONFIG_KEYS` and `ownUrl` below are that rule.
 *
 * OAUTH IS NEVER INHERITED, full stop. Access token, refresh token, client
 * secret, expiry and scopes are read from the user's own row or not at all,
 * and `mcpWriteTargetId()` refuses to hand an instance row id to any writer
 * of those columns. An instance row with auth_kind='oauth' only DECLARES
 * the server; each user authorizes for themselves.
 *
 * CACHING. The instance rows sit on the chat hot path (toolsForUser calls
 * three add-on lookups and the MCP list on every turn). They are cached for
 * 30 s and invalidated synchronously by the admin writes in
 * server/routes/admin-instance-addons.ts — same contract as
 * getInstanceSettings(). User rows are NOT cached: callers already had to
 * query them before 0060, so resolution costs exactly the queries it cost
 * then, and a user write is visible on the next read with no invalidation
 * dance.
 */
import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "../db/index";
import { addons, mcpServers } from "../db/schema";
import type { Addon, McpServerRow } from "../db/schema";

const CACHE_TTL_MS = 30_000;

// ── Add-on catalogue ─────────────────────────────────────────────────────

/**
 * The add-ons this build knows how to render and configure.
 *
 * These four fields used to be duplicated inside each route's
 * `findOrInit*()` INSERT. They live here now because 0060 needs them in two
 * places the routes cannot reach: the Add-ons page has to list an add-on
 * that has NO row anywhere (fresh install, operator has not configured the
 * instance yet), and the admin page has to offer the same list when
 * creating an instance row. A route that still owned its own copy would
 * drift from whatever those two rendered.
 *
 * `name` is the identity — it is what pairs a user row with its instance
 * row, what the six historical data migrations matched on, and what the UI
 * switches on. Changing one is a data migration, not an edit.
 */
export type AddonCatalogEntry = {
  name: string;
  kind: "core" | "plugin" | "mcp";
  description: string;
  version: string;
};

export const ADDON_CATALOG: readonly AddonCatalogEntry[] = [
  {
    name: "Obsidian",
    kind: "plugin",
    description:
      "Read-only sync of your memory wiki to an Obsidian vault. Install the companion plugin and paste your sync token.",
    version: "0.1.0",
  },
  {
    name: "Web Search",
    kind: "plugin",
    description:
      "Give the assistant web access via Tavily — search and fetch URLs " +
      "as tool calls. Paste your Tavily API key to enable.",
    version: "0.1.0",
  },
  {
    name: "Voice",
    kind: "plugin",
    description:
      "Unified voice in/out for chat (TTS + ASR). Local OpenAI-compatible audio — set its endpoint.",
    version: "0.2.0",
  },
  {
    // Auto Router (semantic-router add-on) removed 2026-08-04 — CoeOS is
    // the router now (auto mode → the CoeOS engine), so the embeddings-based
    // add-on is obsolete. Hermes Agent + Pi Agent removed 2026-08-03
    // (v2.0 γb1) — native agent runtime (task tool + ops subagent).
    name: "ComfyUI Imager",
    kind: "plugin",
    description:
      "Image generation via the OdyssAI-Imager bridge. Type /comfyui " +
      "<prompt> in chat or use the panel below to render with Flux.1 " +
      "(schnell or dev) on your local ComfyUI host. Requires the bridge " +
      "endpoint reachable from Companion.",
    version: "0.1.0",
  },
  {
    name: "Parser",
    kind: "plugin",
    description:
      "Parse attached documents (PDF, DOCX, PPTX, XLSX, CSV, MD, HTML) " +
      "into markdown via the Docling service before the message is sent, " +
      "so text-only models can read them. Points Companion at your Docling " +
      "endpoint.",
    version: "0.1.0",
  },
  {
    name: "Document Producer",
    kind: "plugin",
    description:
      "Turn the model's reply into a real Office file: Word (.docx) from " +
      "markdown, Excel (.xlsx) from a JSON table spec. The mirror of the " +
      "Parser. Points Companion at your render service endpoint. " +
      "Slides are produced as HTML instead.",
    version: "0.1.0",
  },
  {
    name: "Confidential Guard",
    kind: "plugin",
    description:
      "Detect confidential content (GDPR identifiers, health data, " +
      "financials, credentials) in your message before it is sent, warn " +
      "you, and optionally keep the turn on your local engine instead of " +
      "a cloud provider. Points Companion at your Guardian endpoint.",
    version: "0.1.0",
  },
] as const;

export function catalogEntry(name: string): AddonCatalogEntry | null {
  return ADDON_CATALOG.find((e) => e.name === name) ?? null;
}

// ── Config-key inheritance policy ────────────────────────────────────────

/**
 * Config keys that must NEVER be taken from an instance row, whatever an
 * admin puts there.
 *
 * `syncToken` is not configuration: `resolveBearerUser()` in
 * addon-obsidian.ts turns it into a user id with a table scan that has no
 * user_id filter, so it is an authentication principal. A shared one is
 * meaningless and a leaked one is an account. `lastSyncedAt` is per-account
 * state, rewritten on every vault download.
 */
const NEVER_INHERITED_CONFIG_KEYS: Record<string, readonly string[]> = {
  Obsidian: ["syncToken", "lastSyncedAt"],
};

/**
 * dependent key → the key it belongs to. A dependent key is inherited only
 * while its owner key is ALSO inherited.
 *
 * Two families, one rule:
 *   - credentials (`bridgeToken`) authenticate against exactly one host. A
 *     user who repoints `bridgeUrl` must not have the deployment's token
 *     posted to the address they just typed — 0059's engineToken hole.
 *   - caches (`anchorCentroids`, `anchorsBuiltAt`) only describe the
 *     service they were computed from; different embeddings endpoint means
 *     different dimensionality and different geometry, so the centroids
 *     are not merely stale, they are wrong. addon-router.ts already
 *     rebuilds them whenever the URL changes for exactly this reason.
 *     Same argument as `engineMeta` following `engineUrl` in 0059.
 */
const PAIRED_CONFIG_KEYS: Record<string, Readonly<Record<string, string>>> = {
  "ComfyUI Imager": { bridgeToken: "bridgeUrl" },
  // The stage-2 model id belongs to the LLM endpoint it is served from —
  // a user pointing contextual detection at their own LLM must not keep
  // the instance's model name. Same argument as Voice's ttsModel.
  "Confidential Guard": { contextualLlmModel: "contextualLlmUrl" },
  // The speaker catalogue and the model list belong to the audio server,
  // so a user pointing at their own one inherits neither.
  Voice: { ttsModel: "ttsEndpoint", voice: "ttsEndpoint", asrEndpoint: "ttsEndpoint" },
};

/**
 * Config keys never returned in clear by a listing endpoint. `addons.config`
 * is an opaque blob that GET /api/addons used to hand back verbatim; that
 * was already generous when every row belonged to the caller, and it would
 * be a straight credential leak now that the blob can come from the shared
 * instance row. The listing reports `configHas.<key>: true` instead.
 */
export const SECRET_CONFIG_KEYS: readonly string[] = [
  "bridgeToken",
  "apiKey",
  "syncToken",
];

/**
 * Config keys stripped from listing responses for size, not secrecy.
 * `anchorCentroids` is a few hundred kilobytes of floats and no client
 * reads it.
 */
const BULKY_CONFIG_KEYS: readonly string[] = ["anchorCentroids"];

// ── Small shared helpers ─────────────────────────────────────────────────

/** Mirrors `pick()` in global-settings.ts: "" and blank are not values. */
function isSet(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  return true;
}

function asConfig(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * True when a user's own value for a HOST-BOUND key is byte-identical to
 * the instance's — i.e. they hold an override that repoints nothing.
 *
 * This is what makes the "secrets follow their host" rule mean what its
 * comment says. The rule exists so the deployment's credential is never
 * posted to an address of the user's choosing (0059's engineToken hole);
 * its premise is that the user MOVED the target. When the two strings are
 * equal there is no move, no redirection, and no new host to leak to — the
 * token goes exactly where the operator already sends it.
 *
 * Without this, an override identical to the inherited value silently
 * detaches the credential. That is not hypothetical: every settings form
 * in src/pages/settings loads the EFFECTIVE value and submits it back
 * (McpServersPage's edit modal sends `url`, BridgeAddonPanel sends
 * `bridgeUrl`), so merely opening an inherited card and pressing Save was
 * enough to strip the shared bearer token and 401 the service. Comparing
 * the target keeps the security property intact and the service working.
 *
 * Conservative on purpose: different types, blanks, or a trailing-slash
 * difference all read as "moved" and withhold the credential.
 */
function sameTarget(own: unknown, inst: unknown): boolean {
  if (typeof own !== "string" || typeof inst !== "string") return false;
  const a = own.trim();
  return a.length > 0 && a === inst.trim();
}

// ── Instance row caches ──────────────────────────────────────────────────

let addonCache: { rows: Addon[]; at: number } | null = null;
let mcpCache: { rows: McpServerRow[]; at: number } | null = null;

/** Drop the memoised instance add-ons. Every admin write calls this. */
export function invalidateInstanceAddons(): void {
  addonCache = null;
}

/** Drop the memoised instance MCP servers. Every admin write calls this. */
export function invalidateInstanceMcpServers(): void {
  mcpCache = null;
}

export async function getInstanceAddons(): Promise<Addon[]> {
  const now = Date.now();
  if (addonCache && now - addonCache.at < CACHE_TTL_MS) return addonCache.rows;
  const rows = await db
    .select()
    .from(addons)
    .where(isNull(addons.userId))
    // Deterministic winner even on a database where 0060 could not create
    // addons_user_name_unique (duplicates present at migration time).
    .orderBy(asc(addons.createdAt), asc(addons.id));
  addonCache = { rows, at: now };
  return rows;
}

export async function getInstanceMcpServers(): Promise<McpServerRow[]> {
  const now = Date.now();
  if (mcpCache && now - mcpCache.at < CACHE_TTL_MS) return mcpCache.rows;
  const rows = await db
    .select()
    .from(mcpServers)
    .where(isNull(mcpServers.userId))
    .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id));
  mcpCache = { rows, at: now };
  return rows;
}

// ── Add-ons: resolution ──────────────────────────────────────────────────

export type ResolvedAddon = {
  /**
   * The row a caller should address. The user's own row when there is one,
   * otherwise the instance row, otherwise null (catalogue-only entry, no
   * row exists anywhere yet).
   *
   * NEVER write through this id without going via `materializeUserAddon`:
   * for an inherited entry it points at the shared row.
   */
  id: string | null;
  /** The caller's own row, if any. The only id a user write may target. */
  ownRowId: string | null;
  instanceRowId: string | null;
  /** The owner of `ownRowId`, or null when the entry is fully inherited. */
  userId: string | null;
  name: string;
  kind: "core" | "plugin" | "mcp";
  description: string | null;
  version: string | null;
  /** user.enabled ?? instance.enabled ?? false. */
  enabled: boolean;
  /** Per-key merge of the instance config under the user's own config. */
  config: Record<string, unknown>;
  /** True when the caller has no row of this name — everything is inherited. */
  inherited: boolean;
  /** Config keys whose effective value came from the instance row. */
  inheritedConfigKeys: string[];
};

function mergeAddonConfig(
  name: string,
  own: Record<string, unknown>,
  inst: Record<string, unknown>,
): { config: Record<string, unknown>; inheritedKeys: string[] } {
  const never = NEVER_INHERITED_CONFIG_KEYS[name] ?? [];
  const pairs = PAIRED_CONFIG_KEYS[name] ?? {};
  const out: Record<string, unknown> = {};
  const inheritedKeys: string[] = [];

  // Start from the user's own keys — anything they actually set wins.
  for (const [k, v] of Object.entries(own)) {
    if (isSet(v)) out[k] = v;
  }
  for (const [k, v] of Object.entries(inst)) {
    if (k in out) continue;
    if (!isSet(v)) continue;
    if (never.includes(k)) continue;
    // A dependent key does not cross when its owner key was overridden to
    // a DIFFERENT target: the token would authenticate against the user's
    // host, the cache would describe the wrong service. An override that
    // repoints nothing (same string) is not a move — see sameTarget().
    const owner = pairs[k];
    if (owner && isSet(own[owner]) && !sameTarget(own[owner], inst[owner])) {
      continue;
    }
    out[k] = v;
    inheritedKeys.push(k);
  }
  return { config: out, inheritedKeys };
}

function resolveAddonPair(
  name: string,
  own: Addon | undefined,
  inst: Addon | undefined,
): ResolvedAddon | null {
  const cat = catalogEntry(name);
  if (!own && !inst && !cat) return null;
  const { config, inheritedKeys } = mergeAddonConfig(
    name,
    asConfig(own?.config),
    asConfig(inst?.config),
  );
  return {
    id: own?.id ?? inst?.id ?? null,
    ownRowId: own?.id ?? null,
    instanceRowId: inst?.id ?? null,
    userId: own?.userId ?? null,
    name,
    kind: own?.kind ?? inst?.kind ?? cat?.kind ?? "plugin",
    description: own?.description ?? inst?.description ?? cat?.description ?? null,
    version: own?.version ?? inst?.version ?? cat?.version ?? null,
    // `?? false` terminates the chain. An instance row always carries a
    // real boolean (CHECK addons_instance_complete), so the only way to
    // reach the literal is a catalogue-only entry — nothing configured
    // anywhere, which is correctly "off".
    enabled: own?.enabled ?? inst?.enabled ?? false,
    config,
    inherited: !own,
    inheritedConfigKeys: inheritedKeys,
  };
}

/**
 * One add-on, resolved for one user. A single indexed lookup on the user's
 * row plus the cached instance list — the same query budget the old
 * `findOrInit*()` had, which is what keeps the chat hot path unchanged.
 *
 * Unlike `findOrInit*()` this NEVER writes. That is the fix: the old
 * function materialised an empty row on the first /info ping, and under
 * inheritance an empty row is not an empty slot, it is an override that
 * shadows the instance and reproduces the original bug.
 *
 * Returns null only for a name that exists neither in the catalogue nor in
 * the database (an ad-hoc row created through POST /api/addons and since
 * deleted, say).
 */
export async function resolveAddonForUser(
  userId: string,
  name: string,
): Promise<ResolvedAddon | null> {
  const [own] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, name)))
    .orderBy(asc(addons.createdAt), asc(addons.id))
    .limit(1);
  const inst = (await getInstanceAddons()).find((r) => r.name === name);
  return resolveAddonPair(name, own, inst);
}

/**
 * Same, for one of the ten names in `ADDON_CATALOG` — which always
 * resolves, so the nine route modules do not each need a null branch they
 * can never hit. Throws on a name the build does not know, which is a
 * programming error rather than a runtime condition.
 */
export async function resolveKnownAddon(
  userId: string,
  name: string,
): Promise<ResolvedAddon> {
  const r = await resolveAddonForUser(userId, name);
  if (!r) throw new Error(`unknown add-on: ${name}`);
  return r;
}

/**
 * Every add-on visible to one user: the catalogue, plus any instance row
 * or ad-hoc user row outside it, each resolved. Ordered catalogue-first so
 * the Add-ons page renders in a stable, meaningful order rather than by
 * whichever row happened to be created first.
 */
export async function resolveAddonsForUser(
  userId: string,
): Promise<ResolvedAddon[]> {
  const ownRows = await db
    .select()
    .from(addons)
    .where(eq(addons.userId, userId))
    .orderBy(asc(addons.createdAt), asc(addons.id));
  const instRows = await getInstanceAddons();

  const ownByName = new Map<string, Addon>();
  for (const r of ownRows) if (!ownByName.has(r.name)) ownByName.set(r.name, r);
  const instByName = new Map<string, Addon>();
  for (const r of instRows) if (!instByName.has(r.name)) instByName.set(r.name, r);

  const names: string[] = ADDON_CATALOG.map((e) => e.name);
  for (const n of [...instByName.keys(), ...ownByName.keys()]) {
    if (!names.includes(n)) names.push(n);
  }

  const out: ResolvedAddon[] = [];
  for (const n of names) {
    const r = resolveAddonPair(n, ownByName.get(n), instByName.get(n));
    if (r) out.push(r);
  }
  return out;
}

/**
 * The caller's OWN config for an add-on, with nothing inherited mixed in.
 *
 * Every `PUT /config` handler must build its patch on top of THIS, not on
 * top of the resolved config, and every handler rewrites the whole `config`
 * object. Merging first and writing second would freeze the instance's
 * values into the user's row on the first save — the snapshot 0059
 * rejected, arriving through the back door.
 */
export async function readOwnAddonConfig(
  userId: string,
  name: string,
): Promise<Record<string, unknown>> {
  const [own] = await db
    .select({ config: addons.config })
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, name)))
    .orderBy(asc(addons.createdAt), asc(addons.id))
    .limit(1);
  return asConfig(own?.config);
}

/**
 * Strip the keys a save is only ECHOING back from the instance.
 *
 * `readOwnAddonConfig` keeps the server's delta write honest, but the client
 * is the other half of the contract and it does not hold up its end: every
 * panel seeds its form from the EFFECTIVE config (own over instance) and
 * re-posts the whole form on Save. So a user who edits one field silently
 * writes the instance's values for every OTHER field onto their own row.
 * Nothing looks wrong — until the operator repoints the service and that
 * account stays pinned to the dead address. That snapshot is precisely what
 * inheritance exists to prevent, arriving through the form instead of
 * through the schema.
 *
 * The rule: a value identical to what the user would have inherited anyway
 * is not a decision, so it does not become an override. Two deliberate
 * exceptions:
 *   - a key ALREADY present on their own row stays (re-saving an existing
 *     override that happens to match the instance must not silently drop it);
 *   - an empty value stays, because clearing a field is how the UI expresses
 *     "delete this key" and the caller has already resolved it to a deletion.
 *
 * Fixing this client-side would mean five panels each learning to diff
 * against the inherited value; one server-side rule covers every panel, and
 * every future one.
 */
export async function pruneInheritedEchoes(
  name: string,
  before: Record<string, unknown>,
  next: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const inst = asConfig(
    (await getInstanceAddons()).find((r) => r.name === name)?.config,
  );
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    const echo =
      !(k in before) && isSet(v) && k in inst && sameValue(v, inst[k]);
    if (!echo) out[k] = v;
  }
  return out;
}

/** Structural equality, enough for config scalars, arrays and plain blobs. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Copy-on-write. Returns the id of the caller's own row for `name`,
 * creating an EMPTY one (enabled NULL = inherit, config NULL = inherit)
 * if they had none.
 *
 * Empty, not a copy: the new row must keep following the instance for
 * everything the user did not explicitly set. `kind` is the one field
 * carried across, because it is a fixed classification the UI switches on,
 * not configuration, and the column is NOT NULL.
 */
export async function materializeUserAddon(
  userId: string,
  name: string,
): Promise<string> {
  const [own] = await db
    .select({ id: addons.id })
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, name)))
    .orderBy(asc(addons.createdAt), asc(addons.id))
    .limit(1);
  if (own) return own.id;

  const inst = (await getInstanceAddons()).find((r) => r.name === name);
  const cat = catalogEntry(name);
  try {
    const [created] = await db
      .insert(addons)
      .values({
        userId,
        name,
        kind: inst?.kind ?? cat?.kind ?? "plugin",
        enabled: null,
        config: null,
      })
      .returning({ id: addons.id });
    return created.id;
  } catch (e) {
    // Lost a race against a concurrent request for the same user+name
    // (addons_user_name_unique). Re-read rather than fail the write.
    if (!/unique/i.test((e as Error).message)) throw e;
    const [again] = await db
      .select({ id: addons.id })
      .from(addons)
      .where(and(eq(addons.userId, userId), eq(addons.name, name)))
      .orderBy(asc(addons.createdAt), asc(addons.id))
      .limit(1);
    if (!again) throw e;
    return again.id;
  }
}

/**
 * Drop the caller's override for an add-on and go back to inheriting.
 * Returns false when they had nothing to drop.
 */
export async function dropUserAddonOverride(
  userId: string,
  name: string,
): Promise<boolean> {
  const rows = await db
    .delete(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, name)))
    .returning({ id: addons.id });
  return rows.length > 0;
}

/** Listing view of a resolved add-on: no secret, no half-megabyte cache. */
export function publicAddonView(a: ResolvedAddon) {
  const config: Record<string, unknown> = {};
  const configHas: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(a.config)) {
    if (SECRET_CONFIG_KEYS.includes(k)) {
      configHas[k] = isSet(v);
      continue;
    }
    if (BULKY_CONFIG_KEYS.includes(k)) {
      configHas[k] = isSet(v);
      continue;
    }
    config[k] = v;
  }
  return {
    id: a.id,
    ownRowId: a.ownRowId,
    userId: a.userId,
    name: a.name,
    kind: a.kind,
    description: a.description,
    version: a.version,
    enabled: a.enabled,
    config,
    configHas,
    inherited: a.inherited,
    inheritedConfigKeys: a.inheritedConfigKeys,
    /**
     * True when the caller's own row sits on TOP of an instance row of the
     * same name — the mirror of `overridesInstance` in `publicMcpView`, and
     * the only condition under which "Reset to instance settings" means
     * what it says.
     *
     * Without it the Add-ons page could only test `!inherited && ownRowId`,
     * which is also true for a row with NOTHING behind it (fresh install,
     * an ad-hoc add-on from POST /api/addons, an instance row an admin has
     * since deleted). There the button is a DELETE wearing a reset label:
     * it drops the one row that held the configuration.
     */
    overridesInstance: a.ownRowId !== null && a.instanceRowId !== null,
  };
}

// ── MCP servers: resolution ──────────────────────────────────────────────

/**
 * A server that is actually usable: every field the transport needs is
 * present. `McpServerRow` cannot promise that any more (0060 made
 * name/url/transport/auth_kind/enabled nullable so a user row can be a
 * partial override), so this is the type that crosses into mcp-client.ts
 * and mcp-oauth.ts. A row the resolver could not complete never gets one.
 */
export type ResolvedMcpServer = Omit<
  McpServerRow,
  "name" | "url" | "transport" | "authKind" | "enabled"
> & {
  name: string;
  url: string;
  transport: string;
  authKind: string;
  enabled: boolean;
  /** The caller's own row, if any. The ONLY id an OAuth write may target. */
  ownRowId: string | null;
  instanceRowId: string | null;
  /** True when the caller has no row of this slug. */
  inherited: boolean;
};

function resolveMcpPair(
  slug: string,
  own: McpServerRow | undefined,
  inst: McpServerRow | undefined,
): ResolvedMcpServer | null {
  const name = own?.name ?? inst?.name ?? null;
  const url = own?.url ?? inst?.url ?? null;
  const transport = own?.transport ?? inst?.transport ?? null;
  const authKind = own?.authKind ?? inst?.authKind ?? null;
  // An orphan: a partial user row whose instance row was deleted. Nothing
  // can complete it, so it is dropped rather than handed to `new URL()`.
  // Surfacing it as broken would be worse — it is invisible plumbing the
  // user never created on purpose.
  if (!name || !url || !transport || !authKind) return null;

  // Same rule as the add-on `bridgeToken`: a bearer header authenticates
  // against one host. A user who overrode `url` TO A DIFFERENT ADDRESS
  // gets no shared header; an override that repoints nothing does — the
  // edit modal submits the inherited url verbatim, so without that the
  // shared token vanished on the first Save. See sameTarget().
  const ownUrl = isSet(own?.url);
  const canInheritHostBound = !ownUrl || sameTarget(own?.url, inst?.url);

  return {
    id: own?.id ?? inst?.id ?? "",
    ownRowId: own?.id ?? null,
    instanceRowId: inst?.id ?? null,
    userId: own?.userId ?? null,
    name,
    slug,
    transport,
    url,
    authKind,
    authHeader: canInheritHostBound
      ? (own?.authHeader ?? inst?.authHeader ?? null)
      : (own?.authHeader ?? null),
    // A cached .well-known document is a property of the URL, and contains
    // no secret — shareable, and it saves every inheritor a discovery
    // round-trip. It follows the URL like everything else host-bound.
    oauthMetadata: canInheritHostBound
      ? (own?.oauthMetadata ?? inst?.oauthMetadata ?? null)
      : (own?.oauthMetadata ?? null),
    // ── THE BOUNDARY ── none of the six below ever reads the instance row.
    // Sharing them would give one user the third-party account of another;
    // see the header of drizzle/0060 and the `ownEngine` comment in
    // global-settings.ts.
    oauthClientId: own?.oauthClientId ?? null,
    oauthClientSecret: own?.oauthClientSecret ?? null,
    oauthAccessToken: own?.oauthAccessToken ?? null,
    oauthRefreshToken: own?.oauthRefreshToken ?? null,
    oauthExpiresAt: own?.oauthExpiresAt ?? null,
    oauthScopes: own?.oauthScopes ?? null,
    // Instance rows are NOT NULL on `enabled` (CHECK
    // mcp_servers_instance_complete), so `?? true` only fires for a user
    // row with no instance behind it — which is the pre-0060 column
    // default, preserved.
    enabled: own?.enabled ?? inst?.enabled ?? true,
    // The tools list is the output of a tools/list performed WITH some
    // credential, so it belongs to the (server, credential) pair. Shared
    // for bearer / none — identical for everyone, and reusing it spares
    // each user the synchronous first fetch on the chat path. Never shared
    // for oauth: providers scope the list to the authorizing account, so a
    // shared copy would advertise to B tools only A may call.
    toolsCache:
      own?.toolsCache ?? (authKind === "oauth" ? null : (inst?.toolsCache ?? null)),
    toolsCacheAt:
      own?.toolsCacheAt ??
      (authKind === "oauth" ? null : (inst?.toolsCacheAt ?? null)),
    // An inheritor sees the shared server's last failure ("the endpoint is
    // down" is a fact about the deployment). Their own row's error wins
    // when they have one.
    lastError: own?.lastError ?? (own ? null : (inst?.lastError ?? null)),
    createdAt: own?.createdAt ?? inst?.createdAt ?? new Date(),
    updatedAt: own?.updatedAt ?? inst?.updatedAt ?? new Date(),
    inherited: !own,
  };
}

/**
 * Every MCP server visible to one user, instance rows overridden by their
 * own. ONE query on the user's rows plus the cached instance list, so the
 * chat path pays what it paid before 0060.
 *
 * Deliberately unfiltered on `enabled`: the identity has to be resolved
 * BEFORE the switch is read. Filtering in SQL would drop a user row that
 * says `enabled = false` — the very mechanism by which someone opts out of
 * a shared server — leave the instance row's `true` standing, and keep the
 * tools exposed. Callers filter on `.enabled` of the resolved entry.
 */
export async function resolveMcpServersForUser(
  userId: string,
): Promise<ResolvedMcpServer[]> {
  const ownRows = await db
    .select()
    .from(mcpServers)
    .where(eq(mcpServers.userId, userId))
    .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id));
  const instRows = await getInstanceMcpServers();

  const ownBySlug = new Map<string, McpServerRow>();
  for (const r of ownRows) if (!ownBySlug.has(r.slug)) ownBySlug.set(r.slug, r);
  const instBySlug = new Map<string, McpServerRow>();
  for (const r of instRows) if (!instBySlug.has(r.slug)) instBySlug.set(r.slug, r);

  const slugs = new Set([...instBySlug.keys(), ...ownBySlug.keys()]);
  const out: ResolvedMcpServer[] = [];
  for (const slug of slugs) {
    const r = resolveMcpPair(slug, ownBySlug.get(slug), instBySlug.get(slug));
    if (r) out.push(r);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * One server by slug. The tool DEFINITION path (collectMcpTools) and the
 * tool EXECUTION path (executeMcpTool) must both come through here: two
 * independent queries were two chances to resolve differently, and with
 * instance rows in play a `limit(1)` with no ordering could have handed
 * the model the description of one row and Companion the credentials of
 * another.
 */
export async function resolveMcpServerBySlug(
  userId: string,
  slug: string,
): Promise<ResolvedMcpServer | null> {
  const [own] = await db
    .select()
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, userId), eq(mcpServers.slug, slug)))
    .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id))
    .limit(1);
  const inst = (await getInstanceMcpServers()).find((r) => r.slug === slug);
  if (!own && !inst) return null;
  return resolveMcpPair(slug, own, inst);
}

/**
 * One server addressed by row id — the shape the Settings routes use.
 * Accepts the caller's own row id OR an instance row id, and in both cases
 * answers with the fully resolved entry for that slug, so a PATCH on an
 * inherited card knows what it is patching.
 */
export async function resolveMcpServerById(
  userId: string,
  id: string,
): Promise<ResolvedMcpServer | null> {
  const [row] = await db
    .select({ slug: mcpServers.slug, userId: mcpServers.userId })
    .from(mcpServers)
    .where(eq(mcpServers.id, id))
    .limit(1);
  if (!row) return null;
  // Somebody else's personal row: not found, exactly as before 0060.
  if (row.userId !== null && row.userId !== userId) return null;
  return resolveMcpServerBySlug(userId, row.slug);
}

/**
 * Copy-on-write for MCP. Returns the id of the caller's own row for `slug`,
 * creating an EMPTY one if needed.
 *
 * Empty means name / transport / url / auth_kind / enabled all NULL: the
 * ghost keeps following the instance server. This is what the OAuth flow
 * materialises before writing a single token, and it is why those columns
 * had to become nullable — a ghost that copied the URL would go on using a
 * dead address with a live token the day the operator repointed the
 * instance row.
 */
export async function materializeUserMcpServer(
  userId: string,
  slug: string,
): Promise<string> {
  const [own] = await db
    .select({ id: mcpServers.id })
    .from(mcpServers)
    .where(and(eq(mcpServers.userId, userId), eq(mcpServers.slug, slug)))
    .orderBy(asc(mcpServers.createdAt), asc(mcpServers.id))
    .limit(1);
  if (own) return own.id;
  try {
    const [created] = await db
      .insert(mcpServers)
      .values({ userId, slug })
      .returning({ id: mcpServers.id });
    return created.id;
  } catch (e) {
    if (!/unique/i.test((e as Error).message)) throw e;
    const [again] = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.userId, userId), eq(mcpServers.slug, slug)))
      .limit(1);
    if (!again) throw e;
    return again.id;
  }
}

/**
 * Where a background state write (tools_cache / tools_cache_at /
 * last_error) belongs for this server, or null when it belongs nowhere.
 *
 * OAuth: the caller's own row only. The cache was fetched with their token
 * and the errors are theirs; with no own row there is no token either, so
 * there is nothing to persist and null is the honest answer.
 *
 * Bearer / none: the caller's row if they have one, otherwise the shared
 * instance row. Writing the shared cache from a user request is deliberate
 * — server/lib/tools.ts does a SYNCHRONOUS tools/list when the cache is
 * empty, so refusing to persist there would make every user of a shared
 * server pay a third-party round-trip on every chat turn.
 */
export function mcpStateTargetId(s: ResolvedMcpServer): string | null {
  if (s.authKind === "oauth") return s.ownRowId;
  return s.ownRowId ?? s.instanceRowId;
}

/**
 * Where a write that is unambiguously PERSONAL belongs — a failed tool
 * call, an OAuth token. Never the shared row, even for a bearer server:
 * one account's failed invocation has no business surfacing in another's
 * Settings page.
 */
export function mcpOwnWriteTargetId(s: ResolvedMcpServer): string | null {
  return s.ownRowId;
}

/** Listing view: no secret in clear, plus the inheritance flags. */
export function publicMcpView(s: ResolvedMcpServer) {
  return {
    id: s.id,
    ownRowId: s.ownRowId,
    name: s.name,
    slug: s.slug,
    transport: s.transport,
    url: s.url,
    authKind: s.authKind,
    hasAuthHeader: Boolean(s.authHeader),
    oauthConnected: Boolean(s.oauthAccessToken),
    oauthExpiresAt: s.oauthExpiresAt,
    oauthScopes: s.oauthScopes,
    enabled: s.enabled,
    toolsCount: Array.isArray(s.toolsCache) ? s.toolsCache.length : 0,
    toolsCacheAt: s.toolsCacheAt,
    lastError: s.lastError,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    /** True when this card comes from the instance, not the caller's row. */
    inherited: s.inherited,
    /**
     * True when the caller has a row of their own AND an instance row of
     * the same slug exists behind it. Deleting their row then means "go
     * back to the shared configuration", not "remove the server" — two
     * very different things behind one Delete button.
     */
    overridesInstance: s.ownRowId !== null && s.instanceRowId !== null,
    /**
     * True when the caller personally completed the OAuth dance. Distinct
     * from `inherited`: an instance row can declare an OAuth server that
     * this user has never authorized, and the UI has to offer them the
     * Connect button rather than pretend they are connected because
     * somebody else is.
     */
    oauthConnectedByMe: Boolean(s.oauthAccessToken),
  };
}
