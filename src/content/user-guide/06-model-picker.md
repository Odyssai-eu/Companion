# Model picker

Picking what's behind the chat. Companion can route to many models in many ways; this topic covers all of them.

## Where the picker lives

In the **chat header**, leftmost element. Click it to open the model panel. The label always reads `<alias> — <concrete>` when both are known (e.g. `my-cluster — Qwen3-MLX-8bit`), or just `<alias>` for cloud aliases that don't expose a concrete name.

## Inference modes

Three layouts, picked in *Settings → Inference*:

### Easy mode

One model, fixed by the workspace admin. No picker shown in the chat. The chat just uses that model.

For: users who don't want to think about routing. Customer-facing deployments.

### Advanced mode

Four **named slots** in the picker:

- **Conversation** — general chat, fast.
- **Analyse** — vision / reasoning-heavy.
- **Engineer** — code-focused.
- **Expert** — top of the line for the hardest turns.

The user picks the slot; the alias behind the slot is configured per slot (Settings → Inference → Advanced). Hot-swap by clicking the slot in the picker.

For: users who want a curated set without facing the full catalog.

### Expert mode (default)

Full catalog. Search bar at top, every alias listed below. Capability chips next to each, hide/show eye toggle on hover.

For: power users tuning per-turn.

## Capability chips

Next to every model in the picker:

- **👁** vision-capable — accepts `image_url` parts. From `caps.supports_vision`.
- **⚒** tools / function-calling — required for skill_*, MCP, fs_*, agent mode. From `caps.supports_tools`.
- **⚡** sub-second TTFT — autocomplete or probe-class models on local LAN. Heuristic.
- **🧠** reasoner — supports `enable_thinking` natively. From `caps.supports_thinking`.
- **🌐** cloud — routed via OpenRouter / Anthropic / OpenAI. Counts against your bill.
- **🟢** loaded — the model is currently in cluster RAM (Odysseus only). Hot, no cold-start.

Chips come from the Odyssai `x_odyssai` contract when paired in gateway mode. In hybrid / legacy, they fall back to a denylist heuristic on model id strings.

## Hidden models

Each row has an eye toggle (👁/🙈) revealed on hover. Click to hide.

- **In Easy mode** — hidden ids are filtered out entirely. Even the admin's pick is suppressed if it's in the user's hide list (rare but documented).
- **In Advanced / Expert mode** — hidden ids appear **grayed out** with opacity 45%, still pickable. Click the eye on a grayed row to un-hide.

The hide list is per-user, stored in `users.hidden_models` (jsonb array). Synced across devices.

Use cases:

- Hide deprecated aliases you don't want to scroll past.
- Hide expensive cloud models you don't trust yourself to avoid.
- Hide models that don't work with your engine setup.

## Switching mid-conversation

Click the model picker in the chat header → pick another model → next turn fires through it. The conversation keeps the new model as its "active" model going forward. Past replies stay attached to their original model (visible in the per-message stats row when Show metrics is on).

This means **one conversation can span multiple models**. The session_id stays the same (= the conversation UUID), so Odysseus keeps the KV prefix cache between turns — but the cache hit depends on the new model loading the same prefix bytes. Mixing two different model families in one conv = expect cold prefill on every model change.

## Aliases vs concrete model names

Companion shows **aliases** in the picker (`<your-cluster-name>`, `or:claude-haiku`, `probe`). The engine resolves them to concrete model paths internally. The stats row shows both:

```
Model: <alias> — <concrete-model>
```

If you only see the alias and the concrete is missing, the engine didn't return `x_odyssai.alias_for` for that model. Either pre-Odysseus engine, or cloud passthrough.

## Alias prefix conventions

Companion's catalog uses simple prefix conventions — the alias is whatever your engine publishes:

- **Local cluster pools** — pick your own name (`my-cluster`, `<lab>-fast`, etc.). One alias per pool.
- **`or:*`** — OpenRouter passthrough (`or:claude-haiku`, `or:gpt-5`, …).
- **Other prefixes** — anything you set up via the engine admin (one prefix per backend: an mlx-lm server, an LM Studio instance, an Ollama box, …).
- **`probe`** — by convention, the sub-second autocomplete model used for probe routing.

These are conventions, not enforced. Whatever your engine publishes is what shows up — pick whatever names fit your setup.

## Model that's not loaded

For Odysseus cluster pools, the model is loaded **on demand**. The picker shows it; you select it; the engine triggers a load on the first request (you'll see a "Loading model…" banner with a progress bar in the chat).

A typical MLX MoE load takes 15-50 seconds depending on size and node count. Subsequent turns reuse the loaded weights.

To force unload (free the cluster RAM): admin dashboard on the engine itself (not via Companion).

## Engine mode + the picker

- **Gateway mode** — picker shows engine's `/v1/models` (rich caps, locally enriched).
- **Hybrid mode** — picker shows LiteLLM's aliases, caps come from engine's separate catalog merge.
- **Legacy mode** — picker shows LiteLLM aliases, capabilities by string-heuristic only.

If your picker is empty: the engine probe is failing. See *Troubleshooting* (20).

## Named models (Advanced mode config)

Settings → Inference → **Advanced** → 4 dropdowns for the slots:

- `conversation` — your everyday chat model.
- `analyse` — a vision-capable / reasoning-heavy model.
- `engineer` — a code-tuned model.
- `expert` — your strongest model, for the hardest turns.

You pick what fills each slot from your engine's catalogue — there are no built-in defaults. Stored as `users.named_models` jsonb. Editing here is a workspace-wide change for your account.

## Default model

`users.default_model` (Settings → Inference → Default). Used when a conversation is created without an explicit model.

In Easy mode this is also the *only* model. In Advanced it pre-fills the "Conversation" slot. In Expert it's the picker's pre-selected entry.

## Related

- *Engine pairing* (16) — pairing the engine that publishes the catalog
- *Inference settings* (14) — the cogwheel, presets, sampling
- *Glossary* (21) — alias, gateway, hybrid, legacy, probe routing
