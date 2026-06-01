-- 0046_audit_log_enterprise.sql
-- Extend auth_log with enterprise audit fields: project scope, resource
-- type/id, so DPOs can query "who accessed what project memory, when".

ALTER TABLE auth_log
  ADD COLUMN IF NOT EXISTS project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resource_type text,   -- 'memory' | 'tool' | 'guest' | 'decision'
  ADD COLUMN IF NOT EXISTS resource_id   text;   -- opaque id of the resource

CREATE INDEX IF NOT EXISTS auth_log_project_idx
  ON auth_log(project_id, created_at DESC)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS auth_log_resource_idx
  ON auth_log(resource_type, created_at DESC)
  WHERE resource_type IS NOT NULL;
