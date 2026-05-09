-- 0015_inference_modes.sql
-- 3-tier inference modes: easy / advanced / expert.
--
-- - easy:     admin sets one model (admin_default_model). User has no picker.
-- - advanced: 4 named slots (Conversation, Analyse, Engineer, Expert) each
--             mapped to a LiteLLM alias. User picks among the 4 per chat.
-- - expert:   user picks any model from the full LiteLLM list (current UX).
--
-- Per-user setting so admin and individual users can pick their own UX.
-- Defaults to 'expert' to keep current behaviour for migrating users.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS inference_mode text NOT NULL DEFAULT 'expert',
  ADD COLUMN IF NOT EXISTS easy_model text,
  ADD COLUMN IF NOT EXISTS named_models jsonb;
