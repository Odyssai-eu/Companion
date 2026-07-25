/**
 * Inference settings + last-interaction read.
 *
 * GET   /api/inference/settings           → effective values + overrides + instance
 * PATCH /api/inference/settings           → update any subset of the user's own
 * POST  /api/inference/reset-to-instance  → drop overrides, fall back to shared
 * GET   /api/inference/status             → last_interaction_at + server time
 *
 * THREE VIEWS OF THE SAME SETTINGS (0059)
 * The connection fields are per-user overrides on top of `global_settings`,
 * so this endpoint answers three different questions and must not conflate
 * them:
 *
 *   top level  → EFFECTIVE. What the chat will actually use. Everything that
 *                just wants to work (useChat picking a default model, the
 *                LiteLLM on/off pill) reads these.
 *   overrides  → the user's OWN row, null where they inherit. The settings
 *                FORMS bind to these — binding a form to the effective value
 *                would re-save the inherited value as a personal override on
 *                the next click and silently snapshot the instance config,
 *                which is exactly the drift inheritance exists to avoid.
 *   instance   → the shared defaults, for "inherited from the instance: X"
 *                hints and placeholders.
 *
 * Secrets are never returned in clear in any of the three — only
 * `has…Token` / `has…Key` booleans, same as before 0059.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { users } from "../db/schema";
import {
  CONNECTION_COLUMNS,
  getInstanceSettings,
  resolveUserSettings,
} from "../lib/global-settings";
import { invalidateEngineCache } from "../lib/odyssai-capabilities";
import { probeEngine } from "../lib/odyssai-probe";

type Env = { Variables: { userId: string } };
const inferenceRoute = new Hono<Env>();

/** The two inference modes (0058). 'auto' = no picker, the Auto Router
 *  add-on chooses the model per message. 'expert' = full catalog picker. */
export type InferenceMode = "auto" | "expert";

/**
 * Safety belt for the read path.
 *
 * 0058 backfills every 'easy' / 'advanced' row to 'auto', and the PATCH
 * enum below only accepts the two live values — so in a correctly migrated
 * database this never fires. It exists for the rows that migration can't
 * reach: a restored-from-backup user row, a replica that lagged the deploy,
 * a row written by hand. Those users get the behaviour 'auto' inherited
 * from 'easy' (no picker, router decides) instead of a mode string the
 * client doesn't understand, which would leave the chat with no model.
 *
 * Deliberately read-only — we don't rewrite the row here. The next save
 * from the Settings page normalises it for good.
 *
 * Anything we don't recognise at all falls back to 'expert' (the column
 * default), not 'auto': an unknown string is a bug, and the failure mode of
 * 'expert' is a visible picker, while the failure mode of 'auto' is a chat
 * with no picker and possibly no router — strictly worse.
 */
function normalizeInferenceMode(raw: string | null | undefined): InferenceMode {
  if (raw === "auto") return "auto";
  // Legacy values retired by 0058. 'easy' hid the picker and deferred to the
  // router; 'advanced' offered 4 curated slots. Both land on 'auto'.
  if (raw === "easy" || raw === "advanced") return "auto";
  return "expert";
}

inferenceRoute.get("/settings", async (c) => {
  const userId = c.get("userId");
  const [u] = await db
    .select({
      ...CONNECTION_COLUMNS,
      timezone: users.timezone,
      inferenceMode: users.inferenceMode,
      easyModel: users.easyModel,
      namedModels: users.namedModels,
      showMetrics: users.showMetrics,
      debugVerbose: users.debugVerbose,
      hiddenModels: users.hiddenModels,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return c.json({ error: "user_not_found" }, 404);

  const eff = await resolveUserSettings(u);
  const inst = await getInstanceSettings();

  return c.json({
    // ── EFFECTIVE (what the chat uses) ────────────────────────────────
    defaultModel: eff.defaultModel,
    litellmUrl: eff.litellmUrl,
    hasApiKey: Boolean(eff.litellmApiKey),
    engineUrl: eff.engineUrl,
    hasEngineToken: Boolean(eff.engineToken),
    engineMeta: eff.engineMeta,
    engineMode: eff.engineMode,
    litellmDisabled: eff.litellmDisabled,

    // ── Per-user, non-inherited ───────────────────────────────────────
    timezone: u.timezone,
    inferenceMode: normalizeInferenceMode(u.inferenceMode),
    showMetrics: u.showMetrics,
    debugVerbose: u.debugVerbose,
    hiddenModels: u.hiddenModels ?? [],

    // ── The user's OWN overrides — what the forms edit ────────────────
    // null / false = "inherited". A form seeded from here and saved back
    // leaves the inheritance intact.
    overrides: {
      defaultModel: u.defaultModel,
      litellmUrl: u.litellmUrl,
      hasApiKey: Boolean(u.litellmApiKey),
      litellmDisabled: u.litellmDisabled,
      engineUrl: u.engineUrl,
      hasEngineToken: Boolean(u.engineToken),
      engineMode: u.engineMode as "gateway" | "hybrid" | "legacy" | null,
    },
    /** Per field: true when the effective value came from the instance. */
    inherited: eff.inherited,

    // ── The instance defaults — placeholders / "inherited: X" hints ───
    instance: {
      defaultModel: inst.defaultModel,
      litellmUrl: inst.litellmUrl,
      hasApiKey: Boolean(inst.litellmApiKey),
      litellmDisabled: inst.litellmDisabled,
      engineUrl: inst.engineUrl,
      hasEngineToken: Boolean(inst.engineToken),
      engineMode: inst.engineMode,
    },

    // Deployment env fallback, last link of the chain. Kept for the
    // LiteLLM add-on's "Default: …" hint.
    envDefaultUrl: process.env.LITELLM_URL ?? "",

    // DEPRECATED (0058) — no UI reads these. Still returned so a client
    // bundle cached from before the deploy doesn't choke on missing keys.
    easyModel: u.easyModel,
    namedModels: u.namedModels ?? {},
  });
});

/** DEPRECATED (0058) — the retired advanced mode's 4 slots. Kept only so
 *  an in-flight PATCH from a pre-deploy client bundle still validates. */
const namedModelsSchema = z
  .object({
    conversation: z.string().max(200).optional(),
    analyse: z.string().max(200).optional(),
    engineer: z.string().max(200).optional(),
    expert: z.string().max(200).optional(),
  })
  // .nullish() accepts both `undefined` (field omitted) and `null` (field
  // set to null) — the React client sends a full PATCH body where unset
  // fields come over as null, so .optional() rejected toggles like
  // "Show metrics" with 400 'namedModels: Expected object, received null'.
  // The handler at line ~102 already coerces `null` to a SQL NULL.
  .nullish();

const patchSchema = z.object({
  defaultModel: z.string().max(200).nullish(),
  litellmUrl: z.string().url().max(400).nullish(),
  litellmApiKey: z.string().max(400).nullish(),
  timezone: z.string().min(1).max(80).optional(),
  // Write side accepts ONLY the two live modes (0058). Legacy 'easy' /
  // 'advanced' are rejected on purpose — they're read-mapped to 'auto' by
  // normalizeInferenceMode() above, so no client has a reason to send them.
  inferenceMode: z.enum(["auto", "expert"]).optional(),
  // DEPRECATED (0058) — no UI writes these anymore. The keys stay accepted
  // so an old cached client bundle mid-deploy doesn't 400 its whole PATCH.
  easyModel: z.string().max(200).nullish(),
  namedModels: namedModelsSchema,
  engineUrl: z.string().url().max(400).nullish(),
  engineToken: z.string().max(400).nullish(),
  // 0059: both accept null now — null is "clear my override, inherit the
  // instance value" and is what the "Reset to instance settings" controls
  // send. Before 0059 they were non-nullable columns, so `.optional()` was
  // the only shape that made sense.
  engineMode: z.enum(["gateway", "hybrid", "legacy"]).nullish(),
  litellmDisabled: z.boolean().nullish(),
  showMetrics: z.boolean().optional(),
  debugVerbose: z.boolean().optional(),
  // Picker hide list — full replacement on PATCH. Null clears it.
  hiddenModels: z.array(z.string().max(200)).max(200).nullish(),
});

inferenceRoute.patch("/settings", zValidator("json", patchSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const patch: Record<string, unknown> = {};
  if (data.defaultModel !== undefined) patch.defaultModel = data.defaultModel ?? null;
  if (data.litellmUrl !== undefined) patch.litellmUrl = data.litellmUrl ?? null;
  if (data.litellmApiKey !== undefined) patch.litellmApiKey = data.litellmApiKey ?? null;
  if (data.timezone !== undefined) patch.timezone = data.timezone;
  if (data.inferenceMode !== undefined) patch.inferenceMode = data.inferenceMode;
  if (data.easyModel !== undefined) patch.easyModel = data.easyModel ?? null;
  if (data.namedModels !== undefined) patch.namedModels = data.namedModels ?? null;
  if (data.engineUrl !== undefined) {
    patch.engineUrl = data.engineUrl ?? null;
    // Drop the cache when the URL changes so the next /api/models reads
    // fresh caps from the new target instead of the stale one.
    invalidateEngineCache();
  }
  if (data.engineToken !== undefined) {
    patch.engineToken = data.engineToken ?? null;
  }
  if (data.engineMode !== undefined) {
    patch.engineMode = data.engineMode ?? null;
  }
  if (data.litellmDisabled !== undefined) {
    patch.litellmDisabled = data.litellmDisabled ?? null;
  }
  if (data.showMetrics !== undefined) {
    patch.showMetrics = data.showMetrics;
  }
  if (data.debugVerbose !== undefined) {
    patch.debugVerbose = data.debugVerbose;
  }
  if (data.hiddenModels !== undefined) {
    // null / empty array both mean "no hide list" — store as null so the
    // default "show everything" reads naturally.
    const list = data.hiddenModels;
    patch.hiddenModels = list && list.length > 0 ? list : null;
  }
  if (Object.keys(patch).length === 0) {
    return c.json({ error: "no_fields_to_update" }, 400);
  }
  await db.update(users).set(patch).where(eq(users.id, userId));
  // No cache to invalidate: only the INSTANCE row is memoised
  // (server/lib/global-settings.ts). User rows are read fresh on every
  // resolution, so this write is visible immediately.
  return c.json({ ok: true });
});

/**
 * POST /api/inference/reset-to-instance — "Reset to instance settings".
 *
 * Drops the user's overrides so the shared instance values take over again.
 * Scoped, because the three groups are independent in the UI:
 *
 *   engine       → engineUrl / engineToken / engineMode / engineMeta. Nulled
 *                  as a set: those four describe ONE engine, and keeping any
 *                  of them (a token for an engine you no longer point at, a
 *                  mode derived from its feature list) is how you get a
 *                  half-configured account that fails in a confusing way.
 *   litellm      → litellmUrl / litellmApiKey / litellmDisabled.
 *   defaultModel → just that.
 *
 * This is a distinct endpoint rather than a PATCH of nulls because
 * engine_meta is not part of the PATCH surface (it's a probe cache, never
 * user-editable) and would otherwise be left behind, describing an engine
 * the user no longer uses.
 */
const resetSchema = z.object({
  scope: z.enum(["engine", "litellm", "defaultModel", "all"]),
});

inferenceRoute.post(
  "/reset-to-instance",
  zValidator("json", resetSchema),
  async (c) => {
    const userId = c.get("userId");
    const { scope } = c.req.valid("json");
    const patch: Record<string, unknown> = {};

    if (scope === "engine" || scope === "all") {
      patch.engineUrl = null;
      patch.engineToken = null;
      patch.engineMode = null;
      patch.engineMeta = null;
    }
    if (scope === "litellm" || scope === "all") {
      patch.litellmUrl = null;
      patch.litellmApiKey = null;
      patch.litellmDisabled = null;
    }
    if (scope === "defaultModel" || scope === "all") {
      patch.defaultModel = null;
    }

    await db.update(users).set(patch).where(eq(users.id, userId));
    // The caps cache is keyed by engine URL; the user is moving to a
    // different one, so drop it wholesale.
    invalidateEngineCache();
    return c.json({ ok: true, scope });
  },
);

/**
 * Probe an engine URL on demand. Drives the "Test" button in Settings →
 * Inference. Body is { url, token? } — we don't read the user's saved
 * fields because the user is editing them in the form and may not have
 * saved yet.
 *
 * On a successful probe of an Odyssai engine, the engine_meta column is
 * cached so the UI can render version / features without re-probing.
 */
const probeSchema = z.object({
  url: z.string().url().max(400),
  token: z.string().max(400).optional(),
});

inferenceRoute.post(
  "/engine/probe",
  zValidator("json", probeSchema),
  async (c) => {
    const userId = c.get("userId");
    const { url, token } = c.req.valid("json");
    const result = await probeEngine(url, token);
    // Persist the meta snapshot only when it's an Odyssai engine (no
    // value in caching a 404 / generic OpenAI response). Async, no
    // await — the response is the source of truth for the UI.
    if (result.isOdyssai && result.meta) {
      void db
        .update(users)
        .set({
          engineMeta: result.meta as unknown as Record<string, unknown>,
        })
        .where(eq(users.id, userId))
        .catch(() => undefined);
    }
    // Caps cache may hold stale data from the previous URL — flush so
    // the next /api/models fetches fresh.
    invalidateEngineCache(url);
    return c.json(result);
  },
);

inferenceRoute.get("/status", async (c) => {
  const userId = c.get("userId");
  const [u] = await db
    .select({
      lastInteractionAt: users.lastInteractionAt,
      timezone: users.timezone,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u) return c.json({ error: "user_not_found" }, 404);
  return c.json({
    lastInteractionAt: u.lastInteractionAt,
    serverTime: new Date().toISOString(),
    timezone: u.timezone,
  });
});

export default inferenceRoute;
