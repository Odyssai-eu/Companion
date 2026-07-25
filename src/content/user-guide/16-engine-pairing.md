# Engine pairing

Where you tell Companion what's behind the chat window. Pair once, the catalog and routing flow from there.

## Instance settings vs. your own

A Companion deployment normally talks to **one** engine, so the connection is configured at the level of the *instance*, not per person:

- An administrator fills in **Settings → Admin → Instance settings** (engine URL, crew token, mode, default model, optional LiteLLM rail) — or pairs an engine from their own Settings page and clicks **Publish my settings as instance settings**.
- Every account **inherits** those values. A brand-new user logs in to a working app: models in the picker, chat ready, nothing to configure.
- Anyone can still **override** any of them for their own account by pairing a different engine — the gateway card then loses its `instance` badge.
- **Reset to instance settings** (Settings → Inference, and Settings → Add-ons for the LiteLLM fields) removes the override and puts the account back on the shared config.

This is inheritance, not a copy: nothing is duplicated onto your account when you're inheriting. When the administrator repoints the instance engine, every inheritor follows automatically — no re-pairing, and no stale URL left behind on individual accounts.

Two things only an administrator can do, because they affect everybody: **Disconnect** and **Reload config** are hidden on an inherited engine.

## The three modes

Companion supports three engine modes, auto-derived at pair time:

### Gateway mode

- **Best with**: OdyssAI-X and any engine that publishes `/.well-known/inference-engine.json` with `features.cloud-passthrough`.
- **What happens**: 100% of `/v1/chat/completions` calls go to the engine. LiteLLM is bypassed entirely (`litellm_disabled = true`). The engine exposes both local pools and cloud passthroughs as a unified `/v1/models` catalog.
- **Why preferred**: cleanest routing. The engine is the single point of truth. KV-cache hits work (OdyssAI-X reuses prefixes via `session_id`). Capability contract (`x_odyssai`) preserved end-to-end — vision / tools chips reflect what the model actually does.

### Hybrid mode

- **When**: engine paired but doesn't advertise `cloud-passthrough`. Companion needs to route cloud (Anthropic, OpenAI, OpenRouter) somewhere → falls back to LiteLLM.
- **What happens**: `/v1/models` and capability discovery from the engine; inference dispatched via LiteLLM. The engine catalogue is merged with LiteLLM's.
- **Use case**: legacy setups where LiteLLM is doing cloud routing and you don't want to migrate to gateway. Transitional.

### Legacy mode

- **When**: no engine paired (only `litellm_url` set).
- **What happens**: everything through LiteLLM. Capabilities heuristic-only (no `x_odyssai` contract). No KV-cache hints.
- **Use case**: pre-OdyssAI-X setups, Ollama-only on a LAN with a LiteLLM front, or transitional period before pairing OdyssAI-X.

The mode is **auto-set** during the pairing handshake. You can override it manually in *Settings → Inference* but the default is usually right.

## Pairing flow

*Settings → Infrastructure → Engine* → **Pair** button. The flow:

1. **Discovery probe** — Companion does an LAN scan for OD discovery (OdyssAI-X's discovery beacon). If found, the engine URL is pre-filled.
2. **Manual entry** — you can paste the engine URL directly (e.g. `http://<engine-host>:8000`). Used when the engine isn't on the same LAN as the browser.
3. **Auth** — optional bearer token. Required if the engine has admin auth enabled.
4. **Test endpoint** — Companion hits two URLs:
   - `GET /.well-known/inference-engine.json` — capability contract. Returns the engine name/version + features array.
   - `GET /v1/models` — the catalog.
5. **Mode derivation** — based on the engine's `features`:
   - `cloud-passthrough` present → `gateway` mode, `litellm_disabled = true`.
   - `cloud-passthrough` absent → `hybrid` mode, `litellm_disabled = false`.
   - No engine reachable → `legacy` mode, `litellm_url` must be set.

The mode is stored in `global_settings.engine_mode` for the instance, and in `users.engine_mode` for anyone who overrides it. Visible in *Settings → Inference*; editable instance-wide in *Settings → Admin → Instance settings*.

## LiteLLM (fallback rail)

LiteLLM (typically deployed at `<litellm-host>:4000`) remains supported as a **fallback rail** for clients that haven't migrated to gateway mode.

When to keep LiteLLM enabled:

- You have agents (Continue.dev, custom scripts) pointed at LiteLLM directly that you haven't migrated.
- You need the Anthropic protocol bridge (LiteLLM does this; OdyssAI-X does too via `/v1/messages` — both paths exist).
- Transitional setups.

When to disable LiteLLM (`litellm_disabled = true`):

- You're 100% on gateway mode with OdyssAI-X.
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

The same eight fields exist in two places. `global_settings` (a single row) holds the **instance** values; the `users` table holds a per-account **override** that is `NULL` whenever you inherit. Every read resolves `user value ?? instance value`, then the deployment's `LITELLM_URL` / `LITELLM_API_KEY` env vars as a last resort for the LiteLLM pair.

- `engine_url` — the URL (e.g. `http://<engine-host>:8000`).
- `engine_token` — bearer for admin endpoints. Never returned by the API in clear: reads only report whether one is set.
- `engine_meta` — cached `.well-known` body, always the one belonging to whichever engine won.
- `engine_mode` — `gateway` / `hybrid` / `legacy`.
- `litellm_url` — LiteLLM URL (for hybrid/legacy paths).
- `litellm_api_key` — LiteLLM key. Masked like the crew token.
- `litellm_disabled` — kill switch.

Plus `default_model`, which follows the same rule.

Clearing a field in the UI stores `NULL`, i.e. "inherit" — it does not store a blank. That's what makes **Reset to instance settings** a one-click action rather than a re-typing exercise.

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

For the whole deployment (administrator): *Settings → Admin → Instance settings* → edit the engine URL / token / mode → **Save**. Every inheriting account moves with it on their next request. Alternatively, pair the new engine from your own Settings page, confirm it works, then **Publish my settings as instance settings**.

For your account only:

1. *Settings → Infrastructure → Engine* → **Unpair**.
2. **Pair** again with the new URL.
3. Mode re-derives on the new handshake.

Unpairing a personal engine drops you back to the instance one rather than to an empty app.

Conversations stay — they're not engine-bound at the row level. The conversation's `model` field is a string (alias), and the new engine should also publish that alias for continuity.

If the new engine doesn't publish a given alias, future turns of those conversations error out until you re-route them. Bulk-edit via the API if needed, or open a fresh conv.

## Telemak nodes

OdyssAI-X can orchestrate **Telemak** nodes — single-node Swift runtime (`mlx-swift-lm`) running on Apple Silicon. From Companion's perspective they're transparent: OdyssAI-X proxies them and publishes their loaded models in the catalog alongside distributed pools.

In the picker, Telemak-served models show the `Telemak` pool badge (instead of `Argo` or the cluster label). The model name, load state, and capability chips work the same way.

What's different under the hood:
- Telemak is a single-node runtime — no JACCL/RDMA, no multi-node sharding. Throughput is determined by that one node's memory bandwidth.
- Load/unload is controlled from the OdyssAI-X admin dashboard (Start / Stop / Restart / Quit per cluster).
- Models with mixed quantization (e.g. 6-bit body + 8-bit MoE gate) require Telemak 0.6.33+. Earlier versions load but generate corrupted output.

Telemak nodes are configured in OdyssAI-X (not in Companion). Once configured and loaded, they appear in the picker automatically.

## Related

- *Model picker* (06) — what gateway/hybrid/legacy modes feel like from the picker
- *Inference settings* (14) — the cogwheel + presets
- *Troubleshooting* (20) — pairing-specific failures
- *Glossary* (21) — gateway, hybrid, legacy, KV cache, session_id, Telemak
