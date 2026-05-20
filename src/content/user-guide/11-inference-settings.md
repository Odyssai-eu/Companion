# Inference settings

The cogwheel under the input opens the **Inference settings** panel. What you tune lives in three sections.

## Generation

- **Temperature** — randomness (0 = greedy, 2 = chaotic). Default 0.7.
- **Max tokens** — output cap. Default 32768. Cloud providers cap silently; we clamp to their published ceiling so you don't get 400s.
- **Top-p / Top-k / Min-p** — sampling cutoffs. Leave defaults unless you know why you're changing them.
- **Repetition penalty** — discourage loops.
- **Seed** — set for deterministic output (provider-permitting).
- **Stop sequences** — comma-separated strings.

The form field set you see varies by model: Anthropic rejects requests with both `temperature` and `top_p`, so we drop `top_p` automatically for Claude routes.

## Inference presets

Saved bundles of the parameters above. Each preset has a name; the dropdown loads it, and **Save current** captures the active values.

System prompt is **not** part of a preset — it lives at the project / conversation level. Presets are pure sampling knobs.

Synced across devices.

## System prompt

The free-form textarea at the bottom of the panel is a **conversation-level** system prompt. It's not saved between chats. If you want a reusable named prompt, create a **Skill** instead (*Settings → Extensions → Skills*) — that's the new home for named prompts.

The **included / not included** toggle controls whether this text is sent to the model. Useful if you want to keep a draft system prompt around without applying it yet.

## Thinking mode (where supported)

Some models expose a "thinking" budget (reasoners on Odysseus, Claude with extended thinking). The Inference panel has a **Thinking** toggle and, when on, a **Reasoning effort** chooser (low / medium / high).

Companion always sends `enable_thinking` explicitly — no relying on provider defaults. Off by default, on when you toggle it. Reasoner outputs may take longer; voice mode and Cowork-style long runs use the non-blocking inference pattern to avoid MCP timeouts.

## Session id & KV cache

When you chat through Odysseus, Companion passes `session_id = <conversationId>`. Odysseus reuses the KV prefix cache across turns when prompts share a prefix — which is always the case across turns of one conversation. You don't have to do anything; this is just why a follow-up turn is faster than the first.

LiteLLM and other gateways ignore the field.

## Model picker capability chips

- **👁** — vision (accepts images).
- **⚒** — tools / function-calling (required for agent mode + skill / MCP / workspace tools).

The picker pulls capabilities from the Odyssai `x_odyssai` contract when present (`supports_tools`, `pool`, `backend`); falls back to a denylist for cloud aliases.
