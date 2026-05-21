# Slash commands & agents

Slash commands turn the chat composer into a command palette. Type `/hermes` (or, later, `/pi`, `/openclaude`, etc.) and the next thing you send goes to an agent that can act on your machine — read files, write files, run shell — instead of going to the LLM. Type `/exit` and you're back to normal chat.

> You have an army on your OdyssAI.

## Why this is different from "agentic chat"

Normal chat = the assistant brain replies in text. Tools are pretend-tools at best: search-the-web, look-things-up. Nothing touches your filesystem.

Slash commands = a real agent on your hardware takes the keyboard for a turn. When the agent runs `write_file("./scratch/draft.md", "…")`, the file *actually appears* in your folder. When it runs `bash`, your shell *actually runs*.

The chat keeps its identity, its memory, its model. The agent is invited, not always-on. You decide when to ask the army to act.

## Entering an agent mode

Type `/hermes` in the composer:

- **`/hermes`** alone — enters Hermes mode without sending anything. Useful when you want to brief the agent before kicking it off.
- **`/hermes <prompt>`** — enters mode AND sends the prompt right away. The agent gets to work, results stream into the inline terminal panel below the messages.

Once in mode:

- A chip appears above the composer: `▶ hermes mode — every message routes to the agent · /exit`
- The placeholder switches to `Talk to hermes… (/exit to leave)`
- Every message you send (no `/` needed) goes to the agent until you exit
- The model picker is still there but the chat doesn't need a model — Hermes brings its own brain

## Exiting

Three equivalent ways:

- **`/exit`** — universal, works for any active agent mode
- **`/hermes_off`** (or `/<kind>_off` for other agents) — explicit
- Click the **`/exit`** chip button above the composer

The chat returns to normal LLM mode. The agent transcript stays visible in its terminal panel — scroll back through it any time. Open another conversation, your mode there is independent.

## The agent box

When an agent is in flight, an inline terminal-style panel renders below the message list:

- `$ <your prompt>` — what you typed, in cyan
- `<agent text>` — streamed token by token in white
- `⚒ tool · <action>` — every file write, file read, shell command surfaces here in amber, so you can see exactly what the agent is doing
- A status dot on the header: green pulse while thinking, gray when ready
- A `⟲ reset` button to drop the session and start fresh (the next `/hermes` opens a new ACP session on the bridge)

The transcript is persisted server-side. Reload the page, switch conversations and come back — the box reappears with full history.

## Configuring Hermes

The Hermes Agent add-on lives in **Settings → Add-ons → Hermes Agent**. Two fields:

- **Bridge URL** — where Companion sends agent commands. The bridge is a small service running on your machine that talks ACP to a local Hermes runtime. Default in this setup: `http://192.168.86.79:8003` for Sophie's workstation. For other users, point it at wherever you host the bridge.
- **Bridge token** (optional) — a static bearer. Add one when the bridge isn't on a trusted LAN.

Click **Test connection** to confirm the bridge answers `/health`. If it doesn't, the `/hermes` calls will return a clear 503 with a pointer back to this Settings page — Companion never silently falls back to "no agent".

## What Hermes can actually do

Out of the box, Hermes ships with its toolset (file read/write, shell, browse, etc.) operating on the machine where it runs. In the niveau-1 architecture (today), that's your workstation directly — the box and the bridge live on the same machine.

The niveau-2 architecture (coming) ships a small daemon you can install on any machine — Linux, Windows, macOS — that connects out to Companion. Then `/hermes` from any browser session lands on the daemon's machine, and the agent acts there. Each user runs their own daemon; each daemon has its own allowlist of paths and commands.

## Wiring Hermes the other way (Hermes → Companion)

The setup above is Companion → Hermes (you type `/hermes …` and Companion sends the prompt to the bridge). Hermes can also call **back into Companion** via MCP — useful when the agent needs to recall something from your memory, list your saved skills, or post a message into another conversation. That direction is covered in [Agents tokens](agents-tokens#hermes-agent): mint a `hms_…` token in Settings, then `hermes mcp add companion --url …`. Once both sides are wired, a single `/hermes` turn can read your memory, write a file, and post a follow-up — all without leaving the agent box.

## Adding more agents

The slash command pattern is generic. Future drops will add:

- **`/pi`** — Pi-AI, conversational and reflective
- **`/openclaude`** — Claude via a Pi-style local layer
- whatever else fits

Each agent registers as its own add-on with its own bridge URL. The `/exit` command works for all of them. You can have only one agent active per conversation at a time — but different conversations can sit in different modes simultaneously.

## Tips

- **`/hermes` is per-conversation**, not global. Each chat has its own mode flag (stored in the DB). Switching conversations doesn't drag the mode with you.
- **Memory still applies** when you ask the agent something. The agent doesn't read Companion's memory directly, but the chat asking it does — so the prompt you formulate has all the context Némo would have had.
- **Tools are visible**. Anything the agent does on disk or in the shell is surfaced in the amber `⚒ tool · …` lines. There is no silent tool use.
- **Reset when stuck**. If a session goes sideways (loop, weird state), click `⟲ reset` in the agent panel header. Next `/hermes` opens a fresh ACP session, clean slate.
