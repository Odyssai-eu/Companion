-- Agent sessions — `/hermes` (and future `/pi`, `/openclaude`, etc.)
-- spawn an agent sub-thread inside a Companion conversation. Each sub-
-- thread is a persistent session against an external agent bridge (the
-- niveau-1 architecture is one Hermes ACP subprocess on the operator's
-- workstation, niveau-2 will be a node daemon per user).
--
-- Why two tables instead of overloading `messages`:
--   - Different lifecycle: agent messages don't go through the main LLM
--     chat path, no system prompts injected, no memory compile picks
--     them up, no `stats.routedFrom` semantics.
--   - Different role enum: 'agent' vs 'assistant' — keeps the UI rendering
--     decisions explicit (AgentBubble vs MessageBubble).
--   - Different ownership of the session id: ours is local, bridgeSessionId
--     points at the agent's own session (Hermes' ACP sessionId, or
--     equivalent for other agents).
--
-- One session per (conversationId, agentKind). Re-invoking `/hermes` in
-- a conv that already has a hermes session continues that session
-- (persistent). Future: support multiple parallel sessions of same kind
-- if a real use case appears (probably not — the UX would get confusing).

CREATE TABLE IF NOT EXISTS agent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  -- 'hermes', 'pi', 'openclaude', etc. Free-form string for now so we
  -- don't need a migration when adding a new agent.
  agent_kind text NOT NULL,
  -- The bridge's own session identifier (e.g. Hermes ACP sessionId).
  -- Nullable because we may create our row first and lazily request
  -- a bridge session on the first prompt.
  bridge_session_id text,
  -- Free-form jsonb for agent-specific config (cwd, model override, etc.)
  config jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_sessions_user_id_idx ON agent_sessions (user_id);
CREATE INDEX IF NOT EXISTS agent_sessions_conv_idx ON agent_sessions (conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS agent_sessions_conv_kind_uniq
  ON agent_sessions (conversation_id, agent_kind);

CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  -- 'user' = what the operator typed after `/hermes`
  -- 'agent' = agent's reply
  -- 'tool' = tool invocation surfaced for transparency (file write, shell, etc.)
  role text NOT NULL CHECK (role IN ('user', 'agent', 'tool')),
  content text NOT NULL DEFAULT '',
  -- Per-message metadata: tokens, ms, tool_name, tool_args, errors, etc.
  stats jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_messages_session_idx
  ON agent_messages (session_id, created_at);
