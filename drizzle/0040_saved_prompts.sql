-- Saved prompts — user-owned library of named system prompts. Brought
-- back after the v1.0.89 cleanup retired `prompt_skills` (migration
-- 0030 → reverted in 0039 alongside the skills format alignment).
--
-- Why a fresh table instead of resurrecting prompt_skills:
--   - Cleaner separation: agent_skills are model-callable tools,
--     saved_prompts are user-pickable system prompts. operator's call.
--   - No legacy migration baggage from the old client-localStorage
--     prompt-library — that migration was already done last cycle.
--   - Schema can stay minimal: id, name, body. No tags / description
--     yet — keep it lean and add fields when there's a real ask.
--
-- The InferencePanel's "System prompt" section gets back its
-- Load saved... dropdown + Save current + Export + Import. The
-- chat textarea below remains for one-off conv-level overrides.

CREATE TABLE IF NOT EXISTS saved_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saved_prompts_user_id_idx ON saved_prompts (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS saved_prompts_user_name_uniq
  ON saved_prompts (user_id, name);
