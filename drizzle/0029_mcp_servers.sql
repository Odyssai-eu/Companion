-- External MCP servers — Companion becomes a CLIENT of arbitrary MCP
-- servers (Notion, Qdrant, Linear, GitHub, …). Their tools are merged
-- into the toolset Companion exposes to the LLM at chat time. The slug
-- namespaces the tool names (`mcp_<slug>_<tool>`) so a Notion `search`
-- doesn't collide with a Qdrant `search`.
--
-- transport: 'streamable_http' (modern) or 'sse' (legacy). stdio is
-- deliberately not supported in v1 — spawning child processes inside
-- the Docker container is more trouble than it's worth, and most
-- hosted MCP servers expose HTTP variants.
--
-- auth_header: a full header value the user provides verbatim, e.g.
-- "Bearer sk_test_…" or "X-API-Key abc123". Optional. Stored as plain
-- text on a per-user row — same trust model as litellm_api_key.
--
-- tools_cache stores the last successful `tools/list` response so the
-- chat path can build the LLM tools array without an extra round-trip
-- on every turn. Refreshed lazily (5 min TTL) or via explicit POST
-- /refresh from the UI.

CREATE TABLE IF NOT EXISTS mcp_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('streamable_http', 'sse')),
  url text NOT NULL,
  auth_header text,
  enabled boolean NOT NULL DEFAULT true,
  tools_cache jsonb,
  tools_cache_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

CREATE INDEX IF NOT EXISTS mcp_servers_user_id_idx ON mcp_servers (user_id);
