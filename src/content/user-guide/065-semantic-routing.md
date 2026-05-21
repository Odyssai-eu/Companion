# Semantic routing

The Auto Router add-on picks the right model for you, per message. You pick `Auto` once in the model picker. Companion looks at what you typed and dispatches to the model best suited for it — conversation, deep analysis, or code. The decision is shown under the answer.

## What it actually does

Every time you send a message with `Auto` selected:

1. The latest user message is sent to a small embedding model (default: `Qwen3-Embedding-0.6B-mxfp8`, ~600 MB, ~6 ms per query).
2. The embedding is compared by cosine similarity to three pre-computed centroids — one per bucket: **chat**, **deep**, **code**. Each centroid is the average of ~10 anchor sentences for that intent.
3. The closest bucket wins. Companion dispatches the request to the model you configured for that bucket.
4. The decision is persisted on the assistant message and surfaced as a chip in the stats row: `Routed: chat 0.79`.

No prior turns are inspected — only the latest user message — to keep classification reactive. A conversation can switch buckets mid-stream and the next answer comes from a different model.

## Enabling it

Settings → **Add-ons** → **Auto Router** → toggle on. A panel opens with three things to fill in:

### Embedding service URL

Any OpenAI-compatible embeddings endpoint. The payload Companion sends is `{"input": ["…"]}`; the response must shape `{"data": [{"embedding": [floats…]}]}`.

The default field is empty — set it to whatever you host. Small models are fine; latency-wise you want something under 100 ms per single-string call.

### Model per bucket

Each bucket maps to one model id known to your engine. Defaults are empty so you make the call.

- **Chat** — small talk, identity, casual creative ("write me a poem"). Pick something fast and friendly: a 30–40B conversational tends to feel best here.
- **Deep** — analysis, comparison, philosophical or long-form ("explain in depth", "compare X and Y"). The biggest reasoner you can afford.
- **Code** — write, refactor, debug, test, implement. A code-tuned model — or a generalist that handles code well.

The buckets are intent buckets, not capability buckets. A "write me a poem" goes to **chat** even though it's creative — because the *user's mode* is conversational, not analytical.

### Save + build anchors

The first save embeds the ~30 anchor sentences once and stores the centroids in your add-on config. Subsequent saves only rebuild if the URL changes (different model = different vector space = old centroids are useless).

## Using it

In any chat, open the model picker. **Auto** is in the group `Smart` at the top of the list. Pick it. Send a message normally.

That's it. The assistant replies. Below the reply, the stats row shows:

```
TTFT 1.2s · Duration 4.5s · … · Model argo — Qwen3.5-397B · Routed deep 0.72
```

The chip means: the router classified this message as **deep** with a score of 0.72, and dispatched to whatever model you mapped `deep` to.

## Quick test

The add-on panel has a **Quick test** box. Type a sentence, click Test — you see the chosen label, model, score, and the per-bucket scores side by side. Useful when you want to check why a particular phrasing landed where it did, without sending a real chat.

## What happens when it fails

The router is opt-in and fail-loud. If the embedding service is unreachable, Companion returns a clear 503 with a message pointing back to Settings. Your message isn't silently sent to some fallback model.

If the add-on is enabled but not configured (no URL, no anchors), `Auto` returns a 400 saying "open Settings → Add-ons → Auto Router". You always know whether the router is in the loop.

## Tuning

The anchors are a small set of short sentences — about 10 per bucket, FR + EN mixed. They're stored in `server/lib/semantic-router.ts` and can be edited.

If you find yourself frequently overriding a routing decision (e.g. a Python-talk message routes to `chat` instead of `code`), add the phrasing to the right bucket's anchor list and click **Rebuild anchors** in the panel. One-second roundtrip, the new centroid replaces the old.

If you want different buckets entirely — say, splitting `code` into `code-write` vs `code-debug`, or adding `vision` for image prompts — that needs a code change for now. The architecture is three-bucket today; nothing stops it from being more.

## Why this is different from cost-based routers

Most LLM routers (LiteLLM, OpenRouter, the cloud gateways) route on **cost** or **latency** — they pick the cheapest model that can plausibly handle the query, or balance load across providers.

Semantic routing routes on **intent**: not "what's cheapest", but "which model is actually best at this kind of question". A small fast model can be wrong even if it's free. Sending a casual greeting to a 397-billion-parameter reasoner is wasteful in the other direction. Each bucket gets the model that fits.

## What gets stored

On each routed message, the assistant turn carries these fields in its `stats`:

- `routedFrom: "auto"` — the original picker selection
- `routedLabel: "chat" | "deep" | "code"` — the winning bucket
- `routedScore: 0.0–1.0` — cosine similarity to the winning centroid
- `routedMs` — embedding service latency

These survive in your conversation history and in exports. Open the conversation a week later and the chip still tells you which brain answered which question.
