# Agents tokens (Companion as MCP brain)

Same MCP protocol, flipped direction. *Settings → Extensions → MCP servers* makes Companion a **client** of remote servers. *Settings → Extensions → Agents tokens* makes Companion an **MCP server** that external agents (Claude Desktop, Cline, Continue.dev, Cowork, …) can call **back into** for memory + skills + conversations.

The pitch: the IDE stays the IDE. Companion stays the brain.

## What the brain exposes

Tools live at `<companion-host>/api/mcp` (dev: `https://dev.thecomp.ai/api/mcp`). Categories:

**Memory & skills** — `companion_search_memory`, `companion_remember`, `companion_list_skills`, `companion_get_skill`, `companion_create_skill`, `companion_update_skill`, `companion_delete_skill`, `companion_import_skill_md`.

**Conversations** — `companion_list_conversations`, `companion_create_conversation`, `companion_get_conversation`, `companion_set_conversation_memory`, `companion_delete_messages_from`, `companion_export_md`.

**Inference (non-blocking)** — `companion_send_message`, `companion_get_inference_status`, `companion_list_models`.

**Projects** — `companion_list_projects`, `companion_get_project`.

The Settings page is the source of truth for the live catalog; this guide tracks the shape.

## Minting a token

1. *Settings → Extensions → Agents tokens → New token*.
2. Pick a TTL — 24h / 30d / 90d / no-expiry.
3. The plain `hms_…` token is shown **once**. Copy it now — only the prefix is kept after this screen.

Stored hashed-at-rest. Revoke any time from the same page.

## Connecting an external client

The page ships ready-to-paste configs. Shapes:

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "companion": {
      "url": "https://dev.thecomp.ai/api/mcp",
      "headers": { "Authorization": "Bearer hms_…" }
    }
  }
}
```

**Continue.dev** (`~/.continue/config.yaml`):

```yaml
mcpServers:
  - name: companion
    url: https://dev.thecomp.ai/api/mcp
    requestOptions:
      headers:
        Authorization: Bearer hms_…
```

**Cline** (VS Code) — MCP Servers → Add → HTTP. URL + `Authorization: Bearer hms_…` header, transport Streamable HTTP.

**curl smoke test**:

```bash
curl -s -X POST 'https://dev.thecomp.ai/api/mcp' \
  -H 'Authorization: Bearer hms_…' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Patterns to copy

- **Recall before answering** — `companion_search_memory(query)` returns the top chunks from your global wiki + project memory. Have your IDE agent call this before every non-trivial question.
- **Persist a learning** — after solving a sticky problem, `companion_remember(projectId, title, body)`. Next session, the next agent finds it.
- **Load a tuned skill** — `companion_get_skill("code-review-strict")` and prepend the body to the agent's task instructions.
- **Cross-session continuation** — start a chat on desktop, continue on phone via Companion, jump back into VS Code — the conversation is the source of truth, clients are lenses.

## Security model

- **One user per token.** Every call runs as the token owner; no cross-tenant access.
- **Read-mostly.** The global wiki is read-only over MCP by design. `companion_remember` writes only to project-scoped rows.
- **Inference is non-blocking.** `companion_send_message` returns immediately after the server accepts; the IDE polls `companion_get_inference_status`. This is why long reasoner runs (Cowork-style, ~120s) don't blow MCP's 45s client timeout.
- **Tokens are revocable.** Tip: mint a short-TTL token per machine. If a laptop disappears, revoke just that one.

## When *not* to use this

- Editing files on your laptop — the IDE wins there. Companion's `fs_*` tools are deliberately not exposed over MCP.
- Running shell commands — that's the IDE-side runtime (Cline's exec, Continue's tools).
- Writing to your global wiki — too easy to pollute. Curate by hand.
