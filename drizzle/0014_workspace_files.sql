-- 0014_workspace_files.sql
-- Per-user virtual filesystem for the agentic UX layer.
-- v1: text-only, DB-backed. Future: blobs via storage backend.

CREATE TABLE IF NOT EXISTS workspace_files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path        text NOT NULL,
  content     text NOT NULL,
  size_bytes  integer NOT NULL,
  mime_type   text NOT NULL DEFAULT 'text/plain',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_files_user_path_unique UNIQUE (user_id, path)
);

CREATE INDEX IF NOT EXISTS workspace_files_user_idx
  ON workspace_files(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS workspace_files_user_path_prefix_idx
  ON workspace_files(user_id, path text_pattern_ops);
