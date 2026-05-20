# Inference settings

The cogwheel under the input opens the **per-conversation Inference settings** panel. What you tune lives in five sections.

For account-wide settings (default model, mode, named slots, hidden models), go through *Settings → Inference* — the in-chat cogwheel is for conversation-local overrides.

## Generation

The sampling knobs:

- **Temperature** — randomness. 0 = greedy (deterministic), 1.0 = balanced, 2 = chaotic. Default 0.7.
- **Max tokens** — output cap. Default 32768. Cloud providers cap silently; Companion clamps to their published ceiling so you don't get 400s.
- **Top-p** — nucleus sampling cutoff (0–1). Default unset.
- **Top-k** — top-k filter (positive int). Default unset.
- **Min-p** — dynamic floor (0–1). Default unset.
- **Repetition penalty** — discourage loops (1.0 = neutral, 1.1+ = penalty). Default unset.
- **Seed** — set for deterministic output (provider-permitting; bigint).
- **Stop sequences** — comma-separated strings that abort generation when encountered.

The form field set you see varies by model:

- **Anthropic rejects requests with both `temperature` and `top_p`** — Companion drops `top_p` automatically for Claude routes.
- **Reasoner models** (Hy3-preview, Qwen3-thinking) ignore some sampling knobs in thinking mode; honored once thinking ends.

## Thinking mode

Some models expose a "thinking" budget — extended reasoning before the visible reply.

- **Thinking toggle** — on/off. Default off.
- **Reasoning effort** — low / medium / high / xhigh / minimal / none (only when thinking is on). Hints to the model how much reasoning to do.

Companion always sends `enable_thinking` explicitly — never relies on provider defaults. This avoids drift between providers (Anthropic on, Qwen3 off, oMLX off, etc.).

When thinking is on:

- The reply takes longer (proportional to effort).
- The `<think>…</think>` block is collapsed by default behind a chevron in the chat (click to expand).
- Some models stream the thinking content separately as `delta.reasoning_content` — Companion routes it to the collapsed area.

Voice mode + thinking high = bad combo (long silence before any audio). Use thinking off or low for voice.

## Inference presets

Saved bundles of the generation params above. Each preset has a name; the dropdown loads it, and **Save current** captures the active values.

- System prompt is **not** part of a preset — it lives at the project / conversation level. Presets are pure sampling knobs.
- Synced across devices.
- Per-user, not shared across the workspace.

Use presets for:

- "Creative" — temp 1.0, top_p 0.95.
- "Deterministic" — temp 0, seed=42.
- "Long reply" — max_tokens 65536, thinking off (cheaper).
- "Reasoner" — thinking on, effort medium.
- "Probe" — max_tokens 5, temp 0, model probe (cheap pings).

See *Presets vs skills vs prompts* (15) for when to use a preset vs other mechanisms.

## System prompt (conversation-level)

The free-form textarea at the bottom of the panel is a **conversation-level** system prompt override.

- It's NOT saved between chats.
- It's NOT a preset — saving as a preset doesn't capture it.
- For reusable named prompts: create a **Skill** instead (*Settings → Extensions → Skills*). Skills are the canonical home for named prompts.

The **Included / Not included** toggle controls whether this text is sent to the model. Useful if you want to keep a draft system prompt around without applying it yet.

The conversation-level prompt **overrides** the project system prompt (when in a project). So the precedence is:

```
conversation prompt > project prompt > engine default
```

## Session id & KV cache

When you chat through Odysseus, Companion passes `session_id = <conversationId>` in the request body. Odysseus uses it to reuse the KV prefix cache across turns — when prompts share a prefix (which is always the case across turns of one conversation), only the delta is prefilled.

You don't have to do anything. This is just *why* a follow-up turn is faster than the first.

- **Gateway mode** — `session_id` is forwarded, Odysseus uses it, cache hits are visible in the stats row as "Cached: N tok (X%)".
- **Hybrid / Legacy** — LiteLLM ignores the field. The flag still travels but does nothing upstream.

When you switch models mid-conversation, the cache doesn't migrate. The new model cold-prefills. Switching back to the original model still has a cache hit because Odysseus keeps multiple sessions (per `session_id` × model id).

## Model picker capabilities

In the bottom of the inference panel (and in the chat header model picker), capability chips show:

- **👁** — vision (accepts images).
- **⚒** — tools / function-calling (required for agent mode + skill / MCP / workspace tools).
- **🧠** — supports `enable_thinking` natively.
- **⚡** — sub-second TTFT class (autocomplete, probe).
- **🟢** — currently loaded (Odysseus only).

The picker pulls capabilities from the Odyssai `x_odyssai` contract when present (`supports_tools`, `supports_vision`, `pool`, `backend`, `alias_for`). Falls back to a denylist heuristic on model id strings for cloud aliases.

## Account-wide Inference settings

*Settings → Inference* (full page, not the cogwheel). What lives there:

- **Default model** — pre-fills new conversations.
- **Inference mode** — easy / advanced / expert. Drives the picker layout.
- **Easy model** — the single curated model for Easy mode.
- **Named models** — the 4 slots for Advanced mode (conversation / analyse / engineer / expert).
- **Hidden models** — eye-toggle hide list.
- **TTS endpoint** — Voxtral-Realtime URL.
- **Show metrics** — per-message stats row toggle.
- **Debug verbose** — server-side log toggle (logs upstream request bodies). Off by default — produces a lot of stdout.

## Related

- *Model picker* (06) — the picker chips + inference modes
- *Presets vs skills vs prompts* (15) — when to use what
- *Engine pairing* (16) — what gateway / hybrid / legacy modes mean
