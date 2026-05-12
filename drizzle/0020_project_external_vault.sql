-- Live external vault path for project memory.
--
-- Distinct from the existing project_memory_files table:
--   - project_memory_files = files COPIED into the DB (via ZIP upload)
--   - external_vault_path  = absolute path on the gateway filesystem
--                             that the chat route reads LIVE every turn,
--                             no copy. Changes on disk surface in the
--                             next chat message.
--
-- Both can be set on the same project; they're concatenated into the
-- system prompt.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS external_vault_path text;
