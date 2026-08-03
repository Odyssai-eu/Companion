-- v3 core (PLAN.md V3-a, approved by Kimi K3 after 3 rounds).
--
-- 1. messages.parts — the typed-parts log, THE source of truth of an
--    assistant turn under the v3 rail. `content` stays mirrored (concat
--    of text parts) so every downstream consumer (memory, exports, MCP)
--    keeps working during the migration. Additive, zero rupture.
-- 2. turn_states — durable per-conversation turn record (single-flight,
--    sidebar badge, MCP status polling, cross-tab placeholder, prewarm
--    in-flight guard, STOP semantics). In-memory turn state is the
--    documented amnesia bug class — hence a table.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS parts jsonb;

CREATE TABLE IF NOT EXISTS turn_states (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active',
  cancel_requested boolean NOT NULL DEFAULT false,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turn_states_status_check
    CHECK (status IN ('active', 'done', 'error', 'stopped'))
);
CREATE INDEX IF NOT EXISTS turn_states_status_idx ON turn_states (status);
CREATE INDEX IF NOT EXISTS turn_states_updated_brin
  ON turn_states USING brin (updated_at);
