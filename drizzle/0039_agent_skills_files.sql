-- Phase 1 of the Agent Skills format rollout — align agent_skills with
-- the agentskills.io specification.
--
-- 1. Drop `prompt_skills`. The chat panel's "saved system prompts"
--    feature is retired — the textarea stays for one-off conv-level
--    overrides, but there's no save/load anymore. If the user wants a
--    reusable named prompt, they ask Nemo to create a skill in
--    agent_skills instead.
--
-- 2. Extend agent_skills to match the spec
--    (https://agentskills.io/specification):
--    - `license`      : optional string, license name / file ref.
--    - `compatibility`: optional 1-500 chars, env requirements.
--    - `files`        : map of relative paths
--                       (scripts/foo.py, references/notes.md,
--                       assets/template.html, …) to contents. Keeps
--                       every skill package inside Postgres as one row
--                       — no filesystem sprawl, transactional updates,
--                       trivial backup.
--    - `metadata`     : jsonb stash for arbitrary frontmatter
--                       extensions (version, author, …).
--
-- 3. Enforce naming convention via CHECK:
--    1-64 chars, lowercase a-z / 0-9 / hyphen, no leading/trailing
--    hyphen, no consecutive hyphens.
--    Plus description max 1024 chars (spec hard limit).
--
-- Existing agent_skills rows are empty at this point (verified
-- 2026-05-20), so adding CHECK constraints retroactively is safe.

DROP TABLE IF EXISTS prompt_skills;

ALTER TABLE agent_skills
  ADD COLUMN IF NOT EXISTS license text,
  ADD COLUMN IF NOT EXISTS compatibility text,
  ADD COLUMN IF NOT EXISTS files jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Strict name validation per the spec. POSIX regex (no lookahead):
-- `^[a-z0-9]+(-[a-z0-9]+)*$` ensures:
--   - starts and ends with alnum (no leading / trailing hyphen)
--   - only lowercase a-z, 0-9, and single hyphens
--   - no consecutive hyphens (each hyphen is bracketed by alnum)
ALTER TABLE agent_skills
  DROP CONSTRAINT IF EXISTS agent_skills_name_format,
  ADD  CONSTRAINT agent_skills_name_format
       CHECK (
         name ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
         AND length(name) BETWEEN 1 AND 64
       );

ALTER TABLE agent_skills
  DROP CONSTRAINT IF EXISTS agent_skills_description_length,
  ADD  CONSTRAINT agent_skills_description_length
       CHECK (description IS NULL OR length(description) BETWEEN 1 AND 1024);

ALTER TABLE agent_skills
  DROP CONSTRAINT IF EXISTS agent_skills_compatibility_length,
  ADD  CONSTRAINT agent_skills_compatibility_length
       CHECK (compatibility IS NULL OR length(compatibility) BETWEEN 1 AND 500);
