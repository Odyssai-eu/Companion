-- Global user memory vault — the user-scoped twin of the per-project
-- vault (project_memory_files + projects.external_vault_path). Lets
-- the user seed and pilot their global wiki manually:
--
--   * ZIP upload  →  user_memory_files (DB-stored, 1 MB / file, 50 MB / corpus)
--   * Linked external path  →  users.external_vault_path  (read live every turn,
--                              absolute filesystem path on the gateway host,
--                              or a tcai://... cross-link in the future)
--
-- Coexists with the Karpathy auto-compile by default. Flip auto_memory_enabled
-- to false to bypass the memory service entirely and use ONLY the user-curated
-- corpus.

-- Per-user vault inputs
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS external_vault_path text,
  ADD COLUMN IF NOT EXISTS external_vault_read_only boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_memory_enabled boolean NOT NULL DEFAULT true;

-- ZIP-imported user corpus. Same shape as project_memory_files but scoped
-- by user, cascade-deleted with the user.
CREATE TABLE IF NOT EXISTS user_memory_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  path        text NOT NULL,
  mime_type   text NOT NULL DEFAULT 'text/markdown',
  size_bytes  integer NOT NULL,
  content     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, path)
);

CREATE INDEX IF NOT EXISTS user_memory_files_user_idx
  ON user_memory_files (user_id);
