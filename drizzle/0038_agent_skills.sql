-- Agent skills — markdown instruction packages the chat model can load
-- on demand. Distinct from `prompt_skills` (saved system-prompt presets
-- the user picks from the dropdown in the chat panel).
--
-- The chat model creates / lists / reads / updates / deletes these
-- itself via the `skill_*` built-in tools. When the user says "save
-- this as a skill", "use the X skill", etc., the model invokes the
-- relevant tool. No client-side UI mounts these for direct user
-- selection — they're agent-curated.
--
-- Compatible with Anthropic's Agent Skills format: name + description
-- (when-to-use trigger) + body (markdown). Tags are free-form.
--
-- source = 'user' (created by the operator via direct DB / future Settings UI)
--        | 'agent' (created by the chat model via skill_create tool)
--        | 'imported' (bulk-loaded from an external library, e.g.
--                     Anthropic's published skills)

CREATE TABLE IF NOT EXISTS agent_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  body text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'agent',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One name per user. Tools look up by name; collisions confuse the
-- agent (which copy is "the" code-review skill?). Enforce uniqueness
-- so skill_create either succeeds or fails cleanly with a clear error.
CREATE UNIQUE INDEX IF NOT EXISTS agent_skills_user_name_unique
  ON agent_skills (user_id, lower(name));

CREATE INDEX IF NOT EXISTS agent_skills_user_id_idx
  ON agent_skills (user_id);
