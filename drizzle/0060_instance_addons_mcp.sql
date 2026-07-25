-- 0060_instance_addons_mcp.sql
-- 2026-07-25: add-ons and MCP servers become INSTANCE rows, inherited by
-- every user. The direct sequel to 0059, which did the same for the
-- connection block.
--
-- THE BUG THIS FIXES (observed on prod, two accounts)
-- 0059 gave a new account a working engine, so the app is no longer empty.
-- What it still gets is worse than empty: the second user's `addons` rows
-- exist (six of them, auto-provisioned by the Add-ons page pinging each
-- /info route) but their `config` jsonb is EMPTY. "Parser" and "ComfyUI
-- Imager" show up as ENABLED with no URL behind them, so every attachment
-- silently skips parsing and every /comfyui silently does nothing. And
-- `mcp_servers` has zero rows for that account, so the five servers the
-- operator registered (Corpus, Qdrant, Tavily, OdyssAI-Voice, Notion)
-- simply do not exist for anybody but her.
--
-- Both tables hold the same class of value the connection block did: WHERE
-- the deployment's services live. That is instance infrastructure, not a
-- personal preference, and re-typing it per account is how you get an
-- account that looks configured and isn't.
--
-- THE SHAPE: INHERITANCE, NOT A COPY (0059's rule, unchanged)
-- A row with `user_id IS NULL` is an INSTANCE row. The user row of the same
-- identity (`name` for addons, `slug` for mcp_servers) wins over it, field
-- by field and — for addons — config KEY by config key: a user who sets
-- only `pdfMode` keeps inheriting the instance's `url` instead of blanking
-- it. Resolution happens at READ time in server/lib/instance-rows.ts.
-- Nothing is ever snapshotted onto a user row; a copy would drift the
-- moment the operator repointed a service, which is precisely the failure
-- 0059 rejected.
--
-- Consequence, and the reason this migration is short on backfill: a brand
-- new account gets NO rows at all. It inherits everything, and the six
-- empty rows that started this whole thing can no longer be created (the
-- auto-provision ping is gone from the Add-ons page, and every findOrInit
-- became a resolve that materialises nothing).
--
-- THE HARD SECURITY BOUNDARY: OAUTH STAYS PER USER
-- The operator's decision is that BEARER credentials are shared infra and
-- are inherited (`mcp_servers.auth_header`, and the add-on config keys that
-- carry a token for a LAN bridge). OAUTH credentials are NOT. An instance
-- row with auth_kind='oauth' DECLARES the server — its name, url, transport
-- and the cached .well-known document. Each user then runs their own
-- authorization and their access/refresh tokens, their DCR client id and
-- client secret live on THEIR row.
--
-- Sharing oauth_access_token / oauth_refresh_token would hand user B the
-- Notion (or GitHub, or Linear) account of user A. It is the same hole 0059
-- found on engine_token and closed with the `ownEngine` rule — read the
-- comment around it in server/lib/global-settings.ts. Do not reintroduce it
-- in this shape.
--
-- The DCR client_id is NOT seeded either, even though it is arguably an
-- installation-level identity rather than a personal one: it is useless
-- without its client_secret at the token endpoint, and the secret cannot
-- cross the boundary. Splitting a credential PAIR across two trust levels
-- is exactly the failure mode above. The cost is one dynamic client
-- registration per user who authorizes, which providers allow; the benefit
-- is that there is no shared secret to leak. An operator who has a real
-- shared client can still put both halves on the instance row by hand.
--
-- No new role: `admin` already gates server/routes/admin-*.ts.

-- ── 1. addons: user_id becomes nullable ────────────────────────────────
-- The FK and its ON DELETE CASCADE stay. A nullable FK is legal in
-- Postgres (NULL never violates a reference) and the cascade simply never
-- fires for an instance row — which is the behaviour we want: deleting a
-- user must not delete the deployment's configuration.
--
-- Note that every existing query filters `user_id = $1`, and SQL's ternary
-- logic means NULL never matches an equality. So this ALTER on its own is
-- inert: no current code path can see an instance row until it is switched
-- over to the resolver. That is a safety property, not an oversight.
ALTER TABLE addons ALTER COLUMN user_id DROP NOT NULL;

-- `enabled` is the same trap 0059 hit with engine_mode / litellm_disabled.
-- NOT NULL DEFAULT false means a freshly materialised user row is born
-- carrying `false` — which is not a choice, it is the column default, and
-- under inheritance it would PIN the user to "off" and shadow an instance
-- row the operator deliberately turned on. NULL is the only honest encoding
-- of "not chosen"; the resolver reads user.enabled ?? instance.enabled ??
-- false.
--
-- No backfill. Every existing row's boolean was written by a real toggle or
-- by a findOrInit that this migration retires, and there is no neighbouring
-- column that can tell a deliberate `false` from a default one (0059 could
-- use litellm_url as that witness; there is no equivalent here). Leaving
-- them as explicit overrides is the only choice with strictly zero
-- behaviour change for the accounts that exist today.
ALTER TABLE addons ALTER COLUMN enabled DROP DEFAULT;
ALTER TABLE addons ALTER COLUMN enabled DROP NOT NULL;

-- An instance row is the end of the resolution chain, so it must carry a
-- real boolean — same reasoning as global_settings.engine_mode being NOT
-- NULL in 0059 while users.engine_mode is nullable. Expressed as a CHECK
-- because both kinds of row share one column.
DO $$
BEGIN
  ALTER TABLE addons
    ADD CONSTRAINT addons_instance_complete
    CHECK (user_id IS NOT NULL OR enabled IS NOT NULL);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. addons: the uniqueness that was never there ─────────────────────
-- `name` has always been the de-facto identity (nine `const ADDON_NAME`
-- in server/routes/addon-*.ts, the HIDDEN/hasPanel lists in the UI, six
-- earlier migrations matching on it) but nothing enforced it. Pairing a
-- user row with an instance row by `name` makes that identity load-bearing,
-- so it needs a constraint.
--
-- TWO indexes are required, not one. In a Postgres unique index NULLs are
-- distinct by default: (NULL,'Parser') and (NULL,'Parser') do NOT collide,
-- so a UNIQUE (user_id, name) would let two instance rows for the same
-- add-on coexist and the resolver's LIMIT 1 would pick an arbitrary one.
-- Hence a PARTIAL unique index on `name` alone, restricted to the instance
-- rows, alongside the ordinary one on the user rows.
CREATE UNIQUE INDEX IF NOT EXISTS addons_instance_name_unique
  ON addons (name)
  WHERE user_id IS NULL;

-- The resolver looks a row up by name (per user, and on the instance), a
-- shape the existing (user_id, kind) index cannot serve.
CREATE INDEX IF NOT EXISTS addons_name_idx ON addons (name);

-- The user-side unique index is created ONLY IF the data already satisfies
-- it. Duplicates are reachable today: POST /api/addons accepts an arbitrary
-- `name` with no uniqueness check, and findOrInit's LIMIT 1 hid the result.
--
-- Choice made here, stated plainly: if duplicates exist we SKIP the index
-- and log a NOTICE, we do not delete or rename anything. The runner wraps
-- each migration file in a single transaction (server/db/migrate.ts), so a
-- constraint violation here would roll the whole file back and the
-- container would fail to boot on a data condition nobody can see from
-- outside — the worst possible failure mode for a deploy. And silently
-- dropping a user's second row would be destroying data to satisfy an
-- index. Correctness does not depend on the index either way: every
-- resolver query orders by `created_at ASC, id ASC` before LIMIT 1, so the
-- winner is deterministic with or without it. The index is here to stop
-- NEW duplicates on a database that is currently clean.
DO $$
DECLARE
  dupes integer;
BEGIN
  SELECT count(*) INTO dupes FROM (
    SELECT user_id, name FROM addons
     WHERE user_id IS NOT NULL
     GROUP BY user_id, name HAVING count(*) > 1
  ) d;
  IF dupes = 0 THEN
    CREATE UNIQUE INDEX IF NOT EXISTS addons_user_name_unique
      ON addons (user_id, name)
      WHERE user_id IS NOT NULL;
  ELSE
    RAISE NOTICE
      'addons: % duplicate (user_id, name) group(s) — skipping addons_user_name_unique. Resolution stays deterministic (created_at ASC, id ASC); clean up by hand and re-create the index.',
      dupes;
  END IF;
END $$;

-- ── 3. SEED the instance add-ons from the operator's account ───────────
-- Same selection rule as 0059: the FIRST ACTIVE ADMIN, ordered by
-- created_at, because role='admin' is the operator by definition of the
-- RBAC and created_at ASC makes the pick deterministic (that account is the
-- one /api/setup/init created). 0059 additionally required the account to
-- be "actually configured"; the equivalent marker here is simply owning
-- add-on rows at all, so the EXISTS clause plays that part — an admin
-- created later who never opened the Add-ons page must not seed an empty
-- instance and hide the good config.
--
-- DISTINCT ON (name) because the source account may itself hold duplicates
-- (see step 2); the oldest row wins, matching the resolver's tie-break.
--
-- Idempotence: the NOT EXISTS guard mirrors 0059's `COALESCE(g.engine_url,
-- '') = ''` — never clobber an instance configuration somebody already set
-- (re-running the file by hand, a restored dump, …). Rows inserted by this
-- statement are invisible to its own subquery (statement snapshot), so the
-- guard holds for the whole insert, not just the first row.
--
-- THREE CONFIG KEYS ARE STRIPPED on the way up:
--
--   syncToken     (Obsidian) — not configuration, an AUTHENTICATION
--                 PRINCIPAL. resolveBearerUser() in addon-obsidian.ts
--                 turns it into a user id with a table scan that has no
--                 user_id filter at all. A shared one has no meaning and a
--                 leaked one is an account.
--   lastSyncedAt  (Obsidian) — per-account state, rewritten on every vault
--                 download. Publishing the operator's would date every
--                 user's last sync.
--   apiKey        (Web Search / Tavily) — a METERED third-party account.
--                 The operator's decision to share bearer credentials
--                 covers the deployment's own LAN services; billing
--                 everyone's searches to one Tavily contract is a
--                 different decision and is not ours to make silently.
--                 The card is hidden in the UI anyway (superseded by the
--                 Tavily MCP server) and web_search falls back to the
--                 native DDG path, so stripping it changes nothing for
--                 anyone. An operator who DOES want to share a key can put
--                 it on the instance row from Admin → Instance add-ons;
--                 the resolver inherits it from there.
--
-- Everything else is copied verbatim, including the bridge tokens: those
-- are credentials for a LAN service the deployment owns, which is exactly
-- the shared-infra case. The resolver still refuses to hand a shared token
-- to a user who repointed the matching URL (the 0059 `ownEngine` rule,
-- applied per add-on).
INSERT INTO addons (user_id, name, kind, description, version, enabled, config)
SELECT DISTINCT ON (a.name)
       NULL::uuid,
       a.name,
       a.kind,
       a.description,
       a.version,
       a.enabled,
       a.config - 'syncToken' - 'lastSyncedAt' - 'apiKey'
  FROM addons a
  JOIN (
    SELECT u.id
      FROM users u
     WHERE u.role = 'admin'
       AND u.active
       AND EXISTS (SELECT 1 FROM addons x WHERE x.user_id = u.id)
     ORDER BY u.created_at ASC
     LIMIT 1
  ) src ON a.user_id = src.id
 WHERE NOT EXISTS (SELECT 1 FROM addons i WHERE i.user_id IS NULL)
 ORDER BY a.name, a.created_at ASC, a.id ASC;

-- NOTE: the operator's own `addons` rows are deliberately left untouched,
-- for the same reason 0059 left her `users` row alone. Her rows are now
-- OVERRIDES that resolve to exactly the values they held before, so nothing
-- about her account changes — and she can drop any of them ("Reset to
-- instance" on the Add-ons page) to become a plain inheritor. Nulling them
-- here would be a silent config change on the one account that must keep
-- working.

-- ── 3b. Release the PHANTOM `enabled = false` overrides ────────────────
-- The note on step 1 says a deliberate `false` cannot be told apart from
-- the column default. That is wrong, and getting it wrong leaves the bug
-- this file exists to fix half-fixed.
--
-- Every one of the nine retired `findOrInit*()` helpers inserted exactly
-- the same shape: `enabled: false` and NO `config` at all (see the git
-- history of server/routes/addon-*.ts). So an auto-provisioned row that
-- nobody ever touched carries a THREE-part fingerprint no human action can
-- forge:
--
--   enabled = false        the hardcoded literal in findOrInit
--   config IS NULL         the column has no DEFAULT, and findOrInit never
--                          passed one — every save path writes an object,
--                          even an empty one
--   updated_at = created_at
--                          both are `DEFAULT now()` and now() is the
--                          TRANSACTION timestamp, so an INSERT makes them
--                          bit-identical; every subsequent write in the app
--                          sets updated_at from JS and breaks the equality
--
-- A user who genuinely turned an add-on off went through PATCH /api/addons
-- or a PUT /config, both of which stamp updated_at — so they are excluded.
-- 0058's own Auto Router INSERT is excluded too: it carries a
-- `{fallbackModel: …}` config.
--
-- Without this, the second account's six auto-provisioned rows keep an
-- `enabled = false` NOBODY CHOSE, and under inheritance that false is no
-- longer an empty slot — it is an override that permanently shadows an
-- instance row the operator deliberately turned on. The config half of the
-- bug would be fixed (the per-key merge in instance-rows.ts sees an empty
-- own config and inherits everything) while the switch half stayed broken,
-- which is the same "looks configured and isn't" failure one level up.
--
-- Zero risk for the operator's account, and this is provable rather than
-- hoped for: it runs AFTER step 3, so the instance row already carries the
-- value copied from her row. Nulling her column makes her resolve against
-- that copy and land on the identical boolean. The order is load-bearing —
-- run before step 3 and the seed would lift a NULL into the instance row
-- and trip `addons_instance_complete`.
UPDATE addons
   SET enabled = NULL
 WHERE user_id IS NOT NULL
   AND enabled = false
   AND config IS NULL
   AND updated_at = created_at;

-- ── 4. mcp_servers: the same treatment ─────────────────────────────────
-- user_id nullable for the same reason and with the same inertness. The
-- four columns that describe WHERE the server is (name / transport / url /
-- auth_kind) and the `enabled` switch also become nullable, so a user row
-- can be a PARTIAL override — in particular the "ghost" row the OAuth flow
-- materialises, which must carry the caller's tokens and NOTHING else.
--
-- If the ghost copied url/transport/name instead, we would be back to the
-- snapshot 0059 rejected: the operator repoints the instance server and
-- every ghost keeps hammering the dead address with a live token.
ALTER TABLE mcp_servers ALTER COLUMN user_id   DROP NOT NULL;
ALTER TABLE mcp_servers ALTER COLUMN name      DROP NOT NULL;
ALTER TABLE mcp_servers ALTER COLUMN transport DROP NOT NULL;
ALTER TABLE mcp_servers ALTER COLUMN url       DROP NOT NULL;
ALTER TABLE mcp_servers ALTER COLUMN auth_kind DROP DEFAULT;
ALTER TABLE mcp_servers ALTER COLUMN auth_kind DROP NOT NULL;
ALTER TABLE mcp_servers ALTER COLUMN enabled   DROP DEFAULT;
ALTER TABLE mcp_servers ALTER COLUMN enabled   DROP NOT NULL;

-- Dropping five NOT NULLs removes a real invariant, so replace it with the
-- one that actually holds under inheritance: an INSTANCE row is always
-- complete (it is what everybody else resolves against), a USER row may be
-- partial. A user row that ends up partial with no instance row of the same
-- slug to complete it is simply skipped by the resolver — see the orphan
-- note in server/lib/instance-rows.ts.
DO $$
BEGIN
  ALTER TABLE mcp_servers
    ADD CONSTRAINT mcp_servers_instance_complete
    CHECK (
      user_id IS NOT NULL
      OR (name IS NOT NULL AND transport IS NOT NULL AND url IS NOT NULL
          AND auth_kind IS NOT NULL AND enabled IS NOT NULL)
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- The existing UNIQUE (user_id, slug) from 0029 keeps working unchanged for
-- user rows and needs no touching — but, NULLS DISTINCT again, it does not
-- constrain the instance rows at all. Partial unique index for those.
--
-- (It is declared inline in 0029, so Postgres named it
-- `mcp_servers_user_id_slug_key`, NOT the `mcp_servers_user_slug_unique`
-- that server/db/schema.ts announces — that name only ever existed in the
-- Drizzle declaration. Noted here because a future DROP aimed at the
-- Drizzle name would fail and, one-transaction-per-file, take its whole
-- migration down with it.)
CREATE UNIQUE INDEX IF NOT EXISTS mcp_servers_instance_slug_unique
  ON mcp_servers (slug)
  WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS mcp_servers_slug_idx ON mcp_servers (slug);

-- ── 5. SEED the instance MCP servers ───────────────────────────────────
-- Same admin, same idempotence guard, same DISTINCT ON tie-break.
--
-- auth_header IS copied for bearer servers. Explicit decision by the
-- product owner: those tokens address the deployment's own services and
-- are shared infrastructure. (The resolver still withholds the shared
-- header from a user who overrode `url`, so it can never be sent to a host
-- of that user's choosing — 0059's engineToken rule.)
--
-- For oauth servers the instance row DECLARES the server and nothing more:
-- name, slug, transport, url, auth_kind, and oauth_metadata. Metadata is
-- the cached `.well-known/oauth-authorization-server` document — a public
-- file, a property of the URL, with no secret in it, and caching it once
-- saves every user a discovery round-trip. The five columns that ARE
-- secret (access token, refresh token, client secret, expiry, scopes) are
-- never selected here; they stay on the row of whoever authorized.
-- oauth_client_id is left behind too, for the reason given in the header.
--
-- tools_cache / tools_cache_at: copied for bearer and none, NOT for oauth.
-- The cache is the output of a `tools/list` performed WITH that row's
-- credentials — it is a property of (server, credential), not of the
-- server. With a shared bearer the answer is identical for everyone and
-- caching it once on the instance row is exactly right: it spares each
-- user the synchronous first fetch that server/lib/tools.ts does on an
-- empty cache, on the chat hot path. With OAuth the list is scoped to the
-- authorizing account, so a shared copy would advertise to B tools that
-- only A may call. Those caches land on the per-user ghost instead.
--
-- last_error is NEVER copied and never written to an instance row from a
-- tool CALL: it is the trace of one attempt by one account. The operator's
-- last failure has no business appearing in every user's Settings page.
INSERT INTO mcp_servers (
  user_id, name, slug, transport, url,
  auth_kind, auth_header, oauth_metadata,
  enabled, tools_cache, tools_cache_at, last_error
)
SELECT DISTINCT ON (m.slug)
       NULL::uuid,
       m.name,
       m.slug,
       m.transport,
       m.url,
       m.auth_kind,
       CASE WHEN m.auth_kind = 'bearer' THEN m.auth_header ELSE NULL END,
       m.oauth_metadata,
       m.enabled,
       CASE WHEN m.auth_kind = 'oauth' THEN NULL ELSE m.tools_cache END,
       CASE WHEN m.auth_kind = 'oauth' THEN NULL ELSE m.tools_cache_at END,
       NULL::text
  FROM mcp_servers m
  JOIN (
    SELECT u.id
      FROM users u
     WHERE u.role = 'admin'
       AND u.active
       AND EXISTS (SELECT 1 FROM mcp_servers x WHERE x.user_id = u.id)
     ORDER BY u.created_at ASC
     LIMIT 1
  ) src ON m.user_id = src.id
 WHERE NOT EXISTS (SELECT 1 FROM mcp_servers i WHERE i.user_id IS NULL)
 ORDER BY m.slug, m.created_at ASC, m.id ASC;

-- Her own rows stay, same rationale as step 3's note: overrides that
-- resolve to the same values, including her OAuth tokens, which is where
-- they belong.

-- ── 6. timezone becomes an instance setting (WU4) ──────────────────────
-- Same shape as the eight connection columns of 0059: a value on
-- global_settings, a nullable override of the same name on users, resolved
-- by server/lib/global-settings.ts. NOT NULL with a real default here
-- because the resolution chain has to terminate on a usable IANA zone —
-- server/lib/timetag.ts hands it straight to Intl.DateTimeFormat, which
-- throws RangeError on "" and silently falls back to the container's zone
-- on undefined.
ALTER TABLE global_settings
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

INSERT INTO global_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

UPDATE global_settings g
   SET timezone   = a.timezone,
       updated_at = now()
  FROM (
    SELECT u.timezone
      FROM users u
     WHERE u.role = 'admin'
       AND u.active
       AND u.timezone IS NOT NULL
       AND u.timezone <> ''
     ORDER BY u.created_at ASC
     LIMIT 1
  ) a
 WHERE g.id = 1
   AND g.timezone = 'UTC';

ALTER TABLE users ALTER COLUMN timezone DROP DEFAULT;
ALTER TABLE users ALTER COLUMN timezone DROP NOT NULL;

-- NO BACKFILL, and this is the interesting part.
--
-- 0059 could null out `litellm_disabled = false` on the rows that never
-- chose it, because a neighbouring column (litellm_url) told a default
-- apart from a decision: false WITH a configured URL is a choice, false
-- WITHOUT one is the untouched default. `timezone` has no such witness.
-- 'UTC' is simultaneously the column default that every row was born with
-- AND a perfectly ordinary answer for someone who genuinely works in UTC,
-- and nothing else on the row correlates with the difference.
--
-- Guessing would be a silent, invisible change to the timestamps injected
-- into every single chat message of an existing account. So: existing rows
-- keep their value as an explicit override and never inherit. Only rows
-- created from now on are born NULL and follow the instance. Users who
-- want to join the inheritance can pick the empty option in Settings →
-- Inference → Timezone, which PATCHes NULL.
--
-- (This is the same trade 0059 made for engine_mode on accounts that had
-- an engine_url: correctness for the accounts that exist beats reach.)

-- ── 7. inference_mode defaults to 'auto' for NEW rows (WU4) ────────────
-- This deliberately supersedes the note at the end of
-- drizzle/0058_inference_mode_auto.sql, which kept the default at 'expert'
-- and explained why:
--
--     "A brand-new account defaulting to 'auto' would therefore land in a
--      chat with no picker AND no router — a dead end."
--
-- That reasoning was exactly right IN 0058's world, where an add-on row
-- was per user and a fresh account's Auto Router row was created disabled
-- and empty by findOrInit. Under inheritance the premise is gone: a fresh
-- account resolves the INSTANCE Auto Router row, which on this deployment
-- was just seeded from the operator's working one in step 3.
--
-- "Resolves an instance row" is not the same as "can route", though, so
-- step 8 below closes the gap before this default is allowed to matter.
-- Existing rows are untouched — changing a column DEFAULT never rewrites
-- data, and inference_mode is NOT NULL, so every current account keeps the
-- mode it has.
ALTER TABLE users ALTER COLUMN inference_mode SET DEFAULT 'auto';

-- ── 8. Make the instance Auto Router honour that default ───────────────
-- The dead end 0058 described is reached when chat.ts routes on the 'auto'
-- sentinel, the router cannot run, AND no fallbackModel is configured: it
-- answers 503 and the user has no picker to escape with. One usable
-- fallback on the INSTANCE row removes it for every inheritor at once.
--
-- Two steps, both gap-fill only (they never overwrite a configured value),
-- both modelled on 0058's own steps 1-3 which did the identical thing per
-- user — including the "insert the same shape findOrInit would" rule, so
-- the card and /info read the row back unchanged.
--
-- 8a. Create the instance Auto Router row if the seed did not (an install
--     where the operator never opened the Add-ons page).
INSERT INTO addons (user_id, name, kind, description, version, enabled, config)
SELECT NULL::uuid,
       'Auto Router',
       'plugin',
       'Pick the right model automatically based on what you''re asking. '
         || 'Routes conversation, deep analysis, and code to the model that '
         || 'handles each best. Requires an OpenAI-compatible embeddings '
         || 'endpoint — point it at any service that exposes one.',
       '0.1.0',
       true,
       '{}'::jsonb
 WHERE NOT EXISTS (
   SELECT 1 FROM addons WHERE user_id IS NULL AND name = 'Auto Router'
 );

-- 8b. Give it a fallback model if it has none. The instance default_model
--     (0059) is the one model the whole deployment is known to be able to
--     answer with, and it is what an 'expert' account would have been
--     pre-filled with anyway — so the fallback answers with the same model
--     the user would have picked, and chat.ts still surfaces the routing
--     error alongside it. Nothing is hardcoded: if the instance has no
--     default_model the UPDATE matches nothing and we leave the row alone.
UPDATE addons a
   SET config     = COALESCE(a.config, '{}'::jsonb)
                    || jsonb_build_object('fallbackModel', g.default_model),
       updated_at = now()
  FROM global_settings g
 WHERE a.user_id IS NULL
   AND a.name = 'Auto Router'
   AND g.id = 1
   AND COALESCE(g.default_model, '') <> ''
   AND COALESCE(a.config ->> 'fallbackModel', '') = '';

-- RESIDUAL RISK, stated rather than papered over: on a deployment with no
-- instance default_model AND an Auto Router that cannot route, a brand-new
-- account in 'auto' still meets 0058's 503. Every other case is covered.
-- The clean fix would be for chat.ts to fall back to the resolved
-- defaultModel before giving up, but that changes the behaviour of a
-- request path for existing accounts, which this migration is not allowed
-- to do.

-- ── 9. show_metrics / debug_verbose stay personal ──────────────────────
-- Checked, no change needed. Both are `boolean NOT NULL DEFAULT false`
-- (0025 and 0032), so a new account is already born with them off, which
-- is what was asked for.
--
-- Neither is made inheritable, on purpose. show_metrics is a pure render
-- preference — the server reads it exactly once, to echo it back in
-- /api/inference/settings — and the cost of a wrong value is one click.
-- debug_verbose already HAS an instance-level switch, the DEBUG_VERBOSE
-- env var read in server/lib/chat-stream.ts, and it ORs with the column:
-- the operator forces it on for everyone and a user cannot turn it off.
-- A second instance switch resolving with ?? would have the opposite
-- semantics and let a user silence diagnostics the operator just enabled.
-- Two contradictory instance switches for one behaviour is a debugging
-- trap, not a feature.
--
-- default_model already inherits since 0059 (global_settings.default_model
-- + resolveUserSettings) — verified, nothing to redo here.
