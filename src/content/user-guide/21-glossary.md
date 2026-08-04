# Glossary

Terms used in Companion and the surrounding stack, with cross-references.

## A

**Agent mode** — Per-conversation toggle (chat header) that injects the full agentic toolset into the model's context. Default off. See *Inference settings* (14).

**API access** — `hms_…` bearer tokens that external coding agents (Cline, Continue.dev, Claude Desktop, Cowork) use to call Companion's MCP brain endpoint. See *API access* (13).

**Auto mode** — Inference mode where the chat shows no model selector and **CoeOS** (the router engine) picks a model per message. Replaced the retired *Easy* and *Advanced* modes in migration `0058`. See *Model picker* (06).

**CoeOS** — The router engine that powers Auto mode: routes each message to a benchmark-proven model per skill (chat / deep / code). Also selectable as `Auto` in the Expert-mode picker. Replaced the embeddings-based *Auto Router* add-on (removed v2.1). Fallback on outage: the Default model (*Settings → Inference*).

**Alias** — A short name for a model published by the engine (e.g. `<your-cluster-name>`, `or:claude-haiku`). Resolved to a concrete model path at engine side.

**`agentskills.io`** — Open specification for SKILL.md packages. Companion follows it. See *Skills* (11).

## B

**Bge-m3** — Embedding model (1024-dim) commonly used by Qdrant for the RAG / wiki search.

**bcrypt** — Password / token hashing used for account passwords and `hms_…` agents tokens.

## C

**Cached tokens** — Tokens that were reused from the engine's KV prefix cache instead of re-prefilled. Visible in the stats row as `Cached: N tok (X%)`.

**Capability contract** — `/.well-known/inference-engine.json` + `x_odyssai` per-model block published by Odyssai-compatible engines. Companion uses it to render the model picker chips. See *Engine pairing* (16).

**Chat kind** — Type of conversation: `chat` (default), `talk` (Voice Live), or legacy `hermes` (retired, normalised to chat on read).

**Cloud passthrough** — Engine feature that lets the engine route to cloud providers (OpenRouter, Anthropic, OpenAI) under unified aliases. Drives gateway mode.

**Companion** — The web client. React + Hono + Postgres, packaged as a single Docker image.

**ComfyUI Imager** — Add-on that enables the `/comfyui` slash command. Connects to a Companion ComfyUI bridge (your own ComfyUI install) for Flux image generation. See *Add-ons* (13b).

**Compile (memory)** — Process by which the Karpathy compiler reads recent conversations and emits diffs to the wiki. Triggered by inactivity (10 min) or cron slots (06:00 / 12:30 / 19:00, server time). See *Memory* (10).

**Cowork** — External coding agent that hits Companion as an MCP brain.

## D

**Debug verbose** — Per-user toggle (Settings → Inference) that logs upstream request bodies to docker logs. Off by default.

**Default model** — `users.default_model`. Used when a conversation is created without explicit model.

**Discovery probe** — mDNS-based engine discovery on the LAN at pair time. See *Engine pairing* (16).

**Dynamic Client Registration (DCR)** — Part of OAuth 2.1 spec. Companion uses it to register itself transparently with OAuth providers (Notion, Linear). You don't see it.

## E

**Engine** — The inference server Companion routes through. Can be OdyssAI-X, Ollama, LM Studio, vLLM, MLX bare, or cloud-only (no engine paired = legacy mode).

**Engine mode** — One of `gateway` / `hybrid` / `legacy`. Auto-derived at pair time. See *Engine pairing* (16).

**Easy / Advanced mode** — Retired inference layouts (migration `0058`). Both were replaced by **Auto**; existing accounts were migrated automatically. See *Model picker* (06).

## F

**Fallback model** — The **Default model** (*Settings → Inference*) doubles as the fallback: in Auto mode, when CoeOS or a target model is down, the turn is answered by this model instead of failing. Prefer a stable local model or a reliable fast cloud provider.

**Fenced code block** — Markdown code block delimited by triple-backticks. Companion adds Copy / Save / Save all (.zip) helpers under each one. See *Exports & imports* (17).

## G

**Gateway mode** — Engine mode where 100% of `/v1/chat/completions` goes to the engine. No LiteLLM. See *Engine pairing* (16).

**Global wiki** — Per-user memory wiki, LLM-compiled. Aka Némo's memory. See *Memory* (10).

**Guest token** — `g_…` URL-shareable token that grants scoped (often read-only) access to a conversation or project. Admin-mintable today.

## H

**Hermes Agent** — Retired (v2.0). Was the bridge-era workstation coding agent behind `/hermes`; replaced by the native agent runtime (task tool + Agents registry).

**Hybrid mode** — Engine mode where caps come from the engine, inference goes through LiteLLM. Transitional. See *Engine pairing* (16).

**hms_** — Prefix for agents tokens. Historical (Hermes naming). Kept for stable internal API. See *API access* (13).

## I

**Inference mode** — `auto` or `expert` (`users.inference_mode`). Auto = no picker, CoeOS chooses per message. Expert = full catalog picker. See *Model picker* (06).

**Inference preset** — Saved bundle of sampling params. Per-user. See *Inference settings* (14).

## J

**JACCL** — RDMA backend used by OdyssAI-X for inter-node MLX tensor exchange over TB5. Known queue-pair degradation bug after multiple sessions; reboot resolves.

## K

**Karpathy wiki** — The global per-user memory wiki pattern (named for the precedent set by [karpathy.bearblog.dev](https://karpathy.bearblog.dev)). Implemented as LLM-compiled diffs into Postgres. See *Memory* (10).

**KV cache** — Key-Value cache from transformer attention layers. Reused across turns when prefix matches. Driven by `session_id` in OdyssAI-X.

**`kind`** — Conversation type column. `chat` / `talk` / (legacy) `hermes`.

## L

**Legacy mode** — Engine mode with no engine paired, LiteLLM only. See *Engine pairing* (16).

**LiteLLM** — Generic LLM proxy. Sometimes deployed alongside OdyssAI-X as a fallback rail for clients that haven't migrated to gateway mode. See *Engine pairing* (16).

## M

**Markdown rendering** — Used for assistant replies and user guide content. Code blocks rendered with helper row.

**MCP** — Model Context Protocol. JSON-RPC standard for tools + resources + prompts.

**MCP server** — A remote MCP endpoint Companion connects to as a client. See *MCP servers* (12).

**MCP brain** — The flip side: Companion as a server, external agents as clients. See *API access* (13).

**Memory snapshot** — Frozen wiki state per conversation. Refreshable via "Remember now". See *Memory* (10).

**MoE** — Mixture-of-Experts model. E.g. Qwen3-Coder-Next-MLX-9bit, Hy3-preview-MLX-9bit.

## N

**Named models** — `users.named_models`. The 4 slots of the retired Advanced mode. Dead since migration `0058`; the column survives only so the migration stays reversible.

**Némo** — A name some users give their assistant persona. The principle: the assistant isn't a single model, it's an orchestrator above all models, defined by memory + relationship. See `profile/assistant-name.md` in the wiki for how to set your own.

## O

**OAuth 2.1 + PKCE** — Auth flow used by Notion / Linear / GitHub MCP integrations.

**Odyssai** — Brand umbrella for the open-source ecosystem: OdyssAI-X (engine) + Companion (client).

**OdyssAI-X** — Open-source distributed MLX inference engine. OpenAI / Anthropic compatible. The default engine target for Companion.

**OpenRouter** — Cloud LLM aggregator. Aliased as `or:*` in the picker.

## P

**Pi** — Retired (v2.0). Was the bridge-era reflective TUI agent behind `/pi`.

**Prefix cache** — Same as KV prefix cache. OdyssAI-X reuses it across turns of the same conversation via `session_id`.

**Probe** — Sub-second autocomplete model (Qwen2.5-Coder-1.5B). Aliased as `probe`. Used for cheap pings.

**Project** — Logical group of conversations sharing system prompt + memory toggles. See *Projects* (09).

**Project wiki** — Per-project memory corpus in `project_memory_files`. Independent of global wiki.

**Push-to-talk** — Hold Space to dictate. Browser-side Web Speech API. See *Voice & talk* (08).

## Q

**Qdrant** — Vector database used for the RAG over the Obsidian vault. Default collection name: `obsidian-context`.

**Quantization** — Reducing model weight precision (8-bit, 9-bit oQ, 4-bit, …) to fit in less RAM. Trade-off: less RAM, slight quality loss.

**Qwen3** — Family of open-source LLMs from Alibaba (Qwen3-Coder-Next, Qwen3.5, Qwen3.6, …). A common choice for local Apple Silicon deployments via MLX.

## R

**RAG** — Retrieval-Augmented Generation. Companion uses it via Qdrant + bge-m3 over your Obsidian vault when the `rag_search` tool is enabled.

**Reasoner** — A model that supports `enable_thinking` (Hy3-preview, Qwen3-thinking, Claude with extended thinking). Longer turns, deeper output.

**Reasoning effort** — OpenAI o-series convention adopted by some local models. Values: `none` / `minimal` / `low` / `medium` / `high` / `xhigh`. Controls how much the model reasons before answering. Independent of the thinking toggle — relevant especially for always-think models (Step-3.7-Flash, MiniMax) that can't be told to stop thinking but can be told to think less. The engine (OdyssAI-X) applies a per-model default when nothing is sent (`minimal` for Step-3.7). See *Inference settings* (14).

**Remember now** — Action in the chat header memory menu to refresh the conversation's wiki snapshot from the current wiki state.

## S

**Session ID** — = the conversation UUID. Passed to OdyssAI-X as `session_id` for KV-cache reuse.

**Show metrics** — Per-user toggle (Settings → Inference) for the per-message stats row. Off by default.

**Skill** — Named markdown instruction package the agent loads on demand. See *Skills* (11).

**Stats row** — Per-message TTFT / duration / cached tokens / model line, when Show metrics is on.

**Stream** — Server-Sent Events from `/v1/chat/completions`. Companion buffers + persists incrementally.

## T

**Talk mode** — Full-screen voice surface. `kind='talk'` conversation. On the roadmap; see *Voice & talk* (08).

**TB5** — Thunderbolt 5. The mesh fabric between Apple Silicon nodes when JACCL/RDMA is used inside an OdyssAI-X cluster.

**Telemak** — Single-node Swift runtime (`mlx-swift-lm` fork) running on Apple Silicon. Orchestrated by OdyssAI-X. Appears in the Companion picker with a `Telemak` pool badge. Fast for models that fit on one node; no multi-node sharding. Requires v0.6.33+ for mixed-quantization models (6-bit body + 8-bit MoE gate). See *Engine pairing* (16).

**TTFT** — Time To First Token. Latency from request to first SSE event.

**Token (LLM)** — Unit of text seen by the model (~ 4 chars in English).

**Token (auth)** — Bearer credential. Several flavors in Companion: account session, engine bearer, MCP server bearer, agents token (`hms_*`), guest token (`g_*`).

**Tools** — MCP-style function definitions injected into the model's prompt when agent mode is on.

**Truncation (chat)** — Editing a user message deletes all messages downstream of the edit. Permanent. No branch tree.

## U

**Upstream** — The inference engine + its providers. From Companion's POV, anything past the engine URL.

## V

**Vault** — Obsidian-formatted markdown directory holding your wiki. Synced via the Obsidian plugin's bearer-token bridge.

**VLM** — Vision-Language Model. Also a common OdyssAI-X pool name (`vlm` alias) when mlx-vlm is deployed on a dedicated host.

## W

**Web Speech API** — Browser-side speech recognition. Used by push-to-talk. Local, no audio leaves browser.

## X

**`x_odyssai`** — Capability block per model in OdyssAI-X's `/v1/models` response. Drives the picker chips.

## Related

- *Welcome* (01) — high-level orientation
- *FAQ* (22) — common confusions
