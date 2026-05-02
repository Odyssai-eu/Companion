# TheCompAI Code Runner

Small local HTTP runner for coding sessions.

It runs on the machine that owns the repositories. TheCompAI/Hermes call it;
the runner reads local files, runs safe inspections, and later will perform
controlled write/test actions.

Current scope: **read-only**.

## Endpoints

- `GET /health`
- `POST /preflight`

All non-health requests require:

```text
Authorization: Bearer <CODE_RUNNER_TOKEN>
```

## Run

```bash
export CODE_RUNNER_TOKEN=...
export CODE_RUNNER_ALLOWED_ROOTS="$HOME/repos"
node server.mjs
```

