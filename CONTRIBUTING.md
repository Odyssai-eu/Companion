# Contributing to Companion

Thanks for considering a contribution. This document explains what we welcome, the conventions we follow, and the development setup.

## What we welcome

**Always**:
- Bug fixes with a clear reproduction
- New engine adapters (any OpenAI- or Anthropic-compatible host)
- New MCP server integrations (Settings → Extensions → MCP servers)
- New add-on plugins (router, agent bridges, tool surfaces)
- UI polish — accessibility, mobile, dark mode, micro-interactions
- Documentation improvements, especially the user guide and getting-started

**Discuss first** (open an issue before a PR):
- Schema migrations (anything in `drizzle/`)
- New routes or breaking changes to existing API
- New `npm` dependencies
- Anything that touches the memory compiler, the MCP server surface, or the agent-tokens system

## Development setup

Node 22+, npm 10+, Docker.

```bash
git clone https://github.com/Odyssai-eu/Companion.git
cd Companion

# Install
npm install

# Configure
cp .env.example .env
# edit .env — at minimum AUTH_JWT_SECRET (real secret, not the literal)

# Start Postgres only (we run the dev API natively)
docker compose up -d db

# Dev (Vite + API on 3000 via tsx watch). tsx does not auto-load .env,
# so export the variables in your shell first, or use a tool like
# `dotenv-cli` / `direnv`.
set -a; source .env; set +a
npm run dev
```

For the full Docker stack (production-like):

```bash
docker compose up --build
# App on http://localhost:3000
```

## Project layout

```
app/
├── server/              Hono backend
│   ├── routes/          One file per /api/* endpoint group
│   ├── lib/             Shared helpers (memory, prompt-builder, providers, …)
│   ├── middleware/      Auth, guest tokens
│   └── db/              Drizzle schema + seed
├── src/                 React frontend
│   ├── pages/           Top-level routes (chat, settings, projects, …)
│   ├── components/      Shared UI building blocks
│   ├── hooks/           useChat, useIsMobile, …
│   ├── lib/             API client, file helpers, model pricing
│   └── content/         Markdown content (user guide, …)
└── drizzle/             SQL migrations (numbered)
```

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org/) with these scopes:

| Type | When |
|---|---|
| `feat` | New user-facing capability |
| `fix` | Bug fix |
| `ux` | UI / interaction polish without functional change |
| `refactor` | Internal change, no behaviour delta |
| `docs` | Documentation only |
| `chore` | Tooling, deps, version bumps |

**Title** ≤ 70 chars, imperative. **Body** explains the *why* (1-3 sentences). Use a HEREDOC for multi-line:

```bash
git commit -m "$(cat <<'EOF'
feat(agents): /hermes slash command + inline agent box

Why this matters — the gap this fills, the trade-off behind the
chosen architecture.
EOF
)"
```

**Hard rules**:
- Never `--no-verify` (pre-commit hooks must pass)
- Never `--amend` after a failed pre-commit hook
- Never force-push to `main`
- Bump `package.json` version on user-facing changes (`patch` / `minor` / `major`)
- Stage specific files; never `git add -A` (avoids accidental `.env` / secrets)

The `./scripts/deploy-dev.sh` script enforces that all source changes are committed before deploy — it refuses to push if the working tree has uncommitted code outside `package.json`.

## Schema migrations

Add a new file in `drizzle/` with the next sequential number:

```
drizzle/
├── 0040_saved_prompts.sql      ← previous
└── 0041_agent_sessions.sql     ← yours
```

Idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER … ADD COLUMN IF NOT EXISTS`). The header comment explains *why* and what the schema choice protects against. Mirror the columns in `server/db/schema.ts` for the Drizzle types.

## Code style

- **TypeScript everywhere** — strict mode, no `any` unless commented
- **`tsc --noEmit`** must pass — run before committing
- **React** — functional components only, hooks for state, no class components
- **Tailwind** — semantic class composition, no `style={{}}` except for dynamic values

## Reporting bugs

Open an issue with:
- Companion version (footer of the app, or `curl /api/health`)
- Browser + OS
- Steps to reproduce
- What you expected vs what happened
- Browser console errors + network panel for the failing request
- For SSE / streaming issues, the `req_…` id from the response

## License

By contributing, you agree your contributions are licensed under the [Apache License 2.0](LICENSE).
