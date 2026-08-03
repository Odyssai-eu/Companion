# Add-ons

Add-ons are optional integrations that extend what Companion can do. Configure them in *Settings → Extensions → Add-ons*. Most are off by default.

## Overview

| Add-on | What it enables | Slash command |
|---|---|---|
| **LiteLLM** | Legacy inference rail (cloud routing) | — |
| **Auto Router** | Semantic routing — picks the right model per message | — |
| **Obsidian** | Vault sync for the memory wiki | — |
| **Web Search (Tavily)** | Live web search tool for the agent | — |
| **Voice Live** | Full-duplex voice via Gemini Live | — |
| **ComfyUI Imager** | Flux image generation | `/comfyui` |

---

## LiteLLM

The **legacy inference rail** — routes requests through a LiteLLM proxy when no engine is in gateway mode, or when you need cloud providers (Anthropic, OpenAI, OpenRouter) via an intermediary.

Fields: **LiteLLM URL** + **API key**.

In gateway mode with OdyssAI-X, you can disable LiteLLM entirely (*Settings → Inference → LiteLLM disabled*). All routing then goes through the engine directly.

See *Engine pairing* (16) for gateway vs hybrid vs legacy.

---

## Auto Router

When enabled, the **Auto Router** inspects each incoming message and picks the best model before forwarding. It's what powers the **Auto** inference mode, and it's also available as the `Auto` entry at the top of the picker in Expert mode.

Configure in the add-on panel:

- **Embedding service URL** — any OpenAI-compatible `/v1/embeddings` endpoint.
- **Model per bucket** — chat / deep / code.
- **Fallback model** — answers when routing itself can't run. Companion still shows you the routing error; the reply just comes from this model instead of failing. Leave it empty to keep the strict "error, no answer" behaviour.

See *Semantic routing* (065) for the full walkthrough.

---

## Obsidian

Syncs your Obsidian vault into the memory wiki. The add-on provides:

- A **vault ZIP export** (download, edit in Obsidian, re-import).
- A **bearer token** for the [Companion Obsidian plugin](https://github.com/thecompai/companion-obsidian-plugin), which pushes vault changes back automatically.

After sync, the wiki re-indexes. Your next "Remember now" picks up the new content.

See *Memory* (10) for how the wiki is structured.

---

## Web Search (Tavily)

Gives the agent a live web search tool (`web_search`). Requires a [Tavily API key](https://tavily.com).

Fields: **Tavily API key**.

Once enabled, the agent can call `web_search(query)` to retrieve real-time search results. The tool appears in the agent's tool catalog when agent mode is on.

---

## Voice Live

Full-duplex voice conversation via **Gemini Live**. Requires a Gemini API key.

When enabled, a **Voice** button in the chat header opens the Voice Live surface: you speak, the model speaks back, with low-latency bidirectional audio.

This is separate from push-to-talk (which is always available, browser-side, no key needed). See *Voice & talk* (08).

---

> The Hermes Agent and Pi add-ons were retired in v2.0 — delegation is
> native now (Némo's task tool + the Agents registry in Settings).

## ComfyUI Imager

Gives you the `/comfyui` slash command — Flux image generation via your own ComfyUI installation.

Fields:
- **Bridge URL** — `http://<your-comfyui-host>:<port>` (the Companion ComfyUI bridge, not ComfyUI directly).
- **Bridge token** — bearer token for the bridge API.

Generation runs on your hardware. The resulting images land directly in the conversation as image blocks. No images are sent to third-party services.

---

## Related

- *Slash commands* (066) — `/help`, `/comfyui` in detail
- *Engine pairing* (16) — LiteLLM vs gateway mode
- *Memory* (10) — Obsidian vault sync and the wiki
- *Voice & talk* (08) — push-to-talk vs Voice Live
