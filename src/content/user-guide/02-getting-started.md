# Getting started

## 1. Sign in

Companion is account-scoped. Your conversations, projects, skills, MCP servers, and memory all travel with the account — sign in on a phone or a second laptop and pick up where you left off.

## 2. Connect an inference engine

Open *Settings → Infrastructure → Inference*. You need at least one server reachable from Companion.

- **Local cluster** (Odysseus, Ollama, LM Studio, vLLM, MLX) — host + port + optional bearer token.
- **Cloud** (OpenRouter, Anthropic, OpenAI) — base URL + bearer.

Hit **Test endpoint**. The handshake probes `/v1/models` (or the equivalent) and the chip turns green when it succeeds. If it stays red, see *Troubleshooting*.

## 3. Pick a model

The model picker lives in the chat top bar. Two tabs:

- **Local** — what your servers expose.
- **Cloud** — OpenRouter / Anthropic / OpenAI.

Capability chips next to a model:

- **👁** vision-capable (accepts image inputs)
- **⚒** tools / function-calling (required for the agent skill_*, MCP, and workspace tools)

## 4. Start chatting

- **Enter** sends, **Shift+Enter** is a newline.
- **Esc** stops a streaming reply.
- **Cmd/Ctrl+K** focuses the conversation search.

The left sidebar shows your recent conversations on top, with **Chat** / **Project** buttons at the head and the **Talk** button pinned to the bottom for voice mode.

## 5. (Optional) Wire up the extras

Once chat works, the rest is opt-in:

- *Settings → Extensions → Add-ons* — Tavily web search, Obsidian vault export, RAG.
- *Settings → Extensions → MCP servers* — Notion, Linear, GitHub, …
- *Settings → Extensions → Skills* — agentskills.io packages the model can load.
- *Settings → Extensions → Agents tokens* — lets external coding agents call **back into** Companion for memory + skills.

You don't need any of these to chat — they're the layers that turn the client into a brain.
