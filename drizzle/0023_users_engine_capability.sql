-- Capability contract — per-user link to an Odyssai-compatible engine.
--
-- Distinct from `litellm_url` (inference routing): the engine URL is the
-- direct address of an Odysseus instance (or any engine implementing the
-- `vendor: "odyssai.eu"` capability contract) that Companion polls for
-- per-model capabilities (loaded?, context_length, supports_tools, …).
-- Inference itself still goes through LiteLLM.
--
-- engine_token is only needed for /admin/* on the engine; /v1/* is
-- public per the contract. We store it anyway for power-user flows.
-- engine_meta caches the last successful /.well-known/inference-engine.json
-- response so the picker can render version / features without a probe
-- round-trip on every render.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS engine_url text,
  ADD COLUMN IF NOT EXISTS engine_token text,
  ADD COLUMN IF NOT EXISTS engine_meta jsonb;
