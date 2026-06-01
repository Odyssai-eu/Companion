-- 0045_decisions.sql
-- Decision Log: append-only structured decisions scoped to a project.
-- The wiki says what is *true*; the decision log says what was *decided* and why.
-- No UPDATE, no hard DELETE — a wrong decision gets a superseding entry.

CREATE TABLE decisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  -- What was decided (one line)
  title       text NOT NULL,
  -- Why the decision was needed
  context     text NOT NULL DEFAULT '',
  -- What was considered and rejected
  alternatives text NOT NULL DEFAULT '',
  -- What was retained
  choice      text NOT NULL DEFAULT '',
  -- Why this choice
  rationale   text NOT NULL DEFAULT '',
  -- Optional: when to revisit
  revisit_by  date,
  -- Soft-delete only — append-only contract
  deleted_at  timestamp with time zone,
  created_at  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX decisions_project_idx ON decisions(project_id, created_at DESC);
CREATE INDEX decisions_created_by_idx ON decisions(created_by);

-- Full-text search index (same pattern as messages)
CREATE INDEX decisions_fts_idx ON decisions
  USING gin(to_tsvector('english', title || ' ' || context || ' ' || choice || ' ' || rationale));
