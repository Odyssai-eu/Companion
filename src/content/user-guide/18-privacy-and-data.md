# Privacy & data

What stays local, what travels, what's encrypted, what's deleted on delete.

## The short version

- **Local-first compute** when paired with Odysseus on your own LAN. No cloud touches your conversations.
- **Cloud-routed compute** when you pick a cloud model (Anthropic, OpenAI, OpenRouter). That conversation's content goes to that provider.
- **Tokens, API keys, MCP credentials** — encrypted at rest in your account's Postgres rows.
- **Memory wiki** — your account, your wiki, your sovereignty. Not training data.
- **Push-to-talk transcription** — 100% in the browser. No audio ever leaves.

## What lives where

| Data | Storage | Encryption | Notes |
|---|---|---|---|
| Conversations + messages | Postgres on rpi-dev | At rest (FDE on disk) | Per-user scoped via `user_id` FK |
| Memory wiki | Postgres on rpi-dev (`memory_articles` in `thecompai-memory` service) | At rest | Per-user; LLM-compiled from your conversations |
| Project memory | Postgres (`project_memory_files`) | At rest | Per-project scoped |
| Skills | Postgres (`agent_skills`) | At rest | Per-user, includes body + files |
| MCP server bearer tokens | Postgres, encrypted col | AES-256 at column level | Decrypted server-side at request time |
| Agents tokens (`hms_…`) | Postgres, **bcrypt-hashed** | Hashed (one-way) | Can't be retrieved; mint a new one if lost |
| Engine bearer token | Postgres, encrypted col | AES-256 at column level | |
| LiteLLM API key | Postgres, encrypted col | AES-256 at column level | |
| Inference presets | Postgres | At rest | Per-user |
| Session cookies | Browser local storage | Server-side signature | HTTPOnly, Secure, SameSite=Strict |

## What travels to the model

For every chat turn, the request body sent to the inference engine includes:

- The system prompt (composition: user override → project prompt → project memory → global memory snapshot).
- The conversation history (all prior messages).
- The user's new message (text + attachments).
- The model id.
- The sampling params (temp, max_tokens, …).
- `session_id` (the conversation UUID) — for KV-cache hints, doesn't carry semantic data.

**Nothing extra**. No telemetry beacons, no implicit user metadata, no tracking pixel.

## What the engine sees vs what cloud providers see

### Local engine (Odysseus on your LAN, gateway mode)

The request goes to your engine. Stays on your LAN. The model runs on your Mac Studios. Nothing touches the internet.

The engine's logs may capture the request body if `debug_verbose` is on. By default it's off. Logs cycle out via Docker log rotation.

### Cloud passthrough

When you pick a cloud alias (`or:claude-haiku`, `or:hy3-preview`, etc.) in gateway mode:

1. Companion sends to Odysseus.
2. Odysseus identifies the alias as cloud, forwards to OpenRouter / Anthropic / OpenAI.
3. The cloud provider sees: your prompt + history + attachments.
4. Their privacy policy applies. Companion doesn't add headers identifying you.

### LiteLLM (hybrid/legacy)

Same as cloud passthrough but via LiteLLM as intermediary. LiteLLM logs are on `m4pro-24:4000` — Sophie owns that box. If you don't trust the operator (it's Sophie, but conceptually): don't use hybrid/legacy with cloud aliases.

## What the memory compiler sees

The Karpathy compiler reads your conversations to update the wiki. Specifically:

- Loads up to 200 recent messages per compile (cap 4000 chars each).
- Sends the messages to Qwen3.6-35B on oMLX (your local cluster).
- Receives diffs → applies to `memory_articles`.

The compile runs on **your local oMLX node**. The conversation content does NOT go to a cloud provider for compile. Even when you chatted with `or:claude-haiku`, the compile of that conversation runs on Qwen3.6 locally.

Compile is gated:

- Skipped when `kind != 'chat'` (Talk convs don't compile yet).
- Skipped when `memoryEnabled = false` for the conversation.
- Skipped for guest sessions.
- Skipped for projects with `globalMemoryReadOnly = true`.
- Skipped for projects with `dedicatedMemoryEnabled = true` (those compile to project memory instead).

To exclude a conversation entirely: flip the chat header **Memory** toggle off before chatting. Cleanest pre-emptive control.

## What MCP servers see

When you wire an MCP server (Notion, Linear, …):

- The server sees the tool call arguments you (or the agent) invoke.
- It does NOT see your conversation history. Only the literal tool args.
- Its responses come back into the chat as tool-result blocks.

If you ask the agent "summarise my Notion page X", the request to Notion is `mcp_notion_fetch(id="X")` — the prompt context is internal to Companion.

## What external agents (via your Agents tokens) see

Agents with `hms_…` tokens can read everything in your account that the token's user has access to. Specifically via the MCP brain endpoint:

- All your conversations (`companion_list_conversations`, `companion_get_conversation`).
- All your skills.
- Your memory wiki (read-only via MCP).
- Your projects.
- Inference (send messages, list models).

**They CANNOT** access your auth credentials, your LiteLLM key, your engine token, or anyone else's data.

If you mint a token then lose the laptop you put it on: revoke it immediately. The revoke is instant.

## Push-to-talk transcription

The browser's Web Speech API runs entirely client-side (your machine). The audio doesn't leave your browser. The transcript appears in the input bar; you decide whether to send.

This is in contrast to many cloud-based dictation services that stream audio to a server. Web Speech is local.

TTS is different — see *Voice & talk* (08). Voxtral over LAN stays local; Gemini Live cloud doesn't.

## Encryption details

- **At rest**: the rpi-dev disk uses full-disk encryption (LUKS). All Postgres rows therefore inherit it.
- **Column-level**: MCP bearer tokens, engine token, LiteLLM key encrypted with a server-side master key. The master key is at deploy time, not in the DB.
- **Hashed** (one-way): account passwords (bcrypt), agents tokens (`hms_…` bcrypted).
- **In transit**: Companion is served over HTTPS via Cloudflare Tunnel (TLS 1.3). Internal LAN traffic to the engine is HTTP by default (no TLS termination on the Mac Studios) — acceptable because the LAN is sovereignty-bound.

## Deletion

When you **delete a conversation**: messages cascade-delete via FK. The conversation's memory snapshot is destroyed with the row.

When the admin **deletes your account**: cascade through:

- `users` row.
- `sessions`, `agent_tokens`, `inference_settings`, `inference_presets`, `mcp_servers`, `addons`, `agent_skills`.
- `conversations` → `messages`.
- `projects` → `project_memory_files`.
- `memory_articles` (the wiki).

What's NOT auto-deleted:

- LLM provider-side logs (Anthropic, OpenAI, OpenRouter, depending on their policies).
- Cluster logs if `debug_verbose` was on (cycle via Docker, not surgically purged).

For a clean GDPR-style deletion: admin deletes the account row, you remove the LLM provider relationship on your end (rotate API keys etc.).

## Audit & logs

Companion logs to `docker logs thecompai-app`. By default, logs are minimal (request lines, errors). No PII in normal request logs.

With `users.debug_verbose = true` (Settings → Inference → Debug verbose): the upstream request body gets logged before every `/v1/chat/completions` POST. Used for diagnosing tool calling shape issues. Generates a lot of stdout — only enable when debugging.

Auth events (sign-in, sign-out, password change) go through `auth-log` middleware → `auth_events` table. Visible to admins.

## Data subject rights

If you want a copy of all your data: ask the admin. They'll `pg_dump` your rows.

If you want hard deletion: ask the admin. They'll cascade-delete.

If you want to know what's stored: this page lists it all. The DB schema is in `app/server/db/schema.ts` for full detail.

## Related

- *Account & devices* (03) — sign in / sessions / cookies
- *Agents tokens* (13) — token security model
- *Memory* (10) — compile gating
- *Voice & talk* (08) — local vs cloud audio
