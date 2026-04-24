# Thecomp.ai — App

The universal client for local AI inference. Self-host Docker, connect any HTTP engine.

## Stack

- React 19 + Vite + TypeScript + Tailwind 4
- Hono on Node 22
- Postgres 17 (via docker-compose)

## Dev

```bash
pnpm install
pnpm dev
```

Web on `http://localhost:5173`, API on `http://localhost:3001` (proxied from the Vite dev server).

## Self-host (production)

```bash
docker compose up -d
```

App on `http://localhost:3000`.

## Project layout

```
src/       React client
server/    Hono API
```
