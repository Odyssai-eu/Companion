# Slash commands

Type a slash command in the chat composer to go beyond plain LLM chat — search the guide or generate images.

> The `/hermes` and `/pi` bridge modes were retired in v2.0. Delegation is
> native now: Némo calls specialized subagents (explore, writer, ops) via
> the task tool, and the work shows up as live task cards in the thread.
> See *Agents* in Settings.

## Quick reference

| Command | What it does | Requires |
|---|---|---|
| `/help <question>` | Search the user guide, get a synthesised answer | — |
| `/comfyui [prompt]` | Open the Flux image generator | ComfyUI Imager add-on |
| `/exit` | Clear a legacy agent-mode flag on an old conversation | — |

---

## /help — search the guide

```
/help how do I configure semantic routing?
/help comfyui setup
```

BM25 search over all user-guide articles, LLM-synthesised answer streamed into the chat. Sources appear as blue chips below the reply — each chip names the article it came from.

`/help` alone (no question) shows a hint and the full docs URL.

---

## /comfyui — Flux image generation

```
/comfyui a misty forest at dawn, wide shot
```

Opens the **ComfyUI Imager** modal. Configure:

- **Prompt** — seeds from whatever you typed after `/comfyui`
- **Negative prompt**
- **Template** — workflow presets
- **Size / Steps / CFG / Seed / Batch**

The resulting images are pushed directly into the conversation as image blocks. Generation runs on your ComfyUI bridge — nothing leaves the LAN if your bridge is local.

**Requires** *Settings → Add-ons → ComfyUI Imager* → bridge URL + token.

---

## Delegation (no slash needed)

Ask Némo naturally — "cherche dans ma mémoire ce qu'on a décidé sur X",
"écris-moi un rapport complet sur Y dans le workspace". When the request
matches a subagent's specialty, Némo delegates via the task tool and the
thread shows a live card: agent name, current action, tool calls. Click
the card to open the **Trace** — the full sub-conversation, every step.

Requirements: a tool-capable model (⚒ chip) and the conversation's
agent-mode toggle on.

---

## Related

- *Agents* (Settings → Extensions → Agents) — the subagent roster
- *API access* (13) — wire external IDE agents to Companion's memory via MCP
- *Chat basics* (05) — normal LLM chat, no slash
