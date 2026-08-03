-- v2.0 « Cowork » α1 — agent runtime schema.
-- Plan: PLAN.md (locked 2026-08-03, 4 review rounds). Creates the agent
-- registry, sub-conversation columns, task messages, run_events and
-- agent_spans. All idempotent (IF NOT EXISTS) per repo convention.

-- ── agents ────────────────────────────────────────────────────────────
-- user_id NULL = instance-level row (builtin or admin-defined), inherited
-- by every user; user_id set = personal agent. Same asymmetric pattern as
-- addons — ALL reads go through server/lib/agent-rows.ts, never bare
-- eq(userId) queries.
CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  mode text NOT NULL DEFAULT 'subagent',
  system_prompt text NOT NULL,
  model text,
  tools_allow text[] NOT NULL DEFAULT '{}'::text[],
  max_steps integer NOT NULL DEFAULT 15,
  source text NOT NULL DEFAULT 'user',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_mode_check CHECK (mode IN ('primary', 'subagent')),
  CONSTRAINT agents_source_check CHECK (source IN ('builtin', 'instance', 'user')),
  -- Builtins are always instance-level rows.
  CONSTRAINT agents_builtin_instance_check CHECK (source <> 'builtin' OR user_id IS NULL),
  CONSTRAINT agents_name_format CHECK (
    name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) BETWEEN 1 AND 64
  )
);

-- Partial uniques: one name per user, one name in the instance namespace.
CREATE UNIQUE INDEX IF NOT EXISTS agents_user_name_uniq
  ON agents (user_id, name) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agents_instance_name_uniq
  ON agents (name) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS agents_user_id_idx ON agents (user_id);

-- ── conversations: sub-conversation columns ───────────────────────────
-- parent_id set = sub-conversation (spawned by the task tool). Cascade:
-- deleting the parent removes its sub-conversations.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS agent_name text,
  ADD COLUMN IF NOT EXISTS agent_prompt_snapshot text;

-- Root-conversation listings (sidebar, exports, scheduler) filter on
-- parent_id IS NULL — partial index keeps them off full scans.
CREATE INDEX IF NOT EXISTS conversations_root_idx
  ON conversations (user_id, updated_at DESC) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS conversations_parent_idx
  ON conversations (parent_id) WHERE parent_id IS NOT NULL;

-- ── messages: task cards ──────────────────────────────────────────────
-- message_type (NOT 'kind' — avoids confusion with conversations.kind):
-- 'chat' = normal dialogue, 'task' = persistent task card in the parent
-- thread, payload = {sub_conversation_id, agent, description, status,
-- result_summary}.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS payload jsonb;

DO $$ BEGIN
  ALTER TABLE messages ADD CONSTRAINT messages_message_type_check
    CHECK (message_type IN ('chat', 'task'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── run_events ────────────────────────────────────────────────────────
-- Append-only live-UI event stream (task_started, tool_call, step,
-- heartbeat, task_done, …). NOT a source of truth — the thread is.
-- 30-day retention via memory-scheduler purge job (ships in β).
CREATE TABLE IF NOT EXISTS run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_events_conv_created_idx
  ON run_events (conversation_id, created_at);
-- BRIN: near-free at insert, good enough for time-range purge scans.
CREATE INDEX IF NOT EXISTS run_events_created_brin
  ON run_events USING brin (created_at);

-- ── agent_spans ───────────────────────────────────────────────────────
-- Post-hoc tracing (llm/tool/task). OTLP-inspired NAMING only — no W3C
-- trace-context conformance claimed. 30-day retention, batched purge.
CREATE TABLE IF NOT EXISTS agent_spans (
  span_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_span_id uuid,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent text NOT NULL,
  type text NOT NULL,
  tokens_in integer,
  tokens_out integer,
  duration_ms integer,
  status text NOT NULL DEFAULT 'ok',
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_spans_type_check CHECK (type IN ('llm', 'tool', 'task'))
);
CREATE INDEX IF NOT EXISTS agent_spans_conv_idx
  ON agent_spans (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS agent_spans_created_brin
  ON agent_spans USING brin (created_at);
