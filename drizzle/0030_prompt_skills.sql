-- Skills v1 — a user-owned, DB-backed library of named system prompts.
-- The chat-side "System prompt" section of the InferencePanel can now
-- load these by name, mirroring the inference-presets pattern.
--
-- Why a new table instead of reusing inference_presets:
--   - Different shape: presets carry sampling params, skills carry
--     prose. Mixing would force null columns everywhere and confuse
--     the UI.
--   - Different lifecycle: presets often bind to a model id, skills
--     are model-agnostic.
--   - Different cardinality: power users may have 50+ skills, 5-10
--     presets. Separate tables keep both queries fast.
--
-- The localStorage `prompt-library` from the old client-only flow
-- stays in place (legacy users); migration of its content to this
-- table happens lazily on first SkillsRow render (one-shot import
-- prompt in the UI).

CREATE TABLE IF NOT EXISTS prompt_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  body text NOT NULL,
  -- Free-text tags for filtering. Power users will categorize:
  -- "writing", "code-review", "research", etc.
  tags text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prompt_skills_user_id_idx ON prompt_skills (user_id);
