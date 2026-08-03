# FAQ

Common questions with direct answers. If your question isn't here, check *Troubleshooting* (20) or ping your workspace admin.

## General

**Do I need to install anything?**
No. Companion runs in your browser at your Companion host. Pin it as a PWA if you want a desktop-like app icon.

**Does Companion ship its own model?**
No. Companion is a **client**. You bring the engine (local cluster OdyssAI-X, or cloud keys for OpenRouter / Anthropic / OpenAI). One client, every backend.

**Can I use Companion offline?**
No. Companion is a hosted web app; it needs network to reach the engine and the Postgres backend. If you're on a fully air-gapped LAN with Companion + OdyssAI-X deployed locally, "online" just means on that LAN.

**Is it open source?**
Companion is private (today). OdyssAI-X development is in the open under the `odyssai.eu` banner. Status may evolve.

## Account

**How do I create an account?**
The workspace admin mints accounts. No self-serve sign-up — sovereignty trade-off.

**Multi-device login?**
Yes. Same account on phone, laptop, desktop. Conversations + memory + skills sync. See *Account & devices* (03).

**How do I delete my account?**
Admin-only today. Contact your workspace admin. The cascade deletes everything (conversations, memory, skills, tokens, …).

**Can I share an account with someone?**
Technically yes, but each chat compiles into the **same memory wiki**. The wiki will quickly become incoherent because it represents "the account holder", not "this specific user". Better: mint two accounts.

## Chat

**Can I have multiple chats at once?**
Yes. Open multiple tabs, multiple conversations stream in parallel. The sidebar shows a 🟢 dot on each conversation that's currently streaming.

**Edit a message — what happens to the rest?**
Truncated. Permanent. No branch tree. See *Chat basics* (05).

**Can I see model "thinking"?**
Yes, when the model supports it (Hy3-preview, Qwen3-thinking, Claude with extended thinking) and Thinking is toggled on in the Inference panel. The `<think>` block is collapsed by default in the chat — click to expand.

**Why is my first turn slow but subsequent turns fast?**
KV prefix cache. First turn pays the full prefill (system prompt + memory snapshot + history). Subsequent turns reuse the cached prefix → only the delta is prefilled. See *Inference settings* (14).

**Can I export a conversation?**
Yes. Sidebar → hover row → menu → Export → `.md` or `.json`. See *Exports & imports* (17).

**Can I import a conversation from somewhere else?**
No UI today. Possible via the API. Tell us if you need it.

## Models

**Which model should I use?**
Depends on the task. A typical deployment publishes aliases along these axes:
- **Local fast conversational** — a 30–40B chat model on a single-node inference server. Vision-capable. Good default.
- **Local heavy reasoner** — a big MoE (100B+ active) on a multi-node pool for hard analysis.
- **Local code** — a code-tuned model on a dedicated pool.
- **Probe** — a 1-2B model for autocomplete and tiny lookups (sub-second TTFT).
- **Cloud fallback** — OpenRouter / Anthropic / OpenAI passthrough aliases (e.g. `or:claude-haiku`).

The exact names depend on your deployment — check the model picker. The Auto Router (see *Semantic routing*) can pick for you per-message.

**Can I change model mid-conversation?**
Yes. The picker is per-turn. The conversation can span multiple models. Past replies stay attached to their original model.

**What's the difference between a local alias and the OpenRouter passthrough of the same model?**
Both can serve the same model family, but:
- A **local alias** runs on your cluster. No cloud bill, no data leaves the LAN, throughput depends on your hardware.
- A **`or:`-prefixed alias** is OpenRouter passthrough. Counts against your OpenRouter budget. Useful when local is loaded with something else, or when you need a model your cluster doesn't host.

**Why is the picker empty?**
Engine not paired, or pairing failed. See *Engine pairing* (16).

## Memory

**What's Némo?**
The name the assistant gives itself. Not a single model — it's the orchestrator above whatever model you've routed to. The memory + the relationship + the persona. See *Memory* (10).

**Does the memory wiki update automatically?**
Yes. A compiler runs after 10 min of conversation inactivity, plus cron slots at 06:00 / 12:30 / 19:00 server time. Conversations with `memoryEnabled = false` are excluded.

**Can I prevent a conversation from updating the wiki?**
Yes. Flip **Memory** toggle off in the chat header. The conversation won't compile back. Useful for sensitive chats.

**My wiki has wrong / outdated info — how do I fix it?**
Edit the article manually (Obsidian vault sync, or direct PG SQL), then mark it `edited_by_user = true` so the compiler doesn't drift it again.

**Why does the agent say things about me I didn't tell it?**
The compiler reads your conversations and extracts facts. If a fact is wrong, correct it + lock it. If it's right but unexpected: privacy choice — turn off Memory for conversations you don't want compiled.

## Voice

**Is push-to-talk private?**
Yes. 100% browser-side. No audio leaves your machine for transcription. See *Privacy & data* (18).

**Is there voice output / Talk mode today?**
Not yet. Push-to-talk (input) works today; auto-speak (output) and the full-screen Talk surface are on the roadmap, with **Gemini Flash Live** as the planned TTS backend. See *Voice & talk* (08).

## Slash commands & add-ons

**How do I generate images?**
Type `/comfyui <your prompt>` in any chat. It opens the ComfyUI Imager modal — set the template, size, steps, and send. Requires the ComfyUI Imager add-on configured in *Settings → Add-ons*. See *Slash commands* (066).

**How do I use a coding agent on my machine?**
Delegation is native in v2.0: ask Némo and it dispatches specialized subagents (explore, writer, ops) via the task tool — live task cards show every step. For a coding agent on your own machine, use an IDE agent wired to Companion's MCP brain (*API access*, 13).

**What happened to /hermes and /pi?**
Retired in v2.0 — delegation is native now. Némo dispatches subagents via the task tool; the Agents registry lives in Settings → Extensions → Agents.

**How do I search the user guide?**
Type `/help <question>` in any chat. Returns a synthesised answer with source chips linking to the relevant articles.

**What slash commands are available?**
`/help`, `/comfyui`, `/exit`. See *Slash commands* (066) for the full reference.

## MCP / agents tokens

**What's the difference between MCP servers and API access?**
Opposite directions:
- **MCP servers** = Companion is a client of remote MCP servers (Notion, Linear, GitHub, …). The agent in Companion gets their tools.
- **API access** = External agents (Cline, Continue.dev, Claude Desktop, Cowork) are clients of Companion's MCP brain endpoint. They use your conversations + memory + skills.

**Can I revoke an agent token?**
Yes. Per-row revoke in *Settings → Extensions → API access*. Instant.

**Why does my IDE agent get a 45s timeout?**
Long reasoner runs. Use the non-blocking `companion_send_message` + `companion_get_inference_status` pattern instead of expecting the message tool to block. See *API access* (13).

## Skills

**Is a skill the same as a system prompt?**
Sort of, but the agent loads it **on demand** when relevant — vs a system prompt which is always-on. See *Presets vs skills vs prompts* (15).

**Can I import a skill from agentskills.io?**
Yes, drop the SKILL.md or ZIP on *Settings → Extensions → Skills → Import*. Companion follows the agentskills.io specification.

**Can Némo create skills?**
Yes. Say in chat "create a skill named X that …" and the agent calls `skill_create`.

**How is a skill different from a project system prompt?**
- **Project system prompt** = static, applies to every conversation in that project.
- **Skill** = loaded on demand by the agent when relevant, in any conversation. Reusable across projects.

## Privacy

**What stays on my LAN?**
With OdyssAI-X on your LAN + gateway mode + local models only: everything. Conversations, memory, compute, all your data sovereignty.

**What if I use a cloud model?**
That conversation's content goes to the cloud provider (OpenRouter / Anthropic / OpenAI). Their privacy policy applies. Companion doesn't add identifying headers.

**Is my data used for training?**
Not by Companion. Cloud providers depend on their own policies — read their data-use terms.

**Where are my tokens stored?**
Encrypted at rest in your account's Postgres rows. Bcrypt-hashed for `hms_…` tokens (one-way). See *Privacy & data* (18).

## Performance

**Why does a long conversation slow down?**
Long prompts = long prefill. Each turn pays the prefill cost over the full history + memory + tools. Cache hits on the prefix help a lot, but the absolute size grows linearly with history.

Fixes: fork into a new conversation when one drags on (your memory wiki carries continuity), disable unused MCP servers, turn off Agent mode when not needed.

**TTFT spiked from 1s to 10s — why?**
- Cache busted (model switch, "Remember now", engine restart).
- Heavy attachment (PDF with many pages).
- Engine cold-loading the model.

Next turn after warm-up should be back to normal.

**Cluster gives errno 16 / 96 / 2 after several sessions**
JACCL queue pair degradation, known upstream MLX/JACCL bug. Reboot the affected cluster nodes (Reboot all button in OdyssAI-X dashboard). Documented behaviour in current MLX versions.

## Other

**Can I theme the UI?**
Not yet. The design system is fixed (Companion has its own visual identity — ink + cyan + navy + soft grays). Tell us if you have a strong use case.

**Mobile experience?**
Works. Sidebar collapses, voice mode works, file picker works. Push-to-talk works (mic permission needed). Some shortcuts don't apply (no keyboard).

**What about Talk on mobile?**
Recommended. The full-screen Talk UI is designed for thumb-only operation.

**Is there a CLI?**
Not for Companion. But you can drive everything via the API (`/api/conversations`, `/api/chat`, …) — bring your own client. The MCP brain endpoint also gives a clean RPC interface.

**Roadmap?**
Not public. Ask your workspace admin if you have a specific need.

## Related

- *Welcome* (01) — orientation
- *Troubleshooting* (20) — specific bug fixes
- *Glossary* (21) — terms used
