-- Gateway mode — extend Odyssai capability contract with provider mode.
--
-- engine_mode controls how Companion routes /v1/chat/completions and how it
-- lists models:
--   • 'gateway' → all traffic to engine_url (Odysseus proxies cloud + serves
--     local). LiteLLM is bypassed entirely.
--   • 'hybrid'  → inference goes through litellm_url, capabilities are
--     enriched from engine_url (/v1/models with x_odyssai). Legacy LiteLLM
--     setup + Odyssai-aware UI.
--   • 'legacy'  → LiteLLM only, capabilities derived from heuristics. No
--     Odysseus engine paired.
--
-- litellm_disabled lets the user (or admin) turn off LiteLLM completely
-- when running pure-gateway. When true, listing models and routing chat
-- both refuse to touch litellm_url even if set. Default false to preserve
-- existing behavior.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS engine_mode text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS litellm_disabled boolean NOT NULL DEFAULT false;

-- Backfill: if engine_url is already set, assume hybrid (cloud-passthrough
-- not detected yet — first reload/probe will promote to gateway).
UPDATE users
   SET engine_mode = 'hybrid'
 WHERE engine_url IS NOT NULL
   AND engine_mode = 'legacy';
