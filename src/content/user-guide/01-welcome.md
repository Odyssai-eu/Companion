# Welcome

Companion is a universal client for AI inference. You bring the engine — local cluster (Odysseus, Ollama, LM Studio, vLLM, MLX) or a cloud key (OpenRouter, Anthropic, OpenAI) — and Companion gives you a consistent client across desktop and mobile.

This guide is the canonical reference. Pick the topic that matches what you're trying to do; the topics are independent. Everything you read here is also valid for the public docs at [companion.odyssai.eu/docs](https://companion.odyssai.eu) — the source is the same Markdown.

## What Companion is, in one sentence

> A web client that pairs to an inference engine, keeps your chat history + memory + skills in a single account, and exposes both a chat UI and an MCP brain endpoint that external agents can call back into.

## What you can do here

- **Chat** with any model you have access to, with full conversation history, edit/regenerate, attachments, voice, code-block helpers, multi-model picker.
- **Organise** chats into **Projects** that share a system prompt, memory toggles, and (optionally) a project wiki.
- **Extend** the agent with **Skills** ([agentskills.io](https://agentskills.io)-spec packages), **MCP servers** (Notion, Linear, Tavily, GitHub, your own), and **Agents tokens** that turn Companion into an MCP brain for external coding agents (Cline, Continue.dev, Claude Desktop, Cowork).
- **Remember** with a per-user wiki (Karpathy-style memory, Némo) and per-project memory. Curate by hand or let the agent append via `companion_remember`.
- **Voice** in and out — push-to-talk on Space, full Talk mode for hands-free use.
- **Speak many engines** — gateway mode (Odysseus direct), hybrid (caps from engine, inference via LiteLLM), or legacy (LiteLLM only). One client, every backend.

## Two minds, one stack

- **Companion** — the client you're reading this in. React + Hono + Postgres. Lives on `dev.thecomp.ai` (dev) or your own deployment.
- **Odysseus** — Sophie's distributed MLX inference engine. OpenAI / Anthropic compatible. Companion is happiest paired with it, but speaks plain OpenAI / Anthropic / OpenRouter just as well via the legacy rail.

Companion does **not** ship its own model. It's a client. You decide what's behind the chat window.

## What's NOT in here

- How to build Odysseus, run a Mac Studio cluster, or deploy your own Companion. Those are in the developer docs.
- API reference for `companion_*` tools — see *Agents tokens* for the catalog; full schema is at `/api/mcp` via `tools/list`.
- Pricing / licensing — admin contacts you directly.

## How to navigate this guide

- **First time?** Read *Getting started* (02), then *Chat basics* (05). Skip the rest until you need it.
- **Pairing an engine?** *Engine pairing* (16).
- **Building a brain for your IDE?** *Agents tokens* (13).
- **Tuning a specific bug?** *Troubleshooting* (20).
- **Lost on a term?** *Glossary* (21).

## A note on the voice

The agent that lives in Companion calls itself **Némo**. It's not a single model — Némo is the orchestrator above whatever model you've routed to. The model is the substrate; Némo is the persona, the memory, and the relationship.

You'll see the name throughout this guide. If you renamed your assistant, the same patterns apply.
