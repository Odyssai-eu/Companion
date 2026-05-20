# MCP servers

Companion is a **client** of remote Model Context Protocol servers. Register Notion, Linear, GitHub, Tavily, your own — and their tools merge into the toolset the agent sees, prefixed `mcp_<slug>_<tool>` to dodge name collisions.

## What MCP is, briefly

Model Context Protocol — a standard JSON-RPC protocol for exposing tools to LLM agents. Two transports: **Streamable HTTP** (2025 spec, what Companion prefers) and **SSE** (older, still common).

A server speaks four core methods:

- `tools/list` — return the tool schemas.
- `tools/call(name, args)` — invoke a tool.
- `resources/list` and `resources/read` — for static documents (optional).
- `prompts/list` — for named prompts the server publishes (optional).

When you wire an MCP server into Companion, the agent's toolbox grows.

## Adding a server

*Settings → Extensions → MCP servers → Add*. Three pieces:

- **URL** — the server's HTTP endpoint.
- **Transport** — `streamable_http` (preferred, 2025 spec) or `sse` (older fallback).
- **Auth** — `bearer` (paste your token), `oauth` (full OAuth 2.1 + PKCE flow including Dynamic Client Registration), or `none`.

The page ships **quick-add presets** for common servers. Pick a preset and you only fill in the differentiator (the token, or sign in via OAuth).

## Quick-add presets

| Preset | Auth | Notes |
|---|---|---|
| **Notion** | OAuth | Pages, databases, search. Sign in opens Notion's consent screen. |
| **Linear** | OAuth | Issues, projects, comments. |
| **GitHub** | OAuth via Copilot MCP | Repos, issues, PRs. Requires a Copilot subscription on the GitHub side. |
| **Tavily** | Bearer | Web search + extract. Paste your Tavily API key. |
| **Obsidian** | Bearer | LAN-hosted bridge. Vault read. |
| **Filesystem** | Bearer | LAN-hosted MCP fs server. Local files. |

Anything that speaks MCP works — these are just the ones with one-click presets. For others, click **Custom** and enter URL + auth manually.

## OAuth flow (Notion, Linear, GitHub)

For OAuth-protected servers:

1. Pick the preset and click **Sign in**.
2. The provider's consent screen opens in a new tab.
3. After approval you're redirected to `/api/mcp-oauth/callback`. The window closes itself; the server's status flips to green.
4. The refresh token is stored encrypted. The access token rotates automatically (Companion handles the refresh; you don't see the rotation).

**To revoke**: hit **Disconnect** on the row → Companion drops both tokens locally. The provider-side revocation is up to you (in your Notion/Linear/GitHub settings).

The Dynamic Client Registration (DCR) part of the OAuth 2.1 spec is handled transparently: Companion registers itself as a client at provider sign-in time. You see the OAuth UI; you don't manage client IDs.

## Bearer flow (Tavily, custom)

1. Get your API key from the provider.
2. Click **Add** → paste URL + token.
3. Save. Companion does a `tools/list` round-trip; if successful, the row shows the tool count.

The token is stored encrypted, scoped to your user.

## Tools cache

When you save a server, Companion calls `tools/list` once and caches the schema for 5 minutes. New servers pay a synchronous fetch on the first chat; subsequent turns are instant. The TTL avoids racing the provider every turn.

If a server changes its toolset, click **Refresh** on the row to invalidate the cache.

## What the agent does with MCP tools

Tools coming from MCP servers are gated on the per-conversation **agent mode** toggle (chat header → mode switcher).

- **Agent mode OFF** — no MCP tools sent to the model. Cheap prompt.
- **Agent mode ON** — Companion sends the union of:
  - workspace `fs_*` tools (always on when agent mode is on),
  - RAG `rag_search` (when configured),
  - web search (when the Tavily add-on is enabled),
  - every enabled MCP server's tools, prefixed `mcp_<slug>_<tool>`.

**Skill tools are the exception** — they're always on regardless of agent mode, so the model can curate skills in any chat.

## Tool name collisions

Two MCP servers can both expose a `search` tool — Companion prefixes them as `mcp_notion_search` and `mcp_linear_search` to disambiguate. The model sees the prefixed names; you don't have to manage them.

## Enabling / disabling without removing

Each row has an **Enabled** toggle. When off:

- `tools/list` is skipped on the next refresh.
- Tools aren't injected into the chat.
- The row stays in the list; flipping back on resumes service.

Useful when you want to keep auth wired up but don't want the tools active right now (e.g. a noisy server).

## When a server fails

A 5xx / auth lapse / DNS drop on `tools/list`:

- Logged in the row's `lastError` field (visible in the Settings UI).
- The cached toolset stays valid until TTL expires (so you don't lose tools on a transient blip).
- After TTL expires with a still-failing server: the tools drop out of the catalog. Your other servers' tools still work.

To force a retry: click **Refresh** on the row.

## Security model

- Tokens are stored encrypted, scoped to the user.
- Revocable any time from the row.
- A failed server (auth lapse, DNS drop, 5xx) is logged and skipped — the rest of the toolset still works that turn.
- Companion never logs the token value in normal operation. If a tool call returns an auth error, the error is logged sanitized.
- Companion does NOT proxy your tokens to the LLM. The model sees tool *invocations*; the token is added server-side at the HTTP layer.

## Performance considerations

- Every tool definition you inject adds prompt tokens. A heavy MCP setup (10 servers × 8 tools each) can add ~5-10k tokens per turn.
- The tools schemas are short by MCP convention (name + description + JSON schema). But it adds up.
- For latency-sensitive chats, disable MCP servers you don't need for that conversation. The toggle is per-server, not per-conversation, so a workflow is: have a "lean" set of servers enabled by default, flip on the heavy ones when needed.

## OAuth troubleshooting

**Sign-in returns to Companion but the row stays red**
The state token expired (10-min TTL) or the OAuth scope wasn't granted. Click **Reconnect** to retry.

**Notion shows "couldn't reach the server"**
Companion's OAuth callback is hosted at the same origin as the app. If `dev.thecomp.ai` is behind a tunnel that's dropped, the callback never completes. Reload the page, retry sign-in.

**Token revoked on the provider side**
Click **Reconnect** to re-run the OAuth dance.

## Related

- *Agents tokens* (13) — the flip side: Companion exposing itself as an MCP server
- *Inference settings* (14) — agent mode lives in the cogwheel + chat header
- *Privacy & data* (18) — how MCP tokens are stored
