# Companion

**The universal client for local AI inference.** Companion is a web app that pairs with any OpenAI- or Anthropic-compatible engine — local clusters, hosted proxies, cloud providers — and adds the things a serious assistant needs: persistent memory, named projects, an editable skills library, MCP server hosting, semantic routing, embedded agents.

Part of [**OdyssAI**](https://odyssai.eu) — the open-source local AI ecosystem. Companion is the **client** layer (this repo). Its sibling engine is [**Odysseus**](https://github.com/Odyssai-eu/Odysseus).

```
You ── chat ──┐
              ▼
        ┌──────────────┐  ←  memory wiki, projects, skills,
        │  Companion   │      saved prompts, semantic router,
        │   (this app) │      MCP server (in & out), agent bridge
        └──────┬───────┘
               │  OpenAI / Anthropic over HTTP
               ▼
   ┌─────────────────────────────┐
   │ Engine of your choice       │  ←  Odysseus, Ollama, vLLM,
   │ (local / cloud / hybrid)    │      OpenRouter, Anthropic
   └─────────────────────────────┘
```

## What's in the box

- **Chat + Talk** — multimodal chat (text, images, code) with streaming + cancellation, plus a voice mode via Gemini Live.
- **Memory wiki** — persistent, editable notes the assistant always sees. An LLM compiler reads conversations and emits diffs you can review.
- **Projects** — named workspaces. Per-project system prompt, memory, vault binding.
- **Skills** — `SKILL.md`-format library (agentskills.io spec) the model can list, load, create, edit through tool calls.
- **Saved prompts** — a separate library of named system prompts you load into a conversation per-turn.
- **Inference presets** — sampling-param bundles you can apply mid-conversation.
- **Semantic routing** — opt-in add-on: pick `Auto` once, the right model answers based on intent (chat / deep / code).
- **Slash commands** — `/hermes`, future `/pi`, `/openclaw`, … open an inline terminal-style agent box. The chat asks; the agent acts.
- **MCP server** — Companion exposes its memory + skills + conversations + inference over MCP so external agents (Cline, Continue, Claude Code, Claude Desktop) can call back into it.
- **MCP client** — Companion connects to external MCP servers (Notion, Linear, GitHub) and surfaces their tools in chat.
- **Agents tokens** — mint, revoke, scope per-machine `hms_…` bearers for external clients.

Full feature tour: [docs.odyssai.eu/docs/companion/](https://odyssai.eu/docs/companion/welcome/).

## Install

**Easiest path.** Open Claude Code, Codex, Cursor, or any other coding
agent in this folder and tell it: *"install Companion on this machine."*
The agent reads [`AGENTS.md`](AGENTS.md) — a step-by-step runbook with
prerequisites, install phases, engine pairing, optional add-ons (Hermes,
Auto Router, MCP servers), and recovery instructions — and walks the
install on your actual machine.

**Manual path** (Docker required, Node 22+ if you also want to dev):

```bash
git clone https://github.com/Odyssai-eu/Companion.git
cd companion

cp .env.example .env
# edit .env — replace AUTH_JWT_SECRET with a real secret

docker compose up -d

# Open the app
open http://localhost:3000

# First login: dev@example.local / dev  (change in Settings → Profile)
```

Then in **Settings → Infrastructure → Engine**, pair an engine — any
OpenAI- or Anthropic-compatible host. If you're running
[Odysseus](https://github.com/Odyssai-eu/Odysseus) on the same LAN,
**Discover** finds it automatically.

For pairing details, add-ons, and the full guide:
[`AGENTS.md`](AGENTS.md) or the [public user guide](https://odyssai.eu/docs/companion/getting-started/).

## Stack

- **Frontend** — React 19, Vite, TypeScript, Tailwind 4
- **Server** — Hono on Node 22, served from the same container
- **DB** — Postgres 17 (via docker-compose), Drizzle ORM
- **Memory service** — separate FastAPI service (`thecompai-memory`) that compiles conversations into the wiki
- **Dev** — `pnpm install && pnpm dev`

## Status

**Pre-release.** Used internally in production. The 0.x cycle stabilises the multi-user surface (token quotas, RBAC, multi-tenant deployment patterns) before a 1.0 cut.

Apache 2.0 licensed. See [LICENSE](LICENSE).

## Contributing

We welcome pull requests — UI polish, new add-ons, MCP server integrations, engine adapters, doc fixes. See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions, code style, and the dev loop.

## Acknowledgments

Pairs naturally with [Odysseus](https://github.com/Odyssai-eu/Odysseus) (this project's sibling engine) but works with any OpenAI- or Anthropic-compatible host. Memory architecture inspired by Andrej Karpathy's wiki-compile pattern. MCP server + client built on [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk).
