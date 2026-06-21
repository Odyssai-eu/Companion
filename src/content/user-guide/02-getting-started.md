# Getting started

Five-minute onboarding from blank account to first chat. Skip steps you've already done.

## 1. Sign in

Companion is account-scoped. Your conversations, projects, skills, MCP servers, memory and presets all travel with the account — sign in on a phone or a second laptop and pick up where you left off.

If you don't have an account yet, ask the workspace admin to mint you one. Companion doesn't self-serve user creation — that's a deliberate trade-off for sovereignty over the user list.

## 2. Pair an inference engine

Open **Settings → Infrastructure → Engine**. You need at least one server reachable from Companion. Three shapes:

- **Local OdyssAI-X** (recommended) — open-source distributed MLX engine. Host + port + bearer token. Companion runs a discovery probe over LAN and a manual entry as fallback.
- **Other local engine** (Ollama, LM Studio, vLLM, MLX bare) — same shape, manual entry. As long as it speaks OpenAI / Anthropic, it pairs.
- **Cloud** (OpenRouter, Anthropic, OpenAI) — base URL + bearer key.

Hit **Test endpoint**. The handshake probes `/.well-known/inference-engine.json` (for OdyssAI-X-compatible engines) and `/v1/models`. The chip turns green when both succeed.

Three engine modes derived from the probe:

- **`gateway`** — engine reports `features.cloud-passthrough`. 100% via the engine, no LiteLLM at all.
- **`hybrid`** — engine doesn't pass through cloud. Caps come from engine, inference goes through LiteLLM (deployed alongside if you keep that rail).
- **`legacy`** — no engine paired. LiteLLM only.

See *Engine pairing* (16) for the deeper guide.

## 3. Pick a model

The model picker is the leftmost element in the chat top bar. Click to open a panel grouped by **Local** (your engine's catalog) and **Cloud** (cloud aliases). Capability chips next to each model:

- **👁** vision-capable (accepts `image_url` parts)
- **⚒** tools / function-calling (required for `skill_*`, MCP, `fs_*`, agent mode)
- **⚡** sub-second TTFT (probe targets, autocomplete models)

Three picker layouts depending on your *Inference mode* setting:

- **Easy** — no picker. OdyssAI-X auto-routes each request to the best model (via the Auto Router add-on), falling back to a model you set when the router isn't configured.
- **Advanced** — 4 named slots (conversation / analyse / engineer / expert). Pick a slot.
- **Expert** — full catalog with eye toggles for hide/show. Default for power users.

See *Model picker* (06) for the full breakdown.

## 4. Start chatting

- **Enter** sends, **Shift+Enter** newline, **Esc** stops a stream.
- **⌘K / Ctrl+K** focuses the conversation search.
- **⌘N / Ctrl+N** opens a fresh chat.

The left sidebar shows:

- **Chat** + **Project** buttons at top (new conversation / project grid).
- Recent conversations grouped by today / yesterday / older.
- **Talk** button at the very bottom — full-screen voice surface (coming, see *Voice & talk*, 08).

The chat header shows model picker, agent-mode toggle, memory toggle, voice icon, and a cogwheel for the per-conversation inference settings.

## 5. (Optional) Tour the extras

Once chat works, the rest is opt-in:

- **Settings → Extensions → Add-ons** — LiteLLM (legacy inference rail), Auto Router, Obsidian vault sync, Web Search (Tavily), Voice Live, **Hermes Agent** (`/hermes`), **Pi** (`/pi`), **ComfyUI Imager** (`/comfyui`). See *Add-ons* (13b) for the full guide.
- **Settings → Extensions → MCP servers** — Notion, GitHub, Tavily, Linear, Obsidian, Filesystem presets. Or roll your own URL.
- **Settings → Extensions → Skills** — agentskills.io packages the model can load on demand.
- **Settings → Extensions → Agents tokens** — `hms_…` tokens for external IDE agents to call back into Companion's memory + skills + conversations.

You don't need any of these to chat — they're the layers that turn the client into a brain.

## 6. Optional: hook your IDE into Companion's brain

If you code, the *Agents tokens* topic (13) walks through making Cline / Continue.dev / Claude Desktop call Companion as an MCP server for memory + skills + cross-session continuation. The IDE stays the IDE; Companion stays the brain.

## What's persisted, what's local

- **Persisted on the server** (across devices): conversations, projects, memory wiki, skills, MCP servers, agents tokens, inference settings, presets, hidden models.
- **Local to this browser**: nothing chat-critical. The session cookie lives in the browser; sign in from a new device and everything appears.

See *Privacy & data* (18) for the full breakdown.
