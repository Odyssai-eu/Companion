# Slash commands

Type a slash command in the chat composer to go beyond plain LLM chat — search the guide, generate images, or hand control to an agent that acts on your machine.

## Quick reference

| Command | What it does | Requires |
|---|---|---|
| `/help <question>` | Search the user guide, get a synthesised answer | — |
| `/comfyui [prompt]` | Open the Flux image generator | ComfyUI Imager add-on |
| `/hermes [prompt]` | Enter Hermes mode — real shell + filesystem access | Hermes Agent add-on |
| `/pi` | Enter Pi TUI mode — reflective conversational agent | Pi add-on |
| `/exit` | Leave any active agent mode, return to LLM chat | — |

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

## /hermes — real-machine agent

```
/hermes refactor auth.ts to use JWT instead of sessions
/hermes   ← enters mode without sending anything yet
```

Enters **Hermes** mode. Hermes is a coding agent that runs on your workstation — it reads files, writes files, runs shell commands, browses — and streams its actions into an inline terminal panel below the messages.

Mode is **persistent**: every message you send routes to Hermes until you type `/exit`. The model picker is still there but Hermes brings its own brain.

**The agent panel shows:**

| Line style | Meaning |
|---|---|
| `$ <your prompt>` in cyan | What you sent |
| White text | Agent tokens, streamed |
| `⚒ tool · <action>` in amber | Every file/shell action — nothing is silent |
| `⟲ reset` button | Drops the ACP session, next `/hermes` starts clean |

The transcript is persisted. Reload the page, switch conversations and come back — the panel reappears with full history.

**Requires** *Settings → Add-ons → Hermes Agent* → bridge URL (+ optional token).  
**For Hermes → Companion memory**: mint an `hms_…` token in *Settings → Extensions → Agents tokens* and wire it to the bridge. See *Agents tokens* (13).

---

## /pi — conversational TUI agent

```
/pi
```

Enters **Pi** mode. Pi is a reflective, conversational agent that opens as a TUI embedded in an iframe below the messages. Unlike Hermes, Pi isn't a shell agent — it's designed for slow thinking, journaling, long-form planning.

Once in mode, type directly in the Pi terminal (not in the main composer). The composer doesn't route to Pi. Use `/exit` to return to normal LLM chat.

**Requires** *Settings → Add-ons → Pi* → bridge URL.

---

## /exit — leave agent mode

```
/exit
/hermes_off
/pi_off
```

Universal. Works for any active agent mode. The agent transcript stays visible — scroll back any time. The conversation returns to normal LLM chat.

---

## Rules that apply to all modes

- **One agent per conversation.** Can't have Hermes and Pi active in the same chat simultaneously.
- **Conversations are independent.** Mode is per-conversation, not global. A second tab has its own mode.
- **Memory still works.** The wiki snapshot is in the chat's system prompt — the agent sees what Némo knows.
- **Tools are always visible.** Every file write, shell command, and browse surfaces in the amber lines. No silent tool use.

---

## Related

- *Add-ons* (13b) — configure Hermes, Pi, and ComfyUI bridges
- *Agents tokens* (13) — wire Hermes back to Companion's memory via MCP
- *Chat basics* (05) — normal LLM chat, no slash
