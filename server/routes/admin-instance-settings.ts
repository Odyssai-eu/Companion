/**
 * Admin — INSTANCE connection settings (0059).
 *
 *   GET  /api/admin/instance-settings          read the shared config
 *   PUT  /api/admin/instance-settings          replace it
 *   POST /api/admin/instance-settings/publish  lift the caller's own working
 *                                              config onto the instance
 *
 * WHY THIS EXISTS
 * The gateway, its token, the LiteLLM rail and the default model describe
 * the deployment, not a person — everyone on a Companion install talks to
 * the same engine. Before 0059 they lived only on `users`, so a new account
 * arrived on an app with no gateway and no models until someone paired it by
 * hand. They now live on `global_settings` and every user inherits them;
 * `users` keeps nullable overrides for the rare case of a personal engine.
 *
 * This route is the admin's side of that: edit the shared values once and
 * every inheritor follows on their next request (30 s cache at worst).
 *
 * ACCESS. `requireRole("admin")`, the same guard as admin-users.ts /
 * admin-settings.ts. No new role — 'admin' already means "operator of this
 * instance".
 *
 * SECRETS. Neither the crew token nor the LiteLLM key is ever returned: GET
 * answers with `hasEngineToken` / `hasLitellmApiKey` booleans, the same
 * masking /api/inference/settings has always used. Consequently they cannot
 * be round-tripped through a form, so PUT treats them as write-only: omit
 * the key to keep the stored secret, send null to clear it, send a string to
 * replace it.
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import {
  getInstanceSettings,
  resolveUserSettingsById,
  setInstanceSettings,
} from "../lib/global-settings";
import { invalidateEngineCache } from "../lib/odyssai-capabilities";
import { requireRole } from "../middleware/auth";

type Env = { Variables: { userId: string } };
const adminInstanceSettingsRoute = new Hono<Env>();
adminInstanceSettingsRoute.use("*", requireRole("admin"));

/** Public shape — secrets reduced to booleans. */
async function publicView() {
  const s = await getInstanceSettings();
  return {
    engineUrl: s.engineUrl,
    hasEngineToken: Boolean(s.engineToken),
    engineMode: s.engineMode,
    engineMeta: s.engineMeta,
    litellmUrl: s.litellmUrl,
    hasLitellmApiKey: Boolean(s.litellmApiKey),
    litellmDisabled: s.litellmDisabled,
    defaultModel: s.defaultModel,
  };
}

adminInstanceSettingsRoute.get("/", async (c) => {
  return c.json(await publicView());
});

/**
 * An http(s) URL, or empty → null. `z.string().url()` rejects "", which is
 * exactly what a cleared input sends, so the empty case is normalised before
 * validation rather than 400'ing the whole body.
 */
const urlOrNull = z
  .string()
  .max(400)
  .nullish()
  .transform((v) => {
    const t = (v ?? "").trim();
    return t.length === 0 ? null : t;
  })
  .refine((v) => v === null || /^https?:\/\/\S+$/.test(v), {
    message: "must be an http(s) URL or empty",
  });

const textOrNull = z
  .string()
  .max(400)
  .nullish()
  .transform((v) => {
    const t = (v ?? "").trim();
    return t.length === 0 ? null : t;
  });

const putSchema = z.object({
  engineUrl: urlOrNull,
  engineMode: z.enum(["gateway", "hybrid", "legacy"]),
  litellmUrl: urlOrNull,
  litellmDisabled: z.boolean(),
  defaultModel: textOrNull,
  // Write-only secrets — see the header comment. `.optional()` on the OUTER
  // schema is what distinguishes "not sent" (keep) from "sent as null"
  // (clear).
  engineToken: textOrNull.optional(),
  litellmApiKey: textOrNull.optional(),
});

adminInstanceSettingsRoute.put(
  "/",
  zValidator("json", putSchema),
  async (c) => {
    const data = c.req.valid("json");
    const before = await getInstanceSettings();
    // Compare the same normalised form the store keeps (trailing slashes
    // stripped), or "http://host:8000/" would read as a change every save
    // and keep clearing engine_meta for nothing.
    const nextEngineUrl = data.engineUrl?.replace(/\/+$/, "") ?? null;

    await setInstanceSettings({
      engineUrl: data.engineUrl,
      engineMode: data.engineMode,
      litellmUrl: data.litellmUrl,
      litellmDisabled: data.litellmDisabled,
      defaultModel: data.defaultModel,
      ...(data.engineToken !== undefined
        ? { engineToken: data.engineToken }
        : {}),
      ...(data.litellmApiKey !== undefined
        ? { litellmApiKey: data.litellmApiKey }
        : {}),
      // engine_meta is a cache of the engine's .well-known, so it is only
      // valid for the URL it was probed from. Repointing the instance
      // invalidates it; keeping it would show the previous engine's vendor
      // and version on the new one's card.
      ...(nextEngineUrl !== before.engineUrl ? { engineMeta: null } : {}),
    });

    // Per-model capability cache is keyed by engine URL — drop it so the
    // next /api/models re-probes the new target instead of serving the old
    // engine's caps to everyone who just inherited the change.
    invalidateEngineCache();

    return c.json({ ok: true, ...(await publicView()) });
  },
);

/**
 * POST /publish — "Publish my settings as instance settings".
 *
 * The one button the operator actually wants: she pairs an engine from her
 * own Settings page as usual, checks it works, then lifts that exact config
 * to the instance so every user inherits it. One action for the whole
 * deployment, not one per user.
 *
 * Copies the caller's EFFECTIVE values, not her raw row: a field she already
 * inherits publishes as the value she is actually using, which makes the
 * button idempotent (publishing twice changes nothing) instead of blanking
 * the instance with the nulls of an inheriting admin.
 *
 * Note this is a copy — the only one in the design, and a deliberate one:
 * it is a one-shot admin action on the SHARED row, not a per-user snapshot.
 * Her own row keeps whatever overrides it had; they now resolve to the same
 * values, and she can drop them from Settings → Inference to become a plain
 * inheritor.
 */
adminInstanceSettingsRoute.post("/publish", async (c) => {
  const userId = c.get("userId");
  const mine = await resolveUserSettingsById(userId);
  if (!mine) return c.json({ error: "user_not_found" }, 404);

  await setInstanceSettings({
    engineUrl: mine.engineUrl,
    engineToken: mine.engineToken,
    engineMode: mine.engineMode,
    engineMeta: mine.engineMeta,
    litellmUrl: mine.litellmUrl,
    litellmApiKey: mine.litellmApiKey,
    litellmDisabled: mine.litellmDisabled,
    defaultModel: mine.defaultModel,
  });
  invalidateEngineCache();

  return c.json({ ok: true, ...(await publicView()) });
});

export default adminInstanceSettingsRoute;
