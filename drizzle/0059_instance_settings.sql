-- 0059_instance_settings.sql
-- 2026-07-25: the connection config becomes INSTANCE settings, inherited
-- by every user instead of being re-typed per account.
--
-- THE BUG THIS FIXES
-- A brand-new account (real case: "Julie") logged in and landed on an app
-- that was completely empty — no gateway, no models, no chat. Not because
-- anything failed, but because engine_url / engine_token / litellm_url /
-- default_model live on the `users` row, and a fresh row has them all NULL.
-- Every new user had to be walked through a pairing flow to reach an engine
-- that is, in fact, the SAME engine for everybody on the deployment. That
-- config is INSTANCE INFRASTRUCTURE, not a personal preference.
--
-- THE SHAPE: INHERITANCE, NOT A COPY
-- `global_settings` (singleton id=1, added by 0050) gains the instance-level
-- values. The columns of the same name on `users` stay exactly where they
-- are and become OVERRIDES: NULL (or '') means "use the instance value".
-- Resolution happens at READ time — `user.X ?? instance.X` — in
-- server/lib/global-settings.ts.
--
-- Copying the admin's config onto each new user row was explicitly REJECTED:
-- a snapshot drifts (the admin repoints the gateway, every copy keeps the
-- dead URL) and duplicates a secret N times. With inheritance the admin
-- edits one row and the whole instance follows, while any user who wants
-- their own engine still writes an override and can drop back to the common
-- value by setting it to NULL again.
--
-- No new role: `admin` already exists and already gates
-- server/routes/admin-*.ts. Nothing here needs a 'superadmin'.

-- ── 1. Instance columns on the singleton ───────────────────────────────
-- Types mirror the homonymous `users` columns one-for-one so the resolver
-- can `??` them without any coercion. The two that are NOT NULL here
-- (engine_mode, litellm_disabled) are the ones that must always produce a
-- value: the resolution chain has to terminate on a real mode / boolean,
-- never on NULL. The nullable ones (urls, secrets, default model) keep NULL
-- as a meaningful "not configured at all" — the resolver then falls through
-- to the LITELLM_URL / LITELLM_API_KEY env vars as a last resort.
--
-- Every default below is the NEUTRAL value (no engine, LiteLLM enabled,
-- legacy mode) — identical to the current `users` column defaults. That is
-- what makes step 3 safe: a user row backfilled to NULL resolves to exactly
-- the behaviour it had before this migration when the instance is unseeded.
ALTER TABLE global_settings
  ADD COLUMN IF NOT EXISTS engine_url       TEXT,
  ADD COLUMN IF NOT EXISTS engine_token     TEXT,
  ADD COLUMN IF NOT EXISTS engine_mode      TEXT    NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS engine_meta      JSONB,
  ADD COLUMN IF NOT EXISTS litellm_url      TEXT,
  ADD COLUMN IF NOT EXISTS litellm_api_key  TEXT,
  ADD COLUMN IF NOT EXISTS litellm_disabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_model    TEXT;

-- The singleton may not exist yet on an install that never opened
-- Admin → Memory backend (0050 seeds it, but a DB restored from an older
-- dump might not have the row). Same insert the read-through helper does.
INSERT INTO global_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── 2. SEED FROM THE EXISTING ADMIN ────────────────────────────────────
-- WHY: on this deployment the operator's own account (role='admin') already
-- holds a working, hand-tuned config — the paired engine URL, its crew
-- token, the mode derived at pair time, the default model. Shipping the
-- instance row empty would mean the operator has to re-enter all of it by
-- hand before anyone benefits, and until she does, every user still lands
-- on the empty app this migration exists to fix. So: take the first ACTIVE
-- admin that actually has an engine_url and lift their values up.
--
-- "First admin WITH an engine_url", ordered by created_at, because:
--   * role='admin' is the operator, by definition of the RBAC (see
--     server/routes/admin-users.ts) — no other role can edit the instance;
--   * engine_url IS NOT NULL is the marker of "this account is actually
--     configured"; an admin created later and never paired would seed a
--     blank instance and hide the good config;
--   * created_at ASC makes the choice deterministic (the operator account
--     is the oldest one — it is the one /api/setup/init created).
-- If no such admin exists (fresh install, nobody paired yet) the UPDATE
-- matches nothing and the instance keeps its neutral defaults. That is the
-- correct outcome: there is nothing to inherit yet.
--
-- The guard on g.engine_url makes this idempotent-ish: it never clobbers an
-- instance config that someone already set (re-running the file by hand,
-- restoring a dump, …).
UPDATE global_settings g
   SET engine_url       = a.engine_url,
       engine_token     = a.engine_token,
       engine_mode      = COALESCE(NULLIF(a.engine_mode, ''), 'legacy'),
       engine_meta      = a.engine_meta,
       litellm_url      = a.litellm_url,
       litellm_api_key  = a.litellm_api_key,
       litellm_disabled = COALESCE(a.litellm_disabled, false),
       default_model    = a.default_model,
       updated_at       = now()
  FROM (
    SELECT u.engine_url,
           u.engine_token,
           u.engine_mode,
           u.engine_meta,
           u.litellm_url,
           u.litellm_api_key,
           u.litellm_disabled,
           u.default_model
      FROM users u
     WHERE u.role = 'admin'
       AND u.active
       AND u.engine_url IS NOT NULL
       AND u.engine_url <> ''
     ORDER BY u.created_at ASC
     LIMIT 1
  ) a
 WHERE g.id = 1
   AND COALESCE(g.engine_url, '') = '';

-- NOTE: the admin's own `users` row is deliberately left untouched. Her
-- values are now duplicated into the instance, which looks like the copy
-- we rejected — but it is not: hers is an OVERRIDE that resolves to the
-- same value, so nothing changes for her, and she can drop it (Settings →
-- Inference → "Reset to instance settings") to become a plain inheritor
-- like everyone else. Nulling it here would have been a silent config
-- change on the one account that must keep working.

-- ── 3. The `users` columns become nullable overrides ───────────────────
-- Six of the eight are already nullable. The two that are not — engine_mode
-- and litellm_disabled — are NOT NULL with a DEFAULT, which means a fresh
-- row is born carrying 'legacy' / false. Under inheritance that is not an
-- empty slot, it is an OVERRIDE that pins the new user to legacy mode with
-- LiteLLM on, shadowing whatever the instance says. Julie would inherit the
-- gateway URL and then refuse to use it. So the NOT NULL and the DEFAULT
-- both have to go: NULL is the only honest encoding of "not chosen".
ALTER TABLE users ALTER COLUMN engine_mode      DROP DEFAULT;
ALTER TABLE users ALTER COLUMN engine_mode      DROP NOT NULL;
ALTER TABLE users ALTER COLUMN litellm_disabled DROP DEFAULT;
ALTER TABLE users ALTER COLUMN litellm_disabled DROP NOT NULL;

-- Backfill the rows that hold the column DEFAULT rather than a real choice.
--
-- engine_mode: 'legacy' on an account with no engine_url was never a
-- decision — 'legacy' IS "no engine paired" (see the mode table in
-- docs/user-guide 16-engine-pairing). Those rows become NULL = inherit.
-- Rows WITH an engine_url keep their mode: it was derived from that
-- specific engine's cloud-passthrough feature at pair time and must not
-- follow the instance to a different engine.
UPDATE users
   SET engine_mode = NULL
 WHERE engine_mode = 'legacy'
   AND (engine_url IS NULL OR engine_url = '');

-- litellm_disabled: `false` is both the column default and a value a user
-- could have chosen, and the column alone cannot tell the two apart. The
-- neighbouring column can: litellm_url.
--
--   * false AND no litellm_url  → nobody ever opened the LiteLLM panel;
--     this is the untouched default. NULL = inherit.
--   * false WITH a litellm_url  → this account deliberately configured the
--     LiteLLM rail and left it on. Keep the explicit false, so an instance
--     that later switches to pure-gateway does NOT silently bypass the
--     proxy they set up. They can still drop the override from
--     Settings → Add-ons → "Reset to instance settings".
--   * true                      → an explicit decision either way. Kept.
--
-- Narrowing it this way is what keeps the migration behaviour-preserving
-- for existing accounts while still letting a future org-wide "LiteLLM off"
-- reach everyone who never cared.
--
-- The engine_url clause mirrors the engine_mode backfill above, and for the
-- same reason: an account with its OWN engine must not inherit an instance
-- `litellm_disabled = true`, because effectiveProviderMode() then forces
-- `gateway` onto that personal engine (global-settings.ts) — an engine that
-- may not declare cloud-passthrough, so its cloud models would vanish. No
-- row on this deployment matches either way (the only account with an
-- engine_url is the admin, whose litellm_disabled is already true and thus
-- out of this UPDATE): this is symmetry insurance for a restored dump or
-- another install, not a fix for anything currently broken.
UPDATE users
   SET litellm_disabled = NULL
 WHERE litellm_disabled = false
   AND (litellm_url IS NULL OR litellm_url = '')
   AND (engine_url IS NULL OR engine_url = '');

-- No index needed: global_settings is a single row read through a 30 s
-- process cache (server/lib/global-settings.ts), and the users columns are
-- only ever read by primary key.
