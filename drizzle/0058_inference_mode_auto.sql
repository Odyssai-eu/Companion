-- 0058_inference_mode_auto.sql
-- 2026-07-25: inference modes collapse from 3 to 2 — 'auto' | 'expert'.
--
-- 'easy' and 'advanced' are retired. The new 'auto' mode replaces BOTH
-- (Sophie: « le mode Auto les remplace »). Behaviourally 'auto' is what
-- 'easy' already did: no model picker in the chat, and the Auto Router
-- add-on decides which model answers each message.
--
-- Naming caveat for future readers: the MODE is called "auto" and the
-- synthetic MODEL ID the chat sends is also "auto" (AUTO_ROUTER_MODEL_ID
-- in server/routes/chat.ts). They are two different things that happen to
-- share a word — the mode is a per-user UX setting, the model id is the
-- routing sentinel the chat route intercepts.
--
-- WHY THIS MIGRATION SHIPS WITH THE CODE, NOT AFTER IT:
-- the same deployment shrinks the PATCH zod enum to ["auto","expert"].
-- The Settings → Inference client always sends inferenceMode in its PATCH
-- body, so a user still sitting on 'easy' / 'advanced' would get a 400 on
-- the WHOLE body and be unable to save ANY inference setting (timezone,
-- metrics, default model, …) until they were migrated. Backfill first.
--
-- No CHECK constraint exists on the column (plain `text`, see
-- 0015_inference_modes.sql), so there is nothing to alter besides data.

-- ORDER MATTERS: everything that has to know which users were on a legacy
-- mode runs BEFORE the mode is rewritten. The flip is the last statement
-- of this file.

-- ── 1. Carry the retired easy-mode fallback into the Auto Router's own
--       fallbackModel setting ──────────────────────────────────────────
-- Same role in the new world (the model that answers when routing can't
-- happen), so losing it on the mode collapse would be a silent regression
-- for anyone who had set it. Gap-fill only: never overwrite a
-- fallbackModel the user has already configured.
UPDATE addons a
   SET config = COALESCE(a.config, '{}'::jsonb)
                || jsonb_build_object('fallbackModel', u.easy_model),
       updated_at = now()
  FROM users u
 WHERE a.user_id = u.id
   AND a.name = 'Auto Router'
   AND u.easy_model IS NOT NULL
   AND u.easy_model <> ''
   AND COALESCE(a.config ->> 'fallbackModel', '') = '';

-- ── 2. The REST of the legacy resolution chain, legacy-mode rows only ──
-- easy_model was only the FIRST link. The pre-0058 client (useChat.ts,
-- deleted in this change) resolved:
--   easy     → routerReady ? "auto" : (easyModel ?? defaultModel)
--   advanced → first non-empty named slot ?? defaultModel
-- So a legacy account with no easy_model was NOT broken — it chatted on a
-- named slot or on default_model. Post-0058 it sends the routing sentinel
-- on every turn; with an unready router AND no fallbackModel the chat
-- route answers 503 while the picker is hidden — the user cannot send
-- anything and has no UI to escape with. Carry the remaining links.
-- Scoped to the legacy modes so we never invent a fallback for an expert
-- user, and still gap-fill only.
UPDATE addons a
   SET config = COALESCE(a.config, '{}'::jsonb)
                || jsonb_build_object(
                     'fallbackModel',
                     CASE
                       WHEN u.inference_mode = 'easy'
                         THEN COALESCE(NULLIF(u.easy_model, ''),
                                       NULLIF(u.default_model, ''))
                       ELSE COALESCE(NULLIF(u.named_models ->> 'conversation', ''),
                                     NULLIF(u.named_models ->> 'analyse', ''),
                                     NULLIF(u.named_models ->> 'engineer', ''),
                                     NULLIF(u.named_models ->> 'expert', ''),
                                     NULLIF(u.default_model, ''))
                     END
                   ),
       updated_at = now()
  FROM users u
 WHERE a.user_id = u.id
   AND a.name = 'Auto Router'
   AND u.inference_mode IN ('easy', 'advanced')
   AND COALESCE(a.config ->> 'fallbackModel', '') = ''
   AND CASE
         WHEN u.inference_mode = 'easy'
           THEN COALESCE(NULLIF(u.easy_model, ''), NULLIF(u.default_model, ''))
         ELSE COALESCE(NULLIF(u.named_models ->> 'conversation', ''),
                       NULLIF(u.named_models ->> 'analyse', ''),
                       NULLIF(u.named_models ->> 'engineer', ''),
                       NULLIF(u.named_models ->> 'expert', ''),
                       NULLIF(u.default_model, ''))
       END IS NOT NULL;

-- ── 3. Same rescue for legacy-mode users with NO Auto Router row ───────
-- The row is created lazily by findOrInit() on the first GET
-- /api/addons/router/info, which the chat fires on mount — so most active
-- users have one. Not all: an account provisioned by an admin and driven
-- through the API, or one whose owner never opened the chat, has none, and
-- statements 1-2 would drop its model on the floor. Insert the same shape
-- findOrInit() would (kind/version/enabled must match, the panel and
-- /info read them back) carrying the fallback.
INSERT INTO addons (user_id, name, kind, description, version, enabled, config)
SELECT u.id,
       'Auto Router',
       'plugin',
       'Pick the right model automatically based on what you''re asking. '
       || 'Routes conversation, deep analysis, and code to the model that '
       || 'handles each best. Requires an OpenAI-compatible embeddings '
       || 'endpoint — point it at any service that exposes one.',
       '0.1.0',
       false,
       jsonb_build_object(
         'fallbackModel',
         COALESCE(NULLIF(u.easy_model, ''),
                  NULLIF(u.named_models ->> 'conversation', ''),
                  NULLIF(u.named_models ->> 'analyse', ''),
                  NULLIF(u.named_models ->> 'engineer', ''),
                  NULLIF(u.named_models ->> 'expert', ''),
                  NULLIF(u.default_model, ''))
       )
  FROM users u
 WHERE u.inference_mode IN ('easy', 'advanced')
   AND COALESCE(NULLIF(u.easy_model, ''),
                NULLIF(u.named_models ->> 'conversation', ''),
                NULLIF(u.named_models ->> 'analyse', ''),
                NULLIF(u.named_models ->> 'engineer', ''),
                NULLIF(u.named_models ->> 'expert', ''),
                NULLIF(u.default_model, '')) IS NOT NULL
   AND NOT EXISTS (
         SELECT 1 FROM addons a
          WHERE a.user_id = u.id AND a.name = 'Auto Router'
       );

-- ── 4. The mode flip itself ────────────────────────────────────────────
UPDATE users
   SET inference_mode = 'auto'
 WHERE inference_mode IN ('easy', 'advanced');

-- DEFAULT deliberately stays 'expert'.
-- 'auto' hides the chat model picker entirely and delegates to the Auto
-- Router add-on, which is opt-in and DISABLED by default (see
-- server/routes/addon-router.ts → findOrInit, enabled: false). A brand-new
-- account defaulting to 'auto' would therefore land in a chat with no
-- picker AND no router — a dead end. 'expert' stays the safe first-run
-- mode; the user opts into 'auto' once the router is configured.

-- users.easy_model and users.named_models are now unused by the app.
-- They are NOT dropped here on purpose: the data above is the only thing
-- worth keeping and it has just been copied, but keeping the columns makes
-- this migration trivially reversible (revert the code, the old UI reads
-- its values back). A later cleanup migration can drop them once the
-- two-mode UI has been live for a while.
