# FAQ

Common questions with direct answers. If your question isn't here, check *Troubleshooting* (20) or ask Sophie.

## General

**Do I need to install anything?**
No. Companion runs in your browser at `dev.thecomp.ai`. Pin it as a PWA if you want a desktop-like app icon.

**Does Companion ship its own model?**
No. Companion is a **client**. You bring the engine (local cluster Odysseus, or cloud keys for OpenRouter / Anthropic / OpenAI). One client, every backend.

**Can I use Companion offline?**
No. Companion is a hosted web app; it needs network to reach the engine and the Postgres backend. If you're on a fully air-gapped LAN with Companion + Odysseus deployed locally, "online" just means on that LAN.

**Is it open source?**
Companion is private (today). Odysseus development is in the open under the `odyssai.eu` banner. Status may evolve.

## Account

**How do I create an account?**
The workspace admin mints accounts. No self-serve sign-up — sovereignty trade-off.

**Multi-device login?**
Yes. Same account on phone, laptop, desktop. Conversations + memory + skills sync. See *Account & devices* (03).

**How do I delete my account?**
Admin-only today. Email Sophie. The cascade deletes everything (conversations, memory, skills, tokens, …).

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
Depends on the task:
- **Local fast** : `om:qwen-35b` (35B Qwen3.6 on oMLX) — strong default, vision-capable.
- **Local heavy reasoner** : `argo` → Hy3-preview-MLX-9bit (~38 tok/s on 1-node ultra-512).
- **Local code** : `om:coder-next` (Qwen3-Coder-Next on `.32`).
- **Cheap probe** : `probe` (Qwen2.5-Coder-1.5B autocomplete, sub-second).
- **Cloud fallback** : `or:claude-haiku` / `or:hy3-preview`.

**Can I change model mid-conversation?**
Yes. The picker is per-turn. The conversation can span multiple models. Past replies stay attached to their original model.

**What's the difference between `argo` and `or:hy3-preview`?**
Both serve Hy3-preview, but:
- `argo` runs on your local cluster (jaccl backend, 3-node ultra-512 + ultra-256a/b). No cloud bill.
- `or:hy3-preview` is OpenRouter passthrough. Counts against your OpenRouter budget. Useful when local is loaded with something else.

**Why is the picker empty?**
Engine not paired, or pairing failed. See *Engine pairing* (16).

## Memory

**What's Némo?**
The name the assistant gives itself. Not a single model — it's the orchestrator above whatever model you've routed to. The memory + the relationship + the persona. See *Memory* (10).

**Does the memory wiki update automatically?**
Yes. A compiler runs after 10 min of conversation inactivity, plus cron slots at 06:00 / 12:30 / 19:00. Conversations with `memoryEnabled = false` are excluded.

**Can I prevent a conversation from updating the wiki?**
Yes. Flip **Memory** toggle off in the chat header. The conversation won't compile back. Useful for sensitive chats.

**My wiki has wrong / outdated info — how do I fix it?**
Edit the article manually (Obsidian vault sync, or direct PG SQL), then mark it `edited_by_user = true` so the compiler doesn't drift it again.

**Why does the agent say things about me I didn't tell it?**
The compiler reads your conversations and extracts facts. If a fact is wrong, correct it + lock it. If it's right but unexpected: privacy choice — turn off Memory for conversations you don't want compiled.

## Voice

**Is push-to-talk private?**
Yes. 100% browser-side. No audio leaves your machine for transcription. See *Privacy & data* (18).

**What languages does TTS support?**
Voxtral-Realtime: English + French natively. Other languages: use Gemini Live addon (broader coverage, but cloud).

**Can I have a voice-only conversation?**
Yes. Open Talk mode from the sidebar bottom. Full-screen voice surface, hands-free.

**Why is the reply silent in voice mode?**
TTS server not reachable. Check *Settings → Inference → TTS endpoint*. Health probe should be green.

## MCP / agents tokens

**What's the difference between MCP servers and Agents tokens?**
Opposite directions:
- **MCP servers** = Companion is a client of remote MCP servers (Notion, Linear, GitHub, …). The agent in Companion gets their tools.
- **Agents tokens** = External agents (Cline, Continue.dev, Claude Desktop, Cowork) are clients of Companion's MCP brain endpoint. They use your conversations + memory + skills.

**Can I revoke an agent token?**
Yes. Per-row revoke in *Settings → Extensions → Agents tokens*. Instant.

**Why does my IDE agent get a 45s timeout?**
Long reasoner runs. Use the non-blocking `companion_send_message` + `companion_get_inference_status` pattern instead of expecting the message tool to block. See *Agents tokens* (13).

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
With Odysseus on your LAN + gateway mode + local models only: everything. Conversations, memory, compute, all your data sovereignty.

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
JACCL queue pair degradation, known upstream MLX/JACCL bug. Reboot the affected cluster nodes (Reboot all button in Odysseus dashboard). Documented behaviour, no fix in MLX 0.31.x.

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
Not public. Ask Sophie if you have a specific need.

## Related

- *Welcome* (01) — orientation
- *Troubleshooting* (20) — specific bug fixes
- *Glossary* (21) — terms used
