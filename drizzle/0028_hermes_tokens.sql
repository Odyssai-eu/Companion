-- Hermes tokens — scoped service tokens used by the Hermes Agent (and
-- Cowork dispatch) to call back into Companion on behalf of a user, via
-- the thecompai-mcp MCP server. Plain token is shown once at mint time;
-- only the sha256 hash is persisted.
--
-- Scope is per-user (large). conv_id is optional metadata for audit but
-- does NOT restrict which conv the token can act on.

CREATE TABLE IF NOT EXISTS hermes_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text,
  -- Optional: the conversation that triggered the mint (auto-mint path).
  -- NULL for manual / Cowork-dispatch tokens.
  conv_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  -- 'hermes' (auto-mint, short TTL) | 'cowork' (manual, long TTL)
  source text NOT NULL DEFAULT 'hermes',
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hermes_tokens_token_hash_idx
  ON hermes_tokens (token_hash);

CREATE INDEX IF NOT EXISTS hermes_tokens_user_created_idx
  ON hermes_tokens (user_id, created_at DESC);
