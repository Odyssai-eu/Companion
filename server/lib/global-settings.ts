/**
 * Deployment-wide settings (singleton row id=1 in `global_settings`) and the
 * user ← instance resolution layer built on top of them.
 *
 * TWO THINGS LIVE HERE
 *
 * 1. The singleton itself: the company LightRAG URL (0051), since 0059 the
 *    INSTANCE CONNECTION SETTINGS — engine URL / token / mode / meta,
 *    LiteLLM URL / key / kill-switch, and the default model — and since
 *    0060 the instance TIMEZONE.
 *
 * 2. The resolver. A Companion deployment has ONE engine, so that config is
 *    infrastructure, not a personal preference. `users` keeps columns of the
 *    same nine names but they are now nullable OVERRIDES, and everything
 *    reads through `resolveUserSettings()`:
 *
 *        user.X  ??  instance.X  ??  env (LiteLLM only)
 *
 *    A brand-new account therefore works immediately with zero setup, and an
 *    admin repointing the gateway moves every inheritor at once. Nothing is
 *    ever copied onto a user row — a snapshot would drift the moment the
 *    instance changed, and would duplicate the token N times.
 *
 * EMPTY STRING IS "UNSET". The settings forms submit "" when a field is
 * cleared, and "" is not a usable URL / model id / token anywhere in the
 * chain — so `pick()` skips it exactly like NULL. Without that, clearing a
 * field in the UI would pin the user to a broken empty override instead of
 * dropping them back onto the instance value.
 *
 * CACHING. The instance row is read on the chat hot path, so it is cached
 * for 30 s and invalidated synchronously on every write that goes through
 * this module. User rows are NOT cached here: callers already select them
 * (chat.ts locks the row per turn anyway), so resolution adds no query —
 * and a user write is visible on the next read with no invalidation dance.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/index";
import { globalSettings, users } from "../db/schema";

const CACHE_TTL_MS = 30_000;

export type ProviderMode = "gateway" | "hybrid" | "legacy";

/** The connection block, as stored on the instance singleton. */
export type InstanceSettings = {
  engineUrl: string | null;
  engineToken: string | null;
  engineMode: ProviderMode;
  engineMeta: Record<string, unknown> | null;
  litellmUrl: string | null;
  litellmApiKey: string | null;
  litellmDisabled: boolean;
  defaultModel: string | null;
  /**
   * IANA zone for the time tags injected into every chat message (0060).
   * NOT NULL in the database: server/lib/timetag.ts hands this straight to
   * Intl.DateTimeFormat, which throws RangeError on "" and quietly uses the
   * container's own zone on undefined — so the chain has to end on a real
   * value, exactly like engineMode.
   */
  timezone: string;
  companyRagUrl: string;
};

/**
 * A user row's overrides. Every field optional so any partial `select()`
 * can be passed straight in — the resolver treats a missing key exactly
 * like NULL, i.e. "inherit".
 */
export type UserConnectionOverrides = {
  engineUrl?: string | null;
  engineToken?: string | null;
  engineMode?: string | null;
  engineMeta?: Record<string, unknown> | null;
  litellmUrl?: string | null;
  litellmApiKey?: string | null;
  litellmDisabled?: boolean | null;
  defaultModel?: string | null;
  timezone?: string | null;
};

/** Which fields came from the instance rather than the user's own row. */
export type InheritedFlags = Record<keyof UserConnectionOverrides, boolean>;

/** Effective connection settings for one user. Always fully resolved. */
export type ResolvedConnection = {
  engineUrl: string | null;
  engineToken: string | null;
  engineMode: ProviderMode;
  engineMeta: Record<string, unknown> | null;
  litellmUrl: string | null;
  litellmApiKey: string | null;
  litellmDisabled: boolean;
  defaultModel: string | null;
  timezone: string;
  /** True per field when the value came from `global_settings`. */
  inherited: InheritedFlags;
};

/**
 * The nine inherited columns, ready to splat into a `db.select({...})`.
 * Call sites that need extra columns spread this first:
 *
 *     .select({ ...CONNECTION_COLUMNS, debugVerbose: users.debugVerbose })
 *
 * Keeping the list in one place is what stops a call site from silently
 * selecting eight of the nine and resolving a hole.
 *
 * (`timezone` joined the list in 0060 and this comment used to use it as
 * the example of a column that did NOT belong here. It does now: the whole
 * deployment sits in one place, and a fresh account that reads "UTC"
 * because nobody typed a zone yet is the same class of bug 0059 fixed for
 * the engine URL. Named CONNECTION_COLUMNS still, because renaming it
 * would touch every call site for no behavioural gain.)
 */
export const CONNECTION_COLUMNS = {
  engineUrl: users.engineUrl,
  engineToken: users.engineToken,
  engineMode: users.engineMode,
  engineMeta: users.engineMeta,
  litellmUrl: users.litellmUrl,
  litellmApiKey: users.litellmApiKey,
  litellmDisabled: users.litellmDisabled,
  defaultModel: users.defaultModel,
  timezone: users.timezone,
} as const;

// ── Cache ────────────────────────────────────────────────────────────────

let cache: { row: InstanceSettings; at: number } | null = null;

/** Drop the memoised singleton. Called by every writer in this module. */
export function invalidateInstanceSettings(): void {
  cache = null;
}

function trimUrl(s: string): string {
  return s.replace(/\/+$/, "");
}

/** First value that is neither null/undefined nor an empty/blank string. */
function pick(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const t = v.trim();
    if (t.length > 0) return t;
  }
  return null;
}

/** Same, then strip trailing slashes so callers can append /v1/... safely. */
function pickUrl(...vals: Array<string | null | undefined>): string | null {
  const v = pick(...vals);
  return v === null ? null : trimUrl(v);
}

function asMode(raw: string | null | undefined): ProviderMode | null {
  return raw === "gateway" || raw === "hybrid" || raw === "legacy" ? raw : null;
}

const SINGLETON_COLUMNS = {
  engineUrl: globalSettings.engineUrl,
  engineToken: globalSettings.engineToken,
  engineMode: globalSettings.engineMode,
  engineMeta: globalSettings.engineMeta,
  litellmUrl: globalSettings.litellmUrl,
  litellmApiKey: globalSettings.litellmApiKey,
  litellmDisabled: globalSettings.litellmDisabled,
  defaultModel: globalSettings.defaultModel,
  timezone: globalSettings.timezone,
  companyRagUrl: globalSettings.companyRagUrl,
} as const;

/** Read-through load of the whole singleton, seeding the row if absent. */
async function load(): Promise<InstanceSettings> {
  let [row] = await db
    .select(SINGLETON_COLUMNS)
    .from(globalSettings)
    .where(eq(globalSettings.id, 1))
    .limit(1);
  if (!row) {
    await db.insert(globalSettings).values({ id: 1 }).onConflictDoNothing();
    [row] = await db
      .select(SINGLETON_COLUMNS)
      .from(globalSettings)
      .where(eq(globalSettings.id, 1))
      .limit(1);
  }
  return {
    engineUrl: pickUrl(row?.engineUrl),
    engineToken: pick(row?.engineToken),
    engineMode: asMode(row?.engineMode) ?? "legacy",
    engineMeta: row?.engineMeta ?? null,
    litellmUrl: pickUrl(row?.litellmUrl),
    litellmApiKey: pick(row?.litellmApiKey),
    litellmDisabled: row?.litellmDisabled ?? false,
    defaultModel: pick(row?.defaultModel),
    // The literal is the last link of a chain that must not end on null,
    // and it is the same value the column defaults to — it fires only on a
    // singleton so damaged the row itself is missing.
    timezone: pick(row?.timezone) ?? "UTC",
    companyRagUrl: trimUrl(row?.companyRagUrl ?? ""),
  };
}

/**
 * The instance connection block + company RAG URL. Memoised for 30 s —
 * this sits on the chat hot path, so it must not cost a round-trip per
 * message.
 */
export async function getInstanceSettings(): Promise<InstanceSettings> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.row;
  const row = await load();
  cache = { row, at: now };
  return row;
}

// ── Resolution ───────────────────────────────────────────────────────────

/**
 * Merge one user's overrides onto the instance settings.
 *
 * Field-by-field `user.X ?? instance.X`, including the token: the instance
 * token is the shared one, and a user who points at their own engine writes
 * their own. `engineMode` and `litellmDisabled` always land on a real value
 * because the instance columns are NOT NULL.
 *
 * LiteLLM URL / key keep the historical env fallback (`LITELLM_URL`,
 * `LITELLM_API_KEY`) as the LAST link, after the instance row — a DB value
 * an admin can see and edit should beat a container env var nobody
 * remembers setting. Nothing is hardcoded at any level of the chain.
 */
export async function resolveUserSettings(
  user: UserConnectionOverrides | null | undefined,
): Promise<ResolvedConnection> {
  const inst = await getInstanceSettings();
  const u = user ?? {};

  const engineUrl = pickUrl(u.engineUrl);
  const engineToken = pick(u.engineToken);
  const userMode = asMode(u.engineMode);
  const litellmUrl = pickUrl(u.litellmUrl);
  const litellmApiKey = pick(u.litellmApiKey);
  const defaultModel = pick(u.defaultModel);
  const timezone = pick(u.timezone);
  const litellmDisabled =
    u.litellmDisabled === null || u.litellmDisabled === undefined
      ? null
      : u.litellmDisabled;
  // engineMeta is a probe cache, not a setting: it only means anything next
  // to the engine it describes. Follow whichever engine URL won, so we never
  // render the instance engine's version card for a user's own engine (or
  // the reverse).
  const ownEngine = engineUrl !== null;

  return {
    engineUrl: engineUrl ?? inst.engineUrl,
    // The token is a CREDENTIAL FOR ONE HOST, so it follows the engine URL
    // exactly like engineMeta does — it is not an independent field.
    //
    // Inheriting it field-by-field would hand the deployment's shared crew
    // token to whatever URL the user put in their own override: any account
    // (and any guest, since /api/inference/* accepts guest tokens under the
    // host's user id) could PATCH engineUrl to a server they control and
    // receive `Authorization: Bearer <instance token>` on the next message.
    // A user pointing at their own engine authenticates with their own
    // token — the pair flow writes url + token together — or with none.
    //
    // A token override WITHOUT a url override still applies: that is a
    // personal crew token against the shared instance engine, same host.
    engineToken: ownEngine ? engineToken : (engineToken ?? inst.engineToken),
    engineMode: userMode ?? inst.engineMode,
    engineMeta: ownEngine ? (u.engineMeta ?? null) : inst.engineMeta,
    litellmUrl:
      litellmUrl ?? inst.litellmUrl ?? pickUrl(process.env.LITELLM_URL),
    litellmApiKey:
      litellmApiKey ?? inst.litellmApiKey ?? pick(process.env.LITELLM_API_KEY),
    litellmDisabled: litellmDisabled ?? inst.litellmDisabled,
    defaultModel: defaultModel ?? inst.defaultModel,
    // Plain `user ?? instance`, no pairing: a timezone is neither a secret
    // nor bound to a host, so none of the engineToken reasoning applies.
    timezone: timezone ?? inst.timezone,
    inherited: {
      engineUrl: engineUrl === null,
      // Only inherited when the engine itself is (see the token comment
      // above): with a personal engine, an absent token is "no auth", not
      // "the instance's auth".
      engineToken: !ownEngine && engineToken === null,
      engineMode: userMode === null,
      engineMeta: !ownEngine,
      litellmUrl: litellmUrl === null,
      litellmApiKey: litellmApiKey === null,
      litellmDisabled: litellmDisabled === null,
      defaultModel: defaultModel === null,
      timezone: timezone === null,
    },
  };
}

/**
 * Same, straight from a user id. For call sites that don't already hold a
 * user row — one indexed primary-key select plus the cached instance.
 * Returns null when the user doesn't exist so callers can 404.
 */
export async function resolveUserSettingsById(
  userId: string,
): Promise<ResolvedConnection | null> {
  const [row] = await db
    .select(CONNECTION_COLUMNS)
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return resolveUserSettings(row);
}

// ── Derived routing helpers ──────────────────────────────────────────────
// chat.ts, models.ts, conversations.ts (prewarm) and help.ts each derived the
// same mode + upstream target from the same four fields. Four copies of one
// rule is three chances to drift, and 0059 had to touch all of them — so the
// rule lives here now.

/**
 * The mode actually used for this request.
 *
 * `litellmDisabled` with an engine present forces gateway regardless of the
 * stored mode: the user (or the instance) said "go direct", and hybrid would
 * silently route inference back through the rail they turned off.
 */
export function effectiveProviderMode(
  s: Pick<ResolvedConnection, "engineUrl" | "engineMode" | "litellmDisabled">,
): ProviderMode {
  if (s.litellmDisabled && s.engineUrl) return "gateway";
  return s.engineMode;
}

/**
 * True when there is no rail left: LiteLLM switched off and no engine to
 * fall back to. Callers turn this into a 503 / a skip, each with its own
 * wording.
 */
export function hasNoProvider(
  s: Pick<ResolvedConnection, "engineUrl" | "engineMode" | "litellmDisabled">,
): boolean {
  return effectiveProviderMode(s) === "legacy" && s.litellmDisabled;
}

/** Upstream base URL + bearer for the given mode. */
export function providerTarget(
  s: ResolvedConnection,
  mode: ProviderMode = effectiveProviderMode(s),
): { baseUrl: string; apiKey: string | null } {
  if (mode === "gateway" && s.engineUrl) {
    return { baseUrl: s.engineUrl, apiKey: s.engineToken };
  }
  return { baseUrl: s.litellmUrl ?? "", apiKey: s.litellmApiKey };
}

// ── Writes ───────────────────────────────────────────────────────────────

/** The company LightRAG URL (standard API, shared company graph). "" = off. */
export async function getCompanyRagUrl(): Promise<string> {
  return (await getInstanceSettings()).companyRagUrl;
}

export async function setCompanyRagUrl(url: string): Promise<void> {
  const clean = trimUrl(url);
  await db
    .insert(globalSettings)
    .values({ id: 1, companyRagUrl: clean, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: globalSettings.id,
      set: { companyRagUrl: clean, updatedAt: new Date() },
    });
  invalidateInstanceSettings();
}

/** Fields an admin may write on the instance connection block. */
export type InstanceConnectionPatch = Partial<{
  engineUrl: string | null;
  engineToken: string | null;
  engineMode: ProviderMode;
  engineMeta: Record<string, unknown> | null;
  litellmUrl: string | null;
  litellmApiKey: string | null;
  litellmDisabled: boolean;
  defaultModel: string | null;
  timezone: string;
}>;

/**
 * Write part of the instance connection block. Only the keys present in
 * `patch` are touched — the caller decides what "unset" means for its own
 * surface (the admin PUT clears the fields it owns by passing null).
 * Normalises "" to NULL so a cleared admin field genuinely unsets instead of
 * storing a blank the resolver would have to skip anyway.
 */
export async function setInstanceSettings(
  patch: InstanceConnectionPatch,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };

  if (patch.engineUrl !== undefined) set.engineUrl = pickUrl(patch.engineUrl);
  if (patch.engineToken !== undefined) set.engineToken = pick(patch.engineToken);
  if (patch.engineMode !== undefined) set.engineMode = patch.engineMode;
  if (patch.engineMeta !== undefined) set.engineMeta = patch.engineMeta;
  if (patch.litellmUrl !== undefined) set.litellmUrl = pickUrl(patch.litellmUrl);
  if (patch.litellmApiKey !== undefined) {
    set.litellmApiKey = pick(patch.litellmApiKey);
  }
  if (patch.litellmDisabled !== undefined) {
    set.litellmDisabled = patch.litellmDisabled;
  }
  if (patch.defaultModel !== undefined) {
    set.defaultModel = pick(patch.defaultModel);
  }
  // NOT NULL column — a blank submission means "leave it alone", never
  // "store an empty zone Intl would throw on".
  if (patch.timezone !== undefined) {
    const tz = pick(patch.timezone);
    if (tz !== null) set.timezone = tz;
  }

  await db
    .insert(globalSettings)
    .values({ id: 1, ...set })
    .onConflictDoUpdate({ target: globalSettings.id, set });
  invalidateInstanceSettings();
}
