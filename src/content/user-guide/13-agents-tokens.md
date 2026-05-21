# Agents tokens (Companion as MCP brain)

Same MCP protocol, flipped direction.

- *Settings → Extensions → MCP servers* makes Companion a **client** of remote servers (Notion, Linear, …).
- *Settings → Extensions → Agents tokens* makes Companion **an MCP server** that external agents (Claude Desktop, Cline, Continue.dev, Cowork) call **back into** for memory + skills + conversations.

**The pitch**: the IDE stays the IDE (file edits, shell, terminal). Companion stays the brain (memory, skills, cross-session continuation, multi-model orchestration). Different layers, MCP between them.

## What the brain exposes

Tools live at `<companion-host>/api/mcp` (dev: `https://dev.thecomp.ai/api/mcp`).

### Memory & skills

- `companion_search_memory(query, limit?)` — semantic search over global wiki + project memory. Returns top chunks with source path + similarity score.
- `companion_remember(projectId, title, body)` — write a markdown note into the project's `agent-notes/` folder. Read-only for the global wiki (deliberate — no auto-pollution from external agents).
- `companion_list_skills()` — catalog of saved skills (name + description + tags).
- `companion_get_skill(name)` — full body of a skill.
- `companion_create_skill / update_skill / delete_skill` — curate the library.
- `companion_import_skill_md(content)` — parse a pasted SKILL.md.

### Conversations

- `companion_list_conversations(projectId?)` — list with summaries.
- `companion_create_conversation({title?, projectId?, kind?})` — open a new conv server-side.
- `companion_get_conversation(id, {includeMessages?, limit?})` — full conv + messages.
- `companion_set_conversation_memory(id, enabled)` — flip the memory toggle.
- `companion_delete_messages_from(id, messageId)` — truncate the conv from a point onwards.
- `companion_export_md(id)` — the conv as a single Markdown file.

### Inference (non-blocking)

- `companion_send_message({conversationId, content, model?, system?, …})` — queue an inference. Returns immediately with `{messageId, status: "queued"}`.
- `companion_get_inference_status(messageId)` — poll. Returns `{status: "queued"|"running"|"done"|"error", content?, usage?}`.
- `companion_list_models()` — the model catalog Companion sees (via its paired engine).

The non-blocking pattern is the key here. MCP clients have a default 45s timeout. Long reasoner runs (Hy3-preview, Cowork-style 120s reasoning) blow that. The send → poll → get pattern means the IDE doesn't sit on a blocked socket; it gets the messageId in <1s, polls every few seconds, retrieves the result when ready.

### Projects

- `companion_list_projects()` — catalog.
- `companion_get_project(id)` — full project (system prompt, memory toggles, conversations).

### Live tool catalog

The Settings page is the source of truth for the live catalogue (versions evolve). This guide tracks the shape — call `tools/list` on `/api/mcp` for the current spec.

## Minting a token

1. *Settings → Extensions → Agents tokens → New token*.
2. **Label** (free text — "Cline on MacBook", "Continue.dev on workstation", …).
3. **TTL** — 24h / 30d / 90d / no-expiry. Tip: short-TTL per-machine is safer than one long-TTL master token.
4. **Source** — `cowork` (default) or `hermes` (legacy alias, same behaviour).
5. Click **Mint**. The plain `hms_…` token is shown **once**. Copy it now — only the prefix is kept after this screen.

Stored hashed-at-rest (bcrypt). Companion can't show you the token again — you have to mint a new one if you lose it.

**Revoke** any time from the same page (per-row revoke button).

## Connecting an external client

The page ships ready-to-paste configs for the major clients.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Restart Claude Desktop. The tools appear under the 🔌 icon.

### Continue.dev

`~/.continue/config.yaml`:

```yaml
mcpServers:
  - name: companion
    url: https://dev.thecomp.ai/api/mcp
    requestOptions:
      headers:
        Authorization: Bearer hms_…
```

Restart VS Code. Tools land in Continue's tool picker.

### Cline (VS Code)

Cline → MCP Servers → Add → HTTP:

- URL : `https://dev.thecomp.ai/api/mcp`
- Header : `Authorization: Bearer hms_…`
- Transport : Streamable HTTP

### Claude Code (CLI)

```bash
claude mcp add companion https://dev.thecomp.ai/api/mcp \
  --header "Authorization: Bearer hms_…"
```

### Hermes Agent

Hermes is interesting because Companion already drives Hermes via the `/hermes` slash command (Companion → Hermes, see [Slash commands & agents](slash-commands)). Wiring Companion's MCP into Hermes closes the loop the other way (Hermes → Companion). Now Hermes can recall Sophie's memory, read past conversations, list saved skills, and send messages back into Companion from inside an agent turn.

Mint a token in **Settings → Agents tokens** (see [Minting a token](#minting-a-token)) — note the `hms_…` string, it's only shown once.

Then on the machine where Hermes runs (today: your workstation):

```bash
hermes mcp add companion \
  --url https://dev.thecomp.ai/api/mcp \
  --auth header
```

The CLI prompts for the header value. Paste `Authorization: Bearer hms_…` (the full header, name included). Hermes writes the entry to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  companion:
    url: https://dev.thecomp.ai/api/mcp
    auth: header
    headers:
      Authorization: Bearer hms_…
```

Verify the link:

```bash
hermes mcp test companion
```

Should print the 15 tools Companion exposes (`search_memory`, `remember`, `list_conversations`, `send_message`, `get_inference_status`, etc.). If you see "Unauthorized", regenerate the token in Settings — old ones can be revoked.

Once linked, the next `/hermes` you fire from Companion can call back. Example: `/hermes search my memory for what I decided about Hermes architecture last week, then summarize`. The agent runs `search_memory("Hermes architecture")` via MCP, gets the wiki articles, summarizes them in the agent box. The round-trip is invisible — same agent box, same SSE stream.

**Two-way wiring summary:**

| Direction | Mechanism | Where configured |
|---|---|---|
| Companion → Hermes (slash command sends a prompt) | Hermes Agent add-on + ACP bridge | Settings → Add-ons → Hermes Agent |
| Hermes → Companion (agent calls Companion's tools) | MCP server + `hms_…` token | `hermes mcp add` on the machine where Hermes runs |

Both can coexist. Both should be enabled if you want Hermes to act on your machine AND read/write your Companion memory in the same turn.

### curl smoke test

```bash
curl -s -X POST 'https://dev.thecomp.ai/api/mcp' \
  -H 'Authorization: Bearer hms_…' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You'll get a JSON-RPC response with the full tools array. If the response is HTML or an auth error, the token's wrong or the URL's not reachable.

## Patterns to copy

### Recall before answering

```
agent: I'm about to answer a question about X.
       Let me check what Sophie's already said about X.
       → companion_search_memory("X")
       → [reads top 3 chunks]
       → answers with context anchored in her past notes.
```

Wire this into your IDE agent's pre-turn hook so it happens automatically. Cuts hallucination dramatically on personal context.

### Persist a learning

After solving a sticky problem in the IDE:

```
agent: Done. This was a one-off — but Sophie should remember it.
       → companion_remember(projectId, "fix-xyz", "## TL;DR\n…")
```

Next session, the next agent finds it via `companion_search_memory`.

### Load a tuned skill

```
agent: This task is a code review.
       → companion_get_skill("code-review-strict")
       → [prepends body to system prompt for THIS task]
       → does the review with the loaded persona.
```

### Cross-session continuation

Start a chat on desktop. Continue on phone via Companion. Jump back into VS Code — the conversation is the source of truth, clients are lenses. Use `companion_get_conversation(id)` to pull state into your IDE agent, `companion_send_message` to continue.

## Security model

- **One user per token.** Every call runs as the token owner; no cross-tenant access.
- **Read-mostly write surface.** The global wiki is read-only over MCP by design. `companion_remember` writes only to project-scoped `agent-notes/`.
- **Inference is non-blocking.** Long reasoner runs (Cowork-style, ~120s) don't blow MCP's 45s client timeout because of the send → poll → get split.
- **Tokens are revocable.** Per-row revoke. Mint short-TTL tokens per machine; if a laptop disappears, revoke just that one.
- **Tokens are hashed at rest.** We can never show you the plain token again.
- **No PII in MCP error payloads.** Errors carry codes + sanitized messages.

## When NOT to use the brain

- **Editing files on your laptop** — the IDE wins there. Companion's `fs_*` tools are deliberately not exposed over MCP.
- **Running shell commands** — that's the IDE-side runtime (Cline's exec, Continue's tools, Aider's shell).
- **Writing to your global wiki** — too easy to pollute. Curate by hand or via Némo in chat.
- **Real-time collaboration** — Companion serves one user at a time per token. Not a multi-user broadcast.

## Token lifecycle

```
mint  →  Sophie copies hms_… once  →  IDE config gets it  →  IDE makes MCP calls
                                                                  ↓
                                                       Companion validates & runs as Sophie
                                                                  ↓
                                                         Sophie revokes → calls 401 immediately
```

The middleware that resolves `Bearer hms_…` to a userId is `middleware/hermes-token.ts` (name is historical — kept to avoid churning a stable internal API). It's used for `/api/mcp` AND for `/api/conversations`, `/api/projects`, `/api/files`, `/api/models`, `/api/inference` — so the same token lets an external agent make raw HTTP calls AND use the MCP surface.

## Related

- *MCP servers* (12) — the flip side
- *Skills* (11) — the surface the brain exposes for curation
- *Memory* (10) — the surface the brain exposes for recall
- *Privacy & data* (18) — token storage details
