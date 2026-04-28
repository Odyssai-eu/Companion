-- v0.1.0 — switch to LiteLLM as the single inference layer.
--
-- Drops the multi-server abstraction (servers + endpoints) in favour of one
-- LiteLLM URL configured per user (override) or globally via env var. The
-- model picker now reflects whatever LiteLLM exposes via /v1/models — no
-- engine_kind / bearer juggling on our side.

-- 1. Drop the FK from conversations to servers, then the tables themselves.
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "server_id";
DROP TABLE IF EXISTS "endpoints";
DROP TABLE IF EXISTS "servers";

-- 2. Drop IndicAI (replaced by Last-seen indicator + Learning Center stub).
DROP TABLE IF EXISTS "indicai_signals";
DROP TABLE IF EXISTS "indicai";

-- 3. Per-user inference + temporal-awareness columns.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "default_model" text,
  ADD COLUMN IF NOT EXISTS "litellm_url" text,
  ADD COLUMN IF NOT EXISTS "litellm_api_key" text,
  ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'Europe/Brussels',
  ADD COLUMN IF NOT EXISTS "last_interaction_at" timestamptz;
