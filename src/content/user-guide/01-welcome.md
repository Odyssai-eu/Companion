# Welcome

Companion is a universal client for AI inference. You bring the engine — local cluster (Odysseus, Ollama, LM Studio, vLLM, MLX) or a cloud key (OpenRouter, Anthropic, OpenAI) — and Companion gives you a consistent client across desktop and mobile.

## What you can do here

- **Chat** with any model you have access to, with full conversation history, edit/regenerate, attachments, and voice.
- **Organise** chats into **Projects** that share a system prompt, memory, and (optionally) a project wiki.
- **Extend** the agent with **Skills** (agentskills.io packages), **MCP servers** (Notion, Linear, Tavily, …), and **Agents tokens** that turn Companion into an MCP brain for external coding agents.
- **Remember** with a per-user wiki (global Karpathy-style memory) and per-project memory you can curate by hand or let the agent append to.

## Two minds, one stack

- **Companion** — the client you're reading this in.
- **Odysseus** — Sophie's distributed MLX inference engine, OpenAI-compatible. Companion is happiest paired with it, but speaks plain OpenAI / Anthropic / OpenRouter just as well.

## How this guide is organised

Each topic on the left is a single markdown page in `src/content/user-guide/`. Edit a page and the next deploy ships the new copy — no DB, no build step beyond `./scripts/deploy-dev.sh`. The guide stays a living wiki rather than a fossil README.

Start with **Getting started** if this is your first session. Otherwise pick the topic that matches what you're stuck on — the topics are independent.
