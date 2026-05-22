# AGENTS.md — Companion

> This file is a runbook for AI coding agents (Claude Code, Codex, Cursor,
> Aider, …) installing Companion on the user's machine. It is meant to be
> executed top-to-bottom. The user has already cloned this repo and
> pointed their agent at it.
>
> If you are a human, you can read it too — it just won't apologize for
> being literal.

## 0. What you are about to install

**Companion** is the chat client + brain layer for the OdyssAI ecosystem.
It's a single Docker service (React frontend + Hono server on Node 22) +
a Postgres 17 database, both started by one `docker compose up -d`.

After a successful install you have:

- a chat UI at `http://<host>:3000/`
- a user account (you create it on first login)
- pairing with one or more inference engines (local: Odysseus, Ollama,
  LM Studio, vLLM, MLX bare; cloud: OpenRouter, Anthropic, OpenAI)
- persistent **memory wiki** (Karpathy-style, LLM-compiled, editable)
- **projects**, **skills**, **saved prompts**, **inference presets**
- an **MCP server endpoint** at `/api/mcp` so external IDE agents (Cline,
  Continue, Claude Code, Claude Desktop, Cowork) can use Companion as
  their long-term memory + skills library
- slash commands (`/hermes`, future `/pi`, `/openclaw`, …) that open an
  inline terminal-style agent box

What makes it different from a generic chat UI:

| | Generic chat UI (OpenWebUI, LibreChat, …) | Companion |
|---|---|---|
| Engines | one at a time, manually configured | pair multiple, switch per-conversation |
| Memory | none, or transcript scrolling | LLM-compiled wiki with diffs you can review + lock |
| Projects | folders | named workspaces with system prompt + memory + vault binding |
| Skills | none | `SKILL.md` library (agentskills.io spec) loadable on demand |
| Saved prompts | none | named system prompts you load into a chat per-turn |
| External agents | none | MCP server endpoint — external IDE agents call back into your memory + skills |
| Routing | none | optional semantic routing add-on: `Auto` picks chat/deep/code model per-message |
| Agent integration | shell tools, maybe | first-class `/hermes` slash command with bridge |
| Multi-tenancy | minimal | account-scoped everywhere (conversations, memory, tokens) |

Companion does **not** ship its own inference. You bring the engine.

## 1. Decide which install path applies

Ask the user before installing:

| Path | When |
|---|---|
| **A — Companion + Odysseus together** (recommended) | The user wants a full local AI stack. Install Odysseus first (engine), then Companion (client). Strongest defaults; engine discovery works automatically. |
| **B — Companion against an existing engine** | The user already runs Ollama / LM Studio / vLLM / some OpenAI-compatible endpoint somewhere. Companion pairs over HTTP. |
| **C — Companion against a cloud key only** | No local inference. The user only wants Companion's UX over OpenRouter / Anthropic / OpenAI. Cheapest install, no LAN required. |

If the user picks **A**, install Odysseus first (see
https://github.com/Odyssai-eu/Odysseus / `AGENTS.md` there), come back here,
then in step 5 discovery wires the two together.

## 2. Prerequisites — check before installing

```bash
# Docker (Desktop on macOS, daemon on Linux)
docker version >/dev/null 2>&1 || echo "ERROR: Docker not installed or not running."

# Free TCP port for the app (default 3000)
lsof -iTCP -sTCP:LISTEN -P -n | awk '$9 ~ /:3000$/{print "WARNING: :3000 already used by", $1, $2}'

# Free TCP port for Postgres (default 5432, only if the user wants to
# expose it on the host — by default compose keeps it internal)
# No action needed if the user hasn't asked for host-exposed DB.

# Free disk for Postgres data (~1 GB to start)
df -h /
```

For path **A** also confirm Odysseus is reachable (after installing it):

```bash
curl -sf http://<docker-host>:8000/health | jq .status
# → "ok"
```

For path **B**, the user gives you the engine's URL + bearer (if any).
Test it:

```bash
curl -sf -H "Authorization: Bearer <token>" "<engine-base>/v1/models" | jq '.data | length'
# Expect a positive integer.
```

For path **C**, the user gives you a cloud API key (OpenRouter is the
broadest catalogue). Don't burn it on a check — Companion will validate
on pairing.

If any check fails, stop and tell the user — don't `brew install`
anything without asking.

## 3. Configure the environment

```bash
cp .env.example .env
```

`.env.example` ships with sensible defaults; review these before `docker compose up`:

| Variable | Default | Set to |
|---|---|---|
| `PORT` | `3000` | Different port if `:3000` is already taken on the host |
| `DATABASE_URL` | `postgres://companion:companion@localhost:5432/companion` | Leave alone unless you already run Postgres elsewhere — docker-compose serves Postgres on `db:5432`, which the in-container default resolves correctly |
| `AUTH_JWT_SECRET` | `replace-me-with-a-real-secret-before-deploy` | **Replace** with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"` before exposing Companion beyond localhost |
| `ALLOW_SIGNUP` | `0` (closed) | `1` only if you want self-serve sign-up. Default closed: operator adds accounts manually |
| `ODYSSAI_SCAN_SUBNETS` | `192.168.1.0/24` | Your LAN CIDR if you want engine auto-discovery (`Discover` in Settings). Common: `192.168.1.0/24`, `192.168.0.0/24`, `10.0.0.0/24` |
| `MEMORY_SERVICE_URL` | unset | Optional — URL of the Karpathy memory compiler service (separate repo). Leave unset to skip; Companion runs fine without |

Edit `.env` accordingly. **Do not** check it into git — `.env` is
already in `.gitignore`.

## 4. Start the app

```bash
docker compose up -d

# Wait for the app (max 30 s)
for i in {1..30}; do
  curl -sf http://localhost:${PORT:-3000}/api/health && break || sleep 1
done
```

Expected response from `/api/health`:

```json
{"status":"ok","version":"…","engines":0}
```

`engines: 0` is normal at this point — you haven't paired any yet.

Open `http://localhost:${PORT:-3000}/` in the user's browser. The first
load shows the login screen.

**First-boot account:** the seed creates one operator account on an
empty DB and logs the credentials to stdout — read them with:

```bash
docker logs companion-app | grep "seeded first-boot account"
# → admin@example.local / change-me-now
```

Tell the user to log in with that and **change the password
immediately** in Settings → Profile.

To add more accounts later: either set `ALLOW_SIGNUP=1` and use
self-serve, or insert them directly via `psql` against the `companion`
database with a bcrypt-hashed password.

## 5. Pair an inference engine

The user logs in, then opens **Settings → Infrastructure → Engine**.

**Path A (Odysseus on the same LAN):**

Click **Discover**. Companion scans the configured `ODYSSAI_SCAN_SUBNETS`
for engines publishing `/.well-known/inference-engine.json` with
`vendor === "odyssai.eu"`. The Odysseus engine appears in the list —
click it, click **Pair**. The handshake is automatic; pairing returns a
crew token Companion stores under your account.

(Odysseus's pairing gate must be open. Open it from the Odysseus
dashboard → **Settings → Crew → Open gate** — 5-minute window. See
Odysseus's `AGENTS.md` step 5.)

**Path B (existing engine, manual entry):**

Click **Add engine → Manual**. Enter:

- **URL** — e.g. `http://localhost:11434` (Ollama), `http://localhost:1234`
  (LM Studio), `http://your-server:8000` (Odysseus already paired
  elsewhere), or a hosted proxy.
- **Bearer token** — if the engine requires one.

Click **Test endpoint**. Companion probes `/.well-known/inference-engine.json`
(Odysseus-style) and `/v1/models`. Green chip = paired.

**Path C (cloud key only):**

Same dialog. URL: `https://openrouter.ai` (or `https://api.anthropic.com`,
`https://api.openai.com`). Bearer: the cloud key. Test endpoint, save.

Three engine modes are derived from the probe:

- **gateway** — engine reports cloud-passthrough capability. 100% via the
  engine. Default for Odysseus.
- **hybrid** — caps from engine, inference via LiteLLM. Transitional.
- **legacy** — no engine paired; LiteLLM only (rare).

Open a new chat. The model picker fills with the engine's catalogue.
Send a message — you get a streaming reply.

If yes: **the client is installed and paired**.

## 6. Add Hermes (slash command `/hermes`)

Optional. Enables `/hermes <prompt>` in chat, which opens an inline
terminal-style agent that reads / writes files / runs shell on the
machine where Hermes is installed.

Three pieces:

### 6a. Install Hermes itself

The Hermes runtime is a standalone CLI. Install it on the workstation
where you want the agent to act (usually the user's laptop).

Repo: https://github.com/hermes-agent (or whichever fork the user
prefers — Companion just needs an ACP-speaking endpoint).

```bash
# Example install — adapt to the user's package manager / preferences
pipx install hermes-agent     # or: uv tool install …
# Verify
hermes --version
```

### 6b. Start the ACP bridge

Companion talks **ACP over HTTP** to a bridge running next to Hermes.
The bridge is a small Python service that forwards JSON-RPC ACP traffic
to the Hermes CLI.

```bash
# Spec: any process that listens on :8003 and speaks /health + ACP.
# A reference bridge ships in the Hermes repo:
hermes acp-bridge --port 8003
# Verify
curl -sf http://localhost:8003/health
```

### 6c. Wire it in Companion

**Settings → Add-ons → Hermes Agent**:

- **Bridge URL** — `http://<workstation-host>:8003` (LAN reachable from
  the Companion container — use `host.docker.internal` if the bridge
  runs on the Docker host).
- **Bridge token** (optional) — only if you bound an auth header to the
  bridge.

Click **Test connection** — `/health` must answer 200.

### 6d. (Optional) Hermes calls back into Companion via MCP

For the agent to be able to read Companion's memory / skills / past
conversations during a turn:

1. **Settings → Extensions → Agents tokens → New token**. Pick a TTL,
   click Mint. Copy the `hms_…` string (shown once).
2. On the Hermes machine:

```bash
hermes mcp add companion \
  --url https://<companion-host>/api/mcp \
  --auth header
# When prompted: Authorization: Bearer hms_…
```

Now `/hermes search my memory for X` works — Hermes calls
`companion_search_memory` over MCP, gets the wiki articles, summarises.

## 7. Add Auto Router (semantic routing)

Optional. Adds a `Auto` entry at the top of the model picker. Every
message embeds → cosine → picks chat / deep / code → dispatches to the
right model.

Requires an **OpenAI-compatible embeddings endpoint**. Two paths:

- **Odysseus-hosted** — if Odysseus is paired, load a small embedding
  model on it (e.g. `mlx-community/Qwen3-Embedding-0.6B-mxfp8`). The
  `/v1/embeddings` endpoint is built in.
- **Self-hosted elsewhere** — any embedding service that takes
  `{"input": ["…"]}` and returns `{"data": [{"embedding": [floats]}]}`.

Configure in **Settings → Add-ons → Auto Router**:

- **Embedding service URL** — e.g. `http://<engine>:8000/v1`
- **Models per bucket** — pick one model id (already paired with
  Companion) for `chat` / `deep` / `code`.
- Click **Save + Build anchors**. The first save embeds the ~30 anchor
  sentences once and stores centroids under your account.

Verify in the same panel — there's a **Quick test** box. Type a sentence,
click Test, see which bucket wins.

## 8. Add MCP servers (optional)

Companion can also be an MCP **client** — connect to Notion, Linear,
GitHub, Tavily, your own MCP server.

**Settings → Extensions → MCP servers → Add**:

- **URL** — the server's MCP endpoint
- **Auth** — none / bearer / OAuth (Companion handles the OAuth dance for
  Notion + Linear out of the box)

After adding, the agent can list / call the tools that server exposes.
Visible in chat when Agent mode is on (chat header toggle).

## 9. Smoke-test the install

Run these as a final pass:

```bash
# 9a. App is up
curl -sf http://localhost:${PORT:-3000}/api/health | jq

# 9b. The DB seeded
docker exec companion-db psql -U companion -d companion \
  -c "SELECT count(*) FROM users;"
# → should be >= 1 (the dev account)

# 9c. An engine is paired
# Log in via the UI, open Settings → Inference → Engine. Status chip
# should be green. The model picker in a new chat must have at least
# one entry.

# 9d. End-to-end chat
# Open a new chat in the UI, send "Say hello in one short sentence."
# Expect a streaming reply within a few seconds.
```

If 9a–9d all pass: **Companion is installed**.

## 10. Common failure modes

**`docker compose up` exits immediately**
→ `docker logs companion-app` to see the boot error. Most common: DB
unreachable (the `db` service hasn't passed healthcheck yet — wait
30 s and retry) or invalid `DATABASE_URL`.

**App starts, login screen never appears**
→ Stale frontend bundle. Hard-refresh the browser (`Cmd+Shift+R`).
If that doesn't help, `docker compose restart app`.

**"Test endpoint" green but model picker stays empty**
→ The engine answered `/v1/models` with `data: []`. Either no models
loaded (Odysseus before its first `load`, Ollama with no pulled model,
LM Studio with no server-mode model) or the engine returned a
non-OpenAI shape. Load a model on the engine side.

**`/hermes` opens the agent box but tool calls fail**
→ The bridge URL Companion has is wrong, or the bridge doesn't have ACP
running. Re-test in **Settings → Add-ons → Hermes Agent → Test
connection**. The bridge `/health` must answer 200 from inside the
Companion container.

**Auto Router returns 503 "embedding service unreachable"**
→ The embedding URL Companion has is wrong, or the embedding service
isn't running. Verify with `curl <url>/embeddings` from the Companion
host (or `docker exec companion-app curl <url>/embeddings` if URL is
LAN-internal).

**Memory compile never runs**
→ The memory service is optional and runs separately
(`companion-memory` repo). If it's not installed,
`MEMORY_SERVICE_URL` points at nothing and the compiler is silently
disabled. Chat still works; the memory wiki just won't auto-update.
Install the memory service if the user wants that.

**`AUTH_JWT_SECRET` warning at boot**
→ You left the default literal in `.env`. Replace with a real secret
before deploying anywhere reachable beyond `localhost`.

**Lost the dev account password**
→ Reset directly in Postgres:

```bash
docker exec -it companion-db psql -U companion -d companion
# In psql: UPDATE users SET password_hash = '<new-bcrypt-hash>' WHERE email = 'admin@example.local';
```

Generate a bcrypt hash with `node -e "console.log(require('bcryptjs').hashSync('NEW_PASSWORD', 12))"`.

## 11. Where to learn more

- **README.md** — short pitch + 1-page quick-start (overlaps with this
  doc; this is the deeper one).
- **CONTRIBUTING.md** — code style, commit conventions, dev loop.
- **docs/** — internal architecture notes (in-repo).
- **https://odyssai.eu/docs/companion/** — the public user guide.
  Comprehensive; sync'd from `src/content/user-guide/*.md`.
- **Odysseus** — the engine. Clone https://github.com/Odyssai-eu/Odysseus
  and run its `AGENTS.md`.
- **In-app `/help`** — once Companion is running, type `/help <question>`
  in any chat for a BM25 search over the user guide.

## 12. What you should NOT do

- **Do not change `AUTH_JWT_SECRET` after users sign up** — it invalidates
  every existing session. Pick the secret once at install time.
- **Do not commit `.env`.** It's in `.gitignore` for a reason.
- **Do not edit files under `src/content/user-guide/`** — they're the
  user guide source, also shipped to the public docs site at build time.
  Touching them rewrites public docs you may not have intended.
- **Do not seed the Postgres directly to create users.** Either set
  `ALLOW_SIGNUP=1` and use the sign-up flow, or insert via
  `bcrypt`-hashed `password_hash` (see step 7 of "Common failure
  modes" below) — the hashing convention matters.
- **Do not assume the user has the memory service running.** It's a
  separate repo (`companion-memory`). Companion runs fine without it —
  the memory wiki just stays manually-edited.
- **Do not install Hermes / Auto Router / MCP servers if the user didn't
  ask.** They're each opt-in add-ons.

## 13. Tell the user when you're done

When step 9d returns a streaming reply, tell the user in this shape:

> Companion is installed and running.
>
> - URL: http://localhost:<port>/
> - Login: admin@example.local / change-me-now (change the password in Settings → Profile)
> - Engine paired: `<engine-name>` (`<gateway|hybrid|legacy>` mode)
> - Model loaded: `<model-id>` (try sending it a message)
>
> Optional add-ons you can install next:
> - **Hermes Agent** (`/hermes` slash command) — see step 6 in `AGENTS.md`.
> - **Auto Router** (intent-based routing) — see step 7.
> - **MCP servers** (Notion / Linear / GitHub / …) — see step 8.

That's the end of the install.
