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

- **Thinking toggle** — on/off. Default off. For models that always reason (see below), the toggle has no effect — they think regardless.
- **Reasoning effort** — `none` / `minimal` / `low` / `medium` / `high` / `xhigh`. Controls how much the model reasons. **Independent of the thinking toggle** — always visible, always sent when set.

Companion always sends `enable_thinking` explicitly — never relies on provider defaults. This avoids drift between providers (each has its own default; sending the flag yourself keeps behaviour consistent across them).

### Always-think models (e.g. Step-3.7-Flash)

Some reasoning-first models (Step-3.7-Flash, MiniMax) always open a `<think>` block regardless of the toggle — there is no off-switch. For these, `reasoning_effort` is the real control:

- `minimal` — short reasoning, fast. **Default** for Step-3.7 when nothing is set explicitly.
- `low` / `medium` — balanced.
- `high` / `xhigh` — full reasoning budget. Useful for hard constrained tasks (long-form writing, strict JSON, count-exact output) but expect longer replies — 10k–30k+ tokens of reasoning on complex prompts.

For always-think models, Companion filters the `<think>` block out of the visible content and routes it to the collapsed reasoning area automatically — you never see raw `<think>` text in the chat.

When thinking is on (or always-think model):

- The reply takes longer (proportional to effort).
- The reasoning block is collapsed behind a chevron (click to expand).
- Some models stream it separately as `delta.reasoning_content` — Companion routes it to the collapsed area.

Note: when Voice mode ships, pair it with `minimal` effort or thinking off — heavy reasoning before audio leaves long silences (see *Voice & talk*, 08).

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

When you chat through OdyssAI-X, Companion passes `session_id = <conversationId>` in the request body. OdyssAI-X uses it to reuse the KV prefix cache across turns — when prompts share a prefix (which is always the case across turns of one conversation), only the delta is prefilled.

You don't have to do anything. This is just *why* a follow-up turn is faster than the first.

- **Gateway mode** — `session_id` is forwarded, OdyssAI-X uses it, cache hits are visible in the stats row as "Cached: N tok (X%)".
- **Hybrid / Legacy** — LiteLLM ignores the field. The flag still travels but does nothing upstream.

When you switch models mid-conversation, the cache doesn't migrate. The new model cold-prefills. Switching back to the original model still has a cache hit because OdyssAI-X keeps multiple sessions (per `session_id` × model id).

## Model picker capabilities

In the bottom of the inference panel (and in the chat header model picker), capability chips show:

- **👁** — vision (accepts images).
- **⚒** — tools / function-calling (required for agent mode + skill / MCP / workspace tools).
- **🧠** — supports `enable_thinking` natively.
- **⚡** — sub-second TTFT class (autocomplete, probe).
- **🟢** — currently loaded (OdyssAI-X only).

The picker pulls capabilities from the Odyssai `x_odyssai` contract when present (`supports_tools`, `supports_vision`, `pool`, `backend`, `alias_for`). Falls back to a denylist heuristic on model id strings for cloud aliases.

## Account-wide Inference settings

*Settings → Inference* (full page, not the cogwheel). What lives there:

- **Default model** — pre-fills new conversations in Expert mode. Ignored in Auto mode.
- **Inference mode** — **auto** or **expert**. Auto hides the chat's model selector and lets **CoeOS** (the router engine) choose per message; Expert shows the full catalog. (The former *easy* and *advanced* modes were retired in migration `0058` — both became *auto*.)
- **Hidden models** — eye-toggle hide list.
- **Show metrics** — per-message stats row toggle.
- **Debug verbose** — server-side log toggle (logs upstream request bodies). Off by default — produces a lot of stdout.

Auto mode is powered by **CoeOS** (the router engine), not an add-on. The **Default model** above doubles as the **fallback** when CoeOS or a target model is down — pick a stable local model or a reliable fast cloud provider. The old embeddings-based *Auto Router* add-on was removed in v2.1.

## Related

- *Model picker* (06) — the picker chips + inference modes
- *Presets vs skills vs prompts* (15) — when to use what
- *Engine pairing* (16) — what gateway / hybrid / legacy modes mean
