-- Per-project memory feature.
--
-- Three toggles on the project itself, plus a per-project file corpus
-- (vault import target). The "memory_enabled" flag stays as the master
-- switch for ANY memory injection at all.
--
-- Semantics of the new flags (composable):
--   memory_enabled                  master on/off. When false, NOTHING is
--                                   injected — the next two are ignored.
--   dedicated_memory_enabled        when true, the project's own corpus
--                                   (files in project_memory_files) is
--                                   injected into the system prompt for
--                                   every conversation in the project.
--                                   Independent storage from the global
--                                   user wiki.
--   global_memory_read_only         when true, the global user wiki IS
--                                   injected (read-only), but the per-turn
--                                   triggerCompile / scheduled compile do
--                                   NOT update the wiki from this project's
--                                   conversations. Use when a project
--                                   should benefit from prior wisdom
--                                   without polluting it.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS dedicated_memory_enabled boolean
  NOT NULL DEFAULT false;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS global_memory_read_only boolean
  NOT NULL DEFAULT false;

-- Per-project corpus. Modeled like workspace_files (DB-backed) so we
-- don't depend on a filesystem the container may not have. Path is the
-- destination within the project's virtual vault (e.g. "concepts/foo.md").
-- Storage is the same bytea-equivalent text column used for workspace
-- files — small enough for vault snippets but capped via quota.
CREATE TABLE IF NOT EXISTS project_memory_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  mime_type text NOT NULL DEFAULT 'text/markdown',
  size_bytes integer NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, path)
);

CREATE INDEX IF NOT EXISTS project_memory_files_project_idx
  ON project_memory_files (project_id);
