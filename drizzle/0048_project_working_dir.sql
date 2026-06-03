-- 0048_project_working_dir.sql
-- Per-project working directory on the user's machine. companion-local
-- executes bash/fs in this dir. NULL = default (~/companion).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS working_dir text;
