-- OAuth 2.1 + PKCE for MCP servers — phase B of the MCP-as-client work.
--
-- Notion's hosted MCP server (and increasingly GitHub, Linear, etc.) require
-- OAuth instead of static bearer tokens. We extend mcp_servers with the
-- token bookkeeping + a small pending-auth table for the in-flight
-- authorization-code → token exchange.
--
-- auth_kind:
--   'bearer' — static value in auth_header (existing behaviour)
--   'oauth'  — use the OAuth columns below; auth_header ignored
--   'none'   — no auth needed (some local MCP servers)
--
-- oauth_metadata caches the discovered `.well-known/oauth-authorization-server`
-- response so we don't refetch it on every refresh. Includes the
-- authorization_endpoint, token_endpoint, registration_endpoint, scopes,
-- code_challenge_methods_supported, etc.
--
-- DCR (Dynamic Client Registration, RFC 7591): the OAuth server returns a
-- client_id (+ optional client_secret) at registration time. Stored
-- per-mcp-server-row so each Companion install has its own identity to
-- each upstream OAuth provider.

ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS auth_kind text NOT NULL DEFAULT 'bearer',
  ADD COLUMN IF NOT EXISTS oauth_metadata jsonb,
  ADD COLUMN IF NOT EXISTS oauth_client_id text,
  ADD COLUMN IF NOT EXISTS oauth_client_secret text,
  ADD COLUMN IF NOT EXISTS oauth_access_token text,
  ADD COLUMN IF NOT EXISTS oauth_refresh_token text,
  ADD COLUMN IF NOT EXISTS oauth_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS oauth_scopes text[];

-- Pending authorization codes — created at /oauth/start, consumed at
-- /oauth/callback. Single-use, 10-min TTL. We need this server-side to
-- bind the OAuth `state` param to the originating user + server row,
-- plus to keep the PKCE code_verifier secret from the browser.
CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  state text NOT NULL UNIQUE,
  code_verifier text NOT NULL,
  redirect_uri text NOT NULL,
  scopes text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_oauth_pending_state_idx
  ON mcp_oauth_pending (state);
CREATE INDEX IF NOT EXISTS mcp_oauth_pending_created_at_idx
  ON mcp_oauth_pending (created_at);
