# Model picker

Picking what's behind the chat. Companion can route to many models in many ways; this topic covers all of them.

## Where the picker lives

In the **chat header**, leftmost element. Click it to open the model panel. The label shows the **model name** when the engine provides it — org prefix and quantization suffix are stripped for readability (e.g. `mlx-community/Step-3.7-Flash-8bit` → `Step-3.7-Flash`). The quantization still appears in the row's subtitle. For cloud aliases that don't expose a concrete model name, the alias itself is shown.

## Inference modes

Two layouts, picked in *Settings → Inference*:

### Auto mode

No picker in the chat at all. Every message goes to **CoeOS** (the router engine), which composes a benchmark-proven model per skill (chat / deep analysis / code). You never choose — that's the point.

If CoeOS or a target model is unreachable, Companion falls back to your **Default model** (*Settings → Inference*) — it never substitutes a model silently.

For: users who don't want to think about model selection. Customer-facing deployments.

### Expert mode (default)

Full catalog. Every alias listed, capability chips next to each, hide/show eye toggle on hover. **Auto** is offered as the first entry (group `Smart`), so a power user can opt into routing per conversation without leaving the mode.

For: power users tuning per-turn.

> **Retired modes.** *Easy* and *Advanced* existed until migration `0058`. Auto replaces both. Accounts sitting on either were migrated to Auto automatically.

## Capability chips

Next to every model in the picker:

- **👁** vision-capable — accepts `image_url` parts. From `caps.supports_vision`.
- **⚒** tools / function-calling — required for skill_*, MCP, fs_*, agent mode. From `caps.supports_tools`.
- **⚡** sub-second TTFT — autocomplete or probe-class models on local LAN. Heuristic.
- **🧠** reasoner — supports `enable_thinking` natively. From `caps.supports_thinking`.
- **🌐** cloud — routed via OpenRouter / Anthropic / OpenAI. Counts against your bill.
- **🟢** loaded — the model is currently in cluster RAM (OdyssAI-X only). Hot, no cold-start.

Chips come from the Odyssai `x_odyssai` contract when paired in gateway mode. In hybrid / legacy, they fall back to a denylist heuristic on model id strings.

## Hidden models

Each row has an eye toggle (👁/🙈) revealed on hover. Click to hide.

Hidden ids appear **grayed out** with opacity 45%, still pickable. Click the eye on a grayed row to un-hide. (Auto mode has no picker, so the list is inert there.)

The hide list is per-user, stored in `users.hidden_models` (jsonb array). Synced across devices.

Use cases:

- Hide deprecated aliases you don't want to scroll past.
- Hide expensive cloud models you don't trust yourself to avoid.
- Hide models that don't work with your engine setup.

## Switching mid-conversation

Click the model picker in the chat header → pick another model → next turn fires through it. The conversation keeps the new model as its "active" model going forward. Past replies stay attached to their original model (visible in the per-message stats row when Show metrics is on).

This means **one conversation can span multiple models**. The session_id stays the same (= the conversation UUID), so OdyssAI-X keeps the KV prefix cache between turns — but the cache hit depends on the new model loading the same prefix bytes. Mixing two different model families in one conv = expect cold prefill on every model change.

## Model names vs cluster aliases

The picker shows the **loaded model's name** as the primary label — not the cluster alias you use to route to it. So selecting "Argo" or "kolos" in your engine config shows up as `Qwen3.5-397B-A17B` or `Step-3.7-Flash` in the picker, because that's what's actually loaded behind the alias.

The **pool badge** (the small chip next to the load state) carries the runtime identity: `Telemak` for Swift single-node runtimes, `Argo` (or your cluster's label) for distributed MLX pools, `cloud` for passthrough routes.

The stats row shows both the alias and the concrete path:

```
Model: <alias> — <concrete-model>
```

If the picker shows just an alias with no model name, the engine didn't return `x_odyssai.alias_for` for that entry — pre-OdyssAI-X engine or cloud passthrough without a concrete mapping.

## Alias prefix conventions

Companion's catalog uses simple prefix conventions — the alias is whatever your engine publishes:

- **Local cluster pools** — pick your own name (`my-cluster`, `<lab>-fast`, etc.). One alias per pool.
- **`or:*`** — OpenRouter passthrough (`or:claude-haiku`, `or:gpt-5`, …).
- **Other prefixes** — anything you set up via the engine admin (one prefix per backend: an mlx-lm server, an LM Studio instance, an Ollama box, …).
- **`probe`** — by convention, the sub-second autocomplete model used for probe routing.

These are conventions, not enforced. Whatever your engine publishes is what shows up — pick whatever names fit your setup.

## Model that's not loaded

For OdyssAI-X cluster pools, the model is loaded **on demand**. The picker shows it; you select it; the engine triggers a load on the first request (you'll see a "Loading model…" banner with a progress bar in the chat).

A typical MLX MoE load takes 15-50 seconds depending on size and node count. Subsequent turns reuse the loaded weights.

To force unload (free the cluster RAM): admin dashboard on the engine itself (not via Companion).

## Engine mode + the picker

- **Gateway mode** — picker shows engine's `/v1/models` (rich caps, locally enriched).
- **Hybrid mode** — picker shows LiteLLM's aliases, caps come from engine's separate catalog merge.
- **Legacy mode** — picker shows LiteLLM aliases, capabilities by string-heuristic only.

If your picker is empty: the engine probe is failing. See *Troubleshooting* (20).

## Auto routing (CoeOS)

Auto mode routes every message through **CoeOS** — a virtual model your engine advertises (owned_by `odyssai-coeos`). CoeOS composes a benchmark-proven model per skill (chat / deep analysis / code) internally; there's nothing per-bucket to configure on Companion's side. The only Companion setting that matters is the **Default model** below, which is the fallback when CoeOS or a target model is down.

## Default model

`users.default_model` (Settings → Inference → Default). Used when a conversation is created without an explicit model.

It's the picker's pre-selected entry in Expert mode, and ignored in Auto mode (the router chooses there).

## Related

- *Engine pairing* (16) — pairing the engine that publishes the catalog
- *Inference settings* (14) — the cogwheel, presets, sampling
- *Glossary* (21) — alias, gateway, hybrid, legacy, probe routing
