# Semantic routing

The Auto Router add-on picks the right model for you, per message. Companion looks at what you typed and dispatches to the model best suited for it — conversation, deep analysis, or code. The decision is shown under the answer.

Two ways to reach it:

- Set *Settings → Inference → Inference mode* to **Auto**. The chat's model selector disappears entirely and every message is routed.
- Stay in **Expert** mode and pick `Auto` from the model picker when you want it.

## What it actually does

Every time you send a message with `Auto` selected:

1. The latest user message is sent to a small embedding model (default: `Qwen3-Embedding-0.6B-mxfp8`, ~600 MB, ~6 ms per query).
2. The embedding is compared by cosine similarity to three pre-computed centroids — one per bucket: **chat**, **deep**, **code**. Each centroid is the average of ~10 anchor sentences for that intent.
3. The closest bucket wins. Companion dispatches the request to the model you configured for that bucket.
4. The decision is persisted on the assistant message and surfaced as a chip in the stats row: `Routed: chat 0.79`.

No prior turns are inspected — only the latest user message — to keep classification reactive. A conversation can switch buckets mid-stream and the next answer comes from a different model.

## Enabling it

Settings → **Add-ons** → **Auto Router** → toggle on. A panel opens with four things to fill in:

### Embedding service URL

Any OpenAI-compatible embeddings endpoint. The payload Companion sends is `{"input": ["…"]}`; the response must shape `{"data": [{"embedding": [floats…]}]}`.

The default field is empty — set it to whatever you host. Small models are fine; latency-wise you want something under 100 ms per single-string call.

> **Don't have an embedding service yet?** You need one running locally for the Auto Router to work — Companion never pings a default cloud one. Two pragmatic paths:
>
> - **Pair OdyssAI-X** and load any small open-weights embedding model (a 0.5–1B model is plenty). OdyssAI-X exposes the standard `/v1/embeddings` endpoint so it slots straight into this field.
> - **Hand the install to a coding agent.** Drop the [OdyssAI-X README](https://github.com/Odyssai-eu/Odysseus) (or your engine's docs) into Claude Code, Codex, Cursor, Aider, etc., and ask it to "set up an OpenAI-compatible embeddings server on this machine with `<model-of-your-choice>` and tell me the URL". It will do the venv / Docker / config work and hand back a URL you paste here.
>
> Either way, the Auto Router only needs the URL — pick whatever embedding model your hardware can spare a few hundred MB for.

### Model per bucket

Each bucket maps to one model id known to your engine. Defaults are empty so you make the call.

- **Chat** — small talk, identity, casual creative ("write me a poem"). Pick something fast and friendly: a 30–40B conversational tends to feel best here.
- **Deep** — analysis, comparison, philosophical or long-form ("explain in depth", "compare X and Y"). The biggest reasoner you can afford.
- **Code** — write, refactor, debug, test, implement. A code-tuned model — or a generalist that handles code well.

The buckets are intent buckets, not capability buckets. A "write me a poem" goes to **chat** even though it's creative — because the *user's mode* is conversational, not analytical.

The dropdown offers everything your engine publishes, uncurated. That includes **router-style virtual models** — if your engine exposes something like **CoeOS** (a model id that is itself a router), it shows up here and you can bind it to **Deep** or **Code** like any other model. The only entry excluded is `Auto` itself, since pointing a bucket at Auto would loop the router back into itself.

### Fallback model

The model that answers when the router *itself* can't run: embedding service unreachable, anchors never built, add-on switched off.

When that happens Companion does **both** things:

1. **Shows you the error** — a banner in the chat naming what failed, and a `Routed: fallback (routing failed)` chip on the message that survives a reload.
2. **Still answers**, using this model.

The point is that a dead embedding service degrades the answer instead of destroying the turn, without ever hiding the degradation from you.

Leave it empty to keep the strict behaviour: the turn fails with a 503 and no answer at all.

> Upgrading from the retired *Easy* mode? Its "Fallback model" setting was copied here automatically by migration `0058` — same role, new home.

### Save + build anchors

The first save embeds the ~30 anchor sentences once and stores the centroids in your add-on config. Subsequent saves only rebuild if the URL changes (different model = different vector space = old centroids are useless).

## Using it

In **Auto** inference mode there's nothing to do — there is no picker, every message is routed.

In **Expert** mode, open the model picker: **Auto** is in the group `Smart` at the top of the list. Pick it. Send a message normally.

That's it. The assistant replies. Below the reply, the stats row shows:

```
TTFT 1.2s · Duration 4.5s · … · Model <alias> — <concrete-name> · Routed deep 0.72
```

The chip means: the router classified this message as **deep** with a score of 0.72, and dispatched to whatever model you mapped `deep` to.

## Quick test

The add-on panel has a **Quick test** box. Type a sentence, click Test — you see the chosen label, model, score, and the per-bucket scores side by side. Useful when you want to check why a particular phrasing landed where it did, without sending a real chat.

## What happens when it fails

The router never fails *silently*. Whatever goes wrong — embedding service unreachable, no URL set, anchors never built, add-on toggled off — you are told, in the chat, in plain words.

What differs is whether you also get an answer:

| Fallback model set? | What you get |
|---|---|
| **Yes** | The error banner **and** a normal reply, generated by the fallback model. The message keeps a `Routed: fallback (routing failed)` chip so you can tell later that it wasn't a routed pick. |
| **No** | A `503` and no reply. The strict, original behaviour. |

Either way your message is never quietly sent to some model you didn't approve — that's the invariant. The fallback only applies because you named the model yourself.

## Tuning

The anchors are a small set of short sentences — about 10 per bucket. They're stored in `server/lib/semantic-router.ts` and can be edited.

If you find yourself frequently overriding a routing decision (e.g. a Python-talk message routes to `chat` instead of `code`), add the phrasing to the right bucket's anchor list and click **Rebuild anchors** in the panel. One-second roundtrip, the new centroid replaces the old.

If you want different buckets entirely — say, splitting `code` into `code-write` vs `code-debug`, or adding `vision` for image prompts — that needs a code change for now. The architecture is three-bucket today; nothing stops it from being more.

## Why this is different from cost-based routers

Most LLM routers (LiteLLM, OpenRouter, the cloud gateways) route on **cost** or **latency** — they pick the cheapest model that can plausibly handle the query, or balance load across providers.

Semantic routing routes on **intent**: not "what's cheapest", but "which model is actually best at this kind of question". A small fast model can be wrong even if it's free. Sending a casual greeting to a 397-billion-parameter reasoner is wasteful in the other direction. Each bucket gets the model that fits.

## What gets stored

On each routed message, the assistant turn carries these fields in its `stats`:

- `routedFrom: "auto"` — the original picker selection
- `routedLabel: "chat" | "deep" | "code"` — the winning bucket (or `"fallback"`)
- `routedScore: 0.0–1.0` — cosine similarity to the winning centroid
- `routedMs` — embedding service latency
- `routedError` — present **only** on the fallback path: why routing didn't run

These survive in your conversation history and in exports. Open the conversation a week later and the chip still tells you which brain answered which question.
