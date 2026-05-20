# MCP servers

Companion is a **client** of remote Model Context Protocol servers. Register Notion, Linear, GitHub, Tavily, your own — and their tools merge into the toolset the agent sees, prefixed `mcp_<slug>_<tool>` to dodge name collisions.

## Adding a server

*Settings → Extensions → MCP servers → Add*. Three pieces:

- **URL** — the server's HTTP endpoint (Streamable HTTP or SSE).
- **Transport** — `streamable_http` (the 2025 spec) or `sse` (older).
- **Auth** — `bearer` (paste your token), `oauth` (full OAuth 2.1 + PKCE flow including Dynamic Client Registration), or `none`.

The page ships **quick-add presets** for Notion, GitHub, Tavily, Obsidian, Linear, Filesystem. Pick one and you only type the token (or sign in via OAuth).

## OAuth servers

For OAuth-protected servers (Notion, Linear, GitHub):

1. Pick the preset and click **Sign in**.
2. The provider's consent screen opens in a new tab.
3. After approval you're redirected to `/api/mcp-oauth/callback`. The window closes itself; the server's status flips to green.
4. The refresh token is stored encrypted; the access token rotates automatically.

To revoke, hit **Disconnect** on the row — Companion drops both tokens locally (the provider-side revocation is on you).

## Tools cache

When you save a server, Companion calls `tools/list` once and caches the schema for 5 minutes. New servers pay a synchronous fetch on the first chat; subsequent turns are instant. The TTL avoids racing the provider every turn.

If a server changes its toolset, click **Refresh** on the row to invalidate the cache.

## What the agent does with them

Tools coming from MCP servers are gated on the per-conversation **agent mode** toggle (chat header → mode switcher). Off = no tools sent to the model at all. On = Companion sends the union of:

- workspace `fs_*` tools (always on when agent mode is on),
- RAG `rag_search` (when configured),
- web search (when the Tavily add-on is enabled),
- every enabled MCP server's tools.

Skill tools are the exception — they're always on regardless of agent mode, so the model can curate skills in any chat.

## Security model

- Tokens are stored encrypted, scoped to the user.
- Revocable any time from the row.
- A failed server (auth lapse, DNS drop, 5xx) is logged and skipped — the rest of the toolset still works that turn.

## Common servers

| Server | Notes |
|---|---|
| **Notion** | OAuth. Pages, databases, search. |
| **Linear** | OAuth. Issues, projects, comments. |
| **GitHub** | OAuth via the Copilot MCP endpoint. Repos, issues, PRs. |
| **Tavily** | Bearer with API key in query string. Web search. |
| **Obsidian** | Bearer to a user-hosted bridge over LAN. Vault read. |
| **Filesystem** | Bearer to a user-hosted MCP fs server. Local files. |

Anything that speaks MCP works — these are just the ones with one-click presets.
