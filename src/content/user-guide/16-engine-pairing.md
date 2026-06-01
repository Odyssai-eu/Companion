# Engine pairing

Where you tell Companion what's behind the chat window. Pair once, the catalog and routing flow from there.

## The three modes

Companion supports three engine modes, auto-derived at pair time:

### Gateway mode

- **Best with**: Odysseus and any engine that publishes `/.well-known/inference-engine.json` with `features.cloud-passthrough`.
- **What happens**: 100% of `/v1/chat/completions` calls go to the engine. LiteLLM is bypassed entirely (`litellm_disabled = true`). The engine exposes both local pools and cloud passthroughs as a unified `/v1/models` catalog.
- **Why preferred**: cleanest routing. The engine is the single point of truth. KV-cache hits work (Odysseus reuses prefixes via `session_id`). Capability contract (`x_odyssai`) preserved end-to-end — vision / tools chips reflect what the model actually does.

### Hybrid mode

- **When**: engine paired but doesn't advertise `cloud-passthrough`. Companion needs to route cloud (Anthropic, OpenAI, OpenRouter) somewhere → falls back to LiteLLM.
- **What happens**: `/v1/models` and capability discovery from the engine; inference dispatched via LiteLLM. The engine catalogue is merged with LiteLLM's.
- **Use case**: legacy setups where LiteLLM is doing cloud routing and you don't want to migrate to gateway. Transitional.

### Legacy mode

- **When**: no engine paired (only `litellm_url` set).
- **What happens**: everything through LiteLLM. Capabilities heuristic-only (no `x_odyssai` contract). No KV-cache hints.
- **Use case**: pre-Odysseus setups, Ollama-only on a LAN with a LiteLLM front, or transitional period before pairing Odysseus.

The mode is **auto-set** during the pairing handshake. You can override it manually in *Settings → Inference* but the default is usually right.

## Pairing flow

*Settings → Infrastructure → Engine* → **Pair** button. The flow:

1. **Discovery probe** — Companion does an LAN scan for OD discovery (Odysseus's discovery beacon). If found, the engine URL is pre-filled.
2. **Manual entry** — you can paste the engine URL directly (e.g. `http://<engine-host>:8000`). Used when the engine isn't on the same LAN as the browser.
3. **Auth** — optional bearer token. Required if the engine has admin auth enabled.
4. **Test endpoint** — Companion hits two URLs:
   - `GET /.well-known/inference-engine.json` — capability contract. Returns the engine name/version + features array.
   - `GET /v1/models` — the catalog.
5. **Mode derivation** — based on the engine's `features`:
   - `cloud-passthrough` present → `gateway` mode, `litellm_disabled = true`.
   - `cloud-passthrough` absent → `hybrid` mode, `litellm_disabled = false`.
   - No engine reachable → `legacy` mode, `litellm_url` must be set.

The mode is stored in `users.engine_mode`. Visible (and editable) in *Settings → Inference*.

## LiteLLM (fallback rail)

LiteLLM (typically deployed at `<litellm-host>:4000`) remains supported as a **fallback rail** for clients that haven't migrated to gateway mode.

When to keep LiteLLM enabled:

- You have agents (Continue.dev, custom scripts) pointed at LiteLLM directly that you haven't migrated.
- You need the Anthropic protocol bridge (LiteLLM does this; Odysseus does too via `/v1/messages` — both paths exist).
- Transitional setups.

When to disable LiteLLM (`litellm_disabled = true`):

- You're 100% on gateway mode with Odysseus.
- You don't want any path that bypasses the engine's session_id / capability contract.

The toggle is in *Settings → Inference → LiteLLM disabled*. Disabling forces all routing through the engine; if the engine fails, no fallback.

## What "engine paired" enables

Once paired, the chat header model picker fills with the engine's catalogue. Specifically:

- `/v1/models` → list of aliases + concrete model names + `x_odyssai` capability blocks.
- Aliases (whatever you set up on the engine — `<your-cluster-name>`, `or:claude-haiku`, `probe`, …) show up grouped (Local / Cloud).
- Each model has vision / tools / streaming chips based on `x_odyssai.supports_*`.

Without engine pairing (legacy mode):

- The picker shows LiteLLM aliases only.
- Capabilities heuristic-only (no contract).
- No KV-cache reuse (no `session_id` propagation).

## Multi-engine

Today: one engine per account. *Settings → Infrastructure → Engine* is single-target.

On the roadmap: per-project engine override (route a coding project to a fast local cluster while a general chat project goes to a cloud reasoner). For now, switch engines manually or use the model picker to choose between cloud and local on a per-turn basis.

## What gets stored

In `users` table:

- `engine_url` — the URL (e.g. `http://<engine-host>:8000`).
- `engine_token` — bearer for admin endpoints (encrypted).
- `engine_meta` — cached `.well-known` body.
- `engine_mode` — `gateway` / `hybrid` / `legacy`.
- `litellm_url` — LiteLLM URL (for hybrid/legacy paths).
- `litellm_api_key` — LiteLLM key.
- `litellm_disabled` — kill switch.

## Pairing failures

**Engine returns 200 on `/v1/models` but pairing fails**

`/.well-known/inference-engine.json` is missing. Companion considers it "Odyssai-compatible" only when the well-known is reachable. Add the well-known to your engine, or accept hybrid/legacy mode.

**Engine reachable on LAN but not from the browser**

Common with Cloudflare-tunneled dev setups. Companion runs in your browser → the engine URL has to be reachable from there. If your browser is on the wide internet and the engine is LAN-only, expose it via a tunnel or VPN.

**Bearer token rejected**

The token's wrong or expired. The engine's admin auth may be configured separately from the basic endpoints — check the engine's docs.

**Discovery probe returns nothing**

OD discovery uses mDNS on UDP 5353. Some networks (corporate WiFi, public routers) block multicast. Manual entry works fine in those cases.

## Switching engines

To repoint to a different engine:

1. *Settings → Infrastructure → Engine* → **Unpair**.
2. **Pair** again with the new URL.
3. Mode re-derives on the new handshake.

Conversations stay — they're not engine-bound at the row level. The conversation's `model` field is a string (alias), and the new engine should also publish that alias for continuity.

If the new engine doesn't publish a given alias, future turns of those conversations error out until you re-route them. Bulk-edit via the API if needed, or open a fresh conv.

## Telemak nodes

Odysseus can orchestrate **Telemak** nodes — single-node Swift runtime (`mlx-swift-lm`) running on Apple Silicon. From Companion's perspective they're transparent: Odysseus proxies them and publishes their loaded models in the catalog alongside distributed pools.

In the picker, Telemak-served models show the `Telemak` pool badge (instead of `Argo` or the cluster label). The model name, load state, and capability chips work the same way.

What's different under the hood:
- Telemak is a single-node runtime — no JACCL/RDMA, no multi-node sharding. Throughput is determined by that one node's memory bandwidth.
- Load/unload is controlled from the Odysseus admin dashboard (Start / Stop / Restart / Quit per cluster).
- Models with mixed quantization (e.g. 6-bit body + 8-bit MoE gate) require Telemak 0.6.33+. Earlier versions load but generate corrupted output.

Telemak nodes are configured in Odysseus (not in Companion). Once configured and loaded, they appear in the picker automatically.

## Related

- *Model picker* (06) — what gateway/hybrid/legacy modes feel like from the picker
- *Inference settings* (14) — the cogwheel + presets
- *Troubleshooting* (20) — pairing-specific failures
- *Glossary* (21) — gateway, hybrid, legacy, KV cache, session_id, Telemak
