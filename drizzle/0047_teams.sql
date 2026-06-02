-- 0047_teams.sql
-- Teams layer: a user belongs to N teams, each team has its own
-- LightRAG memory collection (nemo-memory working_dir/{teamId}/).

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  team_id   uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      text NOT NULL DEFAULT 'member',  -- 'admin' | 'member'
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX team_members_user_idx ON team_members(user_id);

-- Projects can be scoped to a team. NULL = personal project.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX projects_team_idx ON projects(team_id) WHERE team_id IS NOT NULL;
