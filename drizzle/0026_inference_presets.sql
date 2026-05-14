-- Inference presets — named bundles of LLM sampling parameters the user
-- can save and reload. System prompt is intentionally NOT included (it's
-- saved separately at project level). Each preset can optionally bind to
-- a specific model id; applying the preset then ALSO switches the model.
--
-- hf_reference_url is a free-text link the user keeps to document where
-- a preset comes from (e.g. a HuggingFace model card section). Pure
-- documentation, never followed by the server.

CREATE TABLE IF NOT EXISTS inference_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Optional model binding. When set, applying the preset also picks
  -- this model in the chat picker. NULL = generic preset, applies to
  -- whatever model is currently selected.
  model_id text,
  -- LLM sampling params. All nullable so "leave default" is a first-class
  -- choice (don't push the param to upstream → engine uses its own).
  temperature double precision,
  top_p double precision,
  top_k integer,
  min_p double precision,
  repetition_penalty double precision,
  max_tokens integer,
  seed bigint,
  hf_reference_url text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS inference_presets_user_id_idx
  ON inference_presets (user_id);
