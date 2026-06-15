/**
 * Chat completion proxy — LiteLLM only.
 *
 * The frontend posts {conversationId, messages, model, inference}. We:
 *
 *   1. Resolve the user's LiteLLM target (per-user URL/key, env, fallback).
 *   2. Pull "what I remember about you" from the memory service and prepend
 *      it to the system prompt.
 *   3. Atomically read & advance users.last_interaction_at (single tx, FOR
 *      UPDATE row lock) — the read gives us T_old for the time tag, the
 *      write makes the next request see T_now.
 *   4. Inject [ISO | Δ: …] tags onto every user message. The latest one
 *      uses T_old as its delta basis; historicals use the previous message's
 *      provided createdAt (or fall back to T_old when missing).
 *   5. Forward to LiteLLM /v1/chat/completions, stream the response back
 *      verbatim (SSE).
 *
 * No engine-kind dispatch, no model resolution magic — LiteLLM exposes a
 * single OpenAI-compatible surface.
 */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/index";
import { users } from "../db/schema";
import { authHeaders } from "../lib/litellm";
import {
  routeMessage,
  detectToolIntent,
  EmbeddingServiceError,
} from "../lib/semantic-router";
import { loadRouterConfigForUser } from "./addon-router";
import {
  modelSupportsTools,
  getModelCaps,
} from "../lib/model-policy";
import { buildUpstreamBody } from "../lib/upstream-request";
import { resolveConvContext } from "../lib/chat-context";
import {
  buildSystemPrompt,
  prependTagToContent,
  tagUserMessages,
} from "../lib/prompt-builder";
import type { GuestTokenContext } from "../lib/guest-token";
import {
  isInferenceActive,
  startInference,
} from "../lib/inference-state";
import {
  alwaysOnTools,
  buildSkillsIndex,
  selectToolsForIntent,
  getToolDefs,
  toolsForUser,
} from "../lib/tools";
import { runChatStream } from "../lib/chat-stream";

export type Env = { Variables: { userId: string } };
const chatRoute = new Hono<Env>();

// ── Types from the client ─────────────────────────────────────────────────

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type IncomingMessage = {
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];
  /** ISO-8601 — populated by the frontend for time-tag deltas. Optional;
   *  falls back to T_old when absent. */
  createdAt?: string;
};

export type ChatBody = {
  conversationId?: string;
  messages?: IncomingMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repetition_penalty?: number;
  seed?: number;
  thinking?: boolean;
  reasoning_effort?: string;
  system_prompt?: string;
  /** Stop sequences — generation halts when any of these strings is
   *  emitted. OpenAI-compatible engines (LiteLLM, vLLM, EXO, OdyssAI-X)
   *  all accept either a single string or an array. */
  stop?: string | string[];
};

// ── Code-generation gate (issue #9.2) ─────────────────────────────────────
// A code-GENERATION request ("écris un script X.py", "write a function", a
// ```fence```, or a source-file extension near a code verb) wants the code IN
// THE REPLY — not an fs_write/bash tool call. Eager tool-callers (MiniMax-M3,
// Qwen3) otherwise emit a tool call instead of the code, and the user gets a
// file-write invocation where they asked for a snippet. We strip the FS/exec
// tools for these prompts when agent-mode is OFF (explicit agent mode keeps
// them — the user opted in). This sits AFTER tool selection so it gates both
// the semantic router and the regex fallback. See OdyssAI-X integration report
// §9.2. NB: Unicode-aware boundaries (\p{L}) so the FR "Écris" matches — JS \b
// is ASCII-only and would miss accented verbs.
const CODE_GEN_EXT = /\.(py|js|ts|tsx|jsx|swift|c|cc|cpp|h|hpp|rs|go|java|rb|sh|bash|sql|kt|php|scala|lua|cs)\b/i;
const CODE_GEN_VERB =
  /(?<!\p{L})(write|create|generate|génère|genere|écris|ecris|implement|implémente|implemente|refactor|debug|coder?|fix)(?!\p{L})/giu;
const CODE_GEN_NOUN =
  /(?<!\p{L})(script|function|fonction|class|classe|program|programme|module|cli|snippet|code|method|méthode|endpoint|component|composant)(?!\p{L})/iu;

function isCodeGenRequest(text: string): boolean {
  if (!text) return false;
  if (text.includes("```")) return true;          // prompt ships/asks for code
  if (CODE_GEN_EXT.test(text)) return true;        // names a source file
  // code verb with a code noun within ~40 chars (avoids an incidental
  // "function" far from a "write" — e.g. the Bruit-Blanc JSON's key).
  CODE_GEN_VERB.lastIndex = 0;
  let mm: RegExpExecArray | null;
  while ((mm = CODE_GEN_VERB.exec(text))) {
    const w = text.slice(Math.max(0, mm.index - 40), mm.index + mm[0].length + 40);
    if (CODE_GEN_NOUN.test(w)) return true;
  }
  return false;
}

function toolFnName(t: unknown): string {
  return (t as { function?: { name?: string } })?.function?.name ?? "";
}

// ── Route ────────────────────────────────────────────────────────────────

chatRoute.post("/completions", async (c) => {
  const body = (await c.req.json().catch(() => null)) as ChatBody | null;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "missing_messages" }, 400);
  }
  if (!body.model) {
    return c.json({ error: "missing_model" }, 400);
  }


  const userId = c.get("userId");
  const guest: GuestTokenContext | undefined = c.get("guest");

  // ── Auto-router pre-step ────────────────────────────────────────────────
  // When the client picks "auto", we run the user's last message through
  // the semantic router add-on (small embedding model on the cluster) to
  // choose chat / deep / code → the configured model for that bucket.
  // If the add-on is not configured, we 400 with a clear error rather
  // than silently dispatching to a fallback — the user enabled "auto"
  // expecting routing; pretending isn't help.
  let routedDecision:
    | { from: string; to: string; label: string; score: number; ms: number }
    | null = null;
  if (body.model === "auto") {
    const routerCfg = await loadRouterConfigForUser(userId);
    if (!routerCfg) {
      return c.json(
        {
          error: "auto_router_not_configured",
          detail:
            "The Auto Router add-on is not enabled or not configured. " +
            "Open Settings → Add-ons → Auto Router to set the embeddings URL " +
            "and pick a model per bucket.",
        },
        400,
      );
    }
    // Find the latest user message — that's what we route on. Going further
    // back risks classifying on stale context (the conversation may have
    // pivoted from a deep analysis to "tu te sens comment").
    const lastUser = [...body.messages]
      .reverse()
      .find((m) => m.role === "user");
    if (!lastUser) {
      return c.json({ error: "auto_router_no_user_message" }, 400);
    }
    const userText = typeof lastUser.content === "string"
      ? lastUser.content
      : Array.isArray(lastUser.content)
        ? lastUser.content
            .map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? ""))
            .join("\n")
        : "";
    try {
      const decision = await routeMessage(userText.slice(0, 4000), routerCfg);
      console.log(
        "[chat] auto-router → %s (label=%s score=%.3f) in %dms",
        decision.model,
        decision.label,
        decision.score,
        decision.ms,
      );
      body.model = decision.model;
      routedDecision = {
        from: "auto",
        to: decision.model,
        label: decision.label,
        score: decision.score,
        ms: decision.ms,
      };
    } catch (e) {
      // Embedding service down → fail loud. Better than silently picking
      // a wrong model the user can't see.
      const msg =
        e instanceof EmbeddingServiceError
          ? e.message
          : `auto_router_failed: ${(e as Error).message}`;
      return c.json(
        { error: "auto_router_unavailable", detail: msg },
        503,
      );
    }
  }

  // Guest budget pre-check — short-circuit before we stream anything.
  // tokenBudget = 0 means unlimited.
  if (guest && guest.tokenBudget > 0 && guest.tokensUsed >= guest.tokenBudget) {
    return c.json({ error: "guest_budget_exceeded" }, 429);
  }

  // (Prewarm uses /api/conversations/:id/prewarm, not this route. That
  // path composes the same prefix without any persistence side effects.)

  // ── 1. Atomic last-interaction swap ────────────────────────────────────
  // SELECT … FOR UPDATE locks the user row for the duration of the tx.
  // Concurrent chat requests from the same user serialize through this gate,
  // so each gets the immediately-prior interaction time as its delta basis.
  const now = new Date();
  const userRow = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        timezone: users.timezone,
        lastInteractionAt: users.lastInteractionAt,
        litellmUrl: users.litellmUrl,
        litellmApiKey: users.litellmApiKey,
        engineUrl: users.engineUrl,
        engineToken: users.engineToken,
        engineMode: users.engineMode,
        litellmDisabled: users.litellmDisabled,
        debugVerbose: users.debugVerbose,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!row) throw new Error("user_not_found");
    await tx
      .update(users)
      .set({ lastInteractionAt: now })
      .where(eq(users.id, userId));
    return row;
  });

  // ── 2. Resolve target per provider mode.
  //   gateway  → engine_url directly. LiteLLM bypassed entirely.
  //              Crew token (engine_token) on every request.
  //   hybrid   → LiteLLM for inference, engine only used for caps merge.
  //   legacy   → LiteLLM only. If litellm_disabled, we 503 — the user
  //              turned off the only rail and didn't pair an engine.
  //
  const effectiveMode: "gateway" | "hybrid" | "legacy" =
    userRow.litellmDisabled && userRow.engineUrl
      ? "gateway"
      : ((userRow.engineMode ?? "legacy") as
          | "gateway"
          | "hybrid"
          | "legacy");

  if (effectiveMode === "legacy" && userRow.litellmDisabled) {
    return c.json(
      {
        error: "no_provider",
        detail:
          "LiteLLM is disabled and no Odyssai engine is paired. Join the Odyssai or re-enable LiteLLM.",
      },
      503,
    );
  }

  let target =
    effectiveMode === "gateway" && userRow.engineUrl
      ? {
          baseUrl: userRow.engineUrl.replace(/\/+$/, ""),
          apiKey: userRow.engineToken,
        }
      : {
          baseUrl: (
            userRow.litellmUrl ??
            process.env.LITELLM_URL ??
            ""
          ).replace(/\/+$/, ""),
          apiKey: userRow.litellmApiKey ?? process.env.LITELLM_API_KEY ?? null,
        };

  // ── 3. Resolve project + memory snapshot (frozen per-conversation) ────
  // The memory wiki is snapshot at conversation creation (or on explicit
  // "Remember now") and reused as-is on every turn. This keeps the system-
  // prompt prefix byte-stable across turns so EXO's KV prefix cache hits,
  // and prevents the model's "memory" from drifting mid-conversation.
  // For pre-snapshot conversations (created before this feature), we lazily
  // backfill the snapshot on first chat so the same stability kicks in from
  // turn 2 onwards.
  const {
    projectCwd, memoryBlock, ragBlock, convKind,
    projectGlobalReadOnly, projectDedicatedMemoryEnabled, convMemoryEnabled,
    convAgentMode,
  } = await resolveConvContext(userId, body);

  // ── 3a. Inference-state buffer — open the server-side stream record so
  // the user can navigate away / refresh / open the same conv from another
  // tab and still get the live content via /api/conversations/:id/inference.
  // No-op when there's no conversationId (rare — the frontend always has one).
  if (body.conversationId) {
    // Concurrency guard: never run two inferences for the same conversation
    // at once. The inference-state buffer is keyed by conversationId, so a
    // second startInference would reset it and both pumps would interleave
    // into the same entry → a garbled response + a DUPLICATE persisted
    // assistant row (observed 2026-05-30: a client double-fire produced two
    // spliced assistant messages for one user turn). The UI is single-stream
    // per conversation (the composer's `sending` guard blocks a manual second
    // send), so a concurrent second request is always a double-fire race.
    // No-op it: close this request with an immediate [DONE] — the already
    // in-flight inference produces and persists the single answer.
    if (isInferenceActive(body.conversationId)) {
      console.warn(
        `[chat] concurrent inference for conv ${body.conversationId} — ` +
          "ignoring duplicate request (the in-flight one will answer)",
      );
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      return c.body("data: [DONE]\n\n");
    }
    startInference(body.conversationId, userId);
  }

  // Hermes integration retired 2026-05-19. kind='hermes' rows that
  // remain in the DB (migration 0037 converts them to 'chat' but we
  // stay defensive) are treated as regular chat and routed through
  // the normal gateway/LiteLLM chain. The Hermes Agent CLI on the
  // .50 host remains a standalone tool — Companion just doesn't pipe
  // user conversations to it anymore. (Ketchup on chocolate cake.)

  // ── 4. Inject time tags into user messages ────────────────────────────
  //
  // Every user message is tagged the SAME way regardless of whether it's
  // historical or being sent now. This is the only way the tag of a given
  // message stays byte-identical across turns — once it's tagged at turn
  // T (when it's the latest), turn T+1 sees it as historical and must
  // reconstruct the same tag.
  //
  // Rules (apply identically to latest + historical):
  //   stamp    = m.createdAt (frontend always provides it for user msgs)
  //   previous = previous user message's createdAt within this payload
  //              (= lastUserAt at the moment we encounter this msg)
  //
  // Nothing depends on the volatile `userRow.lastInteractionAt` anymore:
  // including it would cause the latest msg's tag at turn T to differ
  // from its historical re-rendering at turn T+1.
  //
  // Gating on memory: temporal tags are useful only when the model has
  // memory of past interactions to anchor them against. With memory OFF,
  // `[2026-05-17T08:52:20+02:00 | Δ: 4m]` is just noise that reasoning
  // models will spend cycles trying to justify (cf. Hy3, Hunyuan, Qwen3
  // in thinking mode). So when memory is disabled for this conversation,
  // we skip tagging entirely — pure user content goes to the model.
  // Time tags + system composition routed through the shared
  // prompt-builder so prewarm (conversations.ts) and chat stay byte-
  // identical. The byte-stability invariant is what makes the upstream
  // KV prefix cache actually hit on the second turn.
  const tz = userRow.timezone || "Europe/Brussels";
  const taggedMessages = tagUserMessages(body.messages, {
    enabled: convMemoryEnabled,
    timezone: tz,
    nowFallback: now,
  });
  const skillsIndex = await buildSkillsIndex(userId);
  const composedSystem = buildSystemPrompt({
    userSystemPrompt: body.system_prompt,
    // Today chat.ts already collapsed project + global into a single
    // memoryBlock above (joined with the same separator). Pass it as
    // projectMemory so the builder doesn't double-join — globalMemory
    // stays empty in this code path.
    projectMemory: memoryBlock,
    globalMemory: null,
    skillsIndex,
  });

  // #30 — attach the per-turn RAG block to the LAST user message of the
  // OUTGOING copy (taggedMessages entries are fresh objects). The client
  // and the DB never see it, so the persisted history stays byte-stable
  // and the upstream KV prefix (system + full history) survives every
  // turn; only the previous exchange + this block re-prefill.
  let upstreamMessages = taggedMessages;
  if (ragBlock) {
    let lastUserIdx = -1;
    for (let i = taggedMessages.length - 1; i >= 0; i--) {
      if (taggedMessages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx >= 0) {
      upstreamMessages = taggedMessages.slice();
      const m = upstreamMessages[lastUserIdx];
      upstreamMessages[lastUserIdx] = {
        ...m,
        content: prependTagToContent(
          m.content,
          `${ragBlock}\n\n---\n`,
        ),
      };
    }
  }

  const withSystem =
    composedSystem.length > 0
      ? [
          { role: "system" as const, content: composedSystem },
          ...upstreamMessages,
        ]
      : upstreamMessages;

  // ── 6. Build upstream body (without `messages` — set per iteration below)
  const baseBody = buildUpstreamBody(body);

  // Tool add-ons: when enabled (and the model is tool-capable), the chat
  // route forwards tools so the model can decide when to call them. Each
  // add-on contributes its own tools — see toolsForUser.
  //
  // exo's MLX runner currently aborts (SIGABRT) when handed a `tools:`
  // param even for tool-trained models, so we whitelist by model name.
  // Tool gating: resolve tools whenever the model supports the OpenAI
  // tools field. toolsForUser() reads from every source (fs_*, RAG,
  // web search, MCP servers, …) and returns an empty array when
  // nothing is enabled — so the call is cheap when there's nothing
  // to expose.
  // Pull the model's Odyssai capability snapshot once — we need
  // supports_tools (gating tool resolution) AND backend/pool (gating
  // the stream vs. non-stream upstream decision below).
  const modelCaps = await getModelCaps(
    userRow.engineUrl,
    userRow.engineToken,
    body.model,
  );
  const supportsTools = modelCaps
    ? modelCaps.supports_tools !== false
    : modelSupportsTools(body.model);
  // Tools are gated on per-conv `agentMode`. Default is OFF — a normal
  // chat does NOT inject any FS/RAG/Web/MCP tool defs (~250 tok prompt
  // instead of 1000+). The "always-on" tools (skill_*) used to be
  // injected on every chat so the user could ask the assistant to
  // curate skills from any conversation, but in practice models like
  // MiniMax / Qwen3.5 see the tools on a bare "hello" and loop on
  // skill_list → skill_get → … until Companion bails out (chat.ts:910)
  // with the "kept asking to call tools" fallback. Gate them on
  // `agentMode` too unless the operator explicitly opts in via env.
  const isGuest = !!guest;
  // Guests are scoped to chat only — no tools regardless of agent-mode or
  // ALWAYS_ON_TOOLS. executeTool runs with userId = inviting admin, so
  // exposing tools would let a guest drive skill/fs/mcp ops as the admin.
  const alwaysOnEnabled = !isGuest && supportsTools &&
    (convAgentMode || process.env.ALWAYS_ON_TOOLS === "1");
  const alwaysOn = alwaysOnEnabled ? alwaysOnTools() : [];

  // ── Automatic tool routing ───────────────────────────────────────────
  // Detect which tools the user's last message needs WITHOUT requiring the
  // agent-mode toggle. selectToolsForIntent() pattern-matches the message
  // and returns only the relevant tool definitions (~50–100 tokens each)
  // instead of injecting ALL tools (~1000+ tokens). This runs in <1ms.
  //
  // Three tiers:
  //   1. convAgentMode ON → inject all tools (full agent mode, user explicit)
  //   2. intent detected → inject only the detected tools (auto, no toggle)
  //   3. neither         → no tools (pure chat, ~250 tok saving)
  //
  // Tier 2 detection is two-stage:
  //   a. Semantic — if the router add-on is configured, embed the message
  //      and compare against per-tool centroids (language-agnostic, robust).
  //   b. Pattern — regex fallback when the router isn't configured. English-
  //      biased, brittle on FR phrasing, but free (no embed call).
  const lastMsg = body.messages?.filter((m: {role:string}) => m.role === "user").at(-1);
  const lastMsgText = typeof lastMsg?.content === "string" ? lastMsg.content : "";

  let agentTools: unknown[];
  if (!isGuest && supportsTools) {
    if (convAgentMode) {
      // Full agent mode — all tools
      agentTools = await toolsForUser(userId);
    } else {
      // Auto-detect — semantic first, regex fallback.
      let detected: unknown[] | null = null;
      try {
        const routerCfg = await loadRouterConfigForUser(userId);
        if (routerCfg?.embeddingsUrl && lastMsgText.trim()) {
          const intent = await detectToolIntent(lastMsgText.slice(0, 2000), routerCfg);
          if (intent.tools.length > 0) {
            detected = getToolDefs(intent.tools);
            console.log(
              "[chat] semantic tool intent → %s (%dms)",
              intent.tools.join(","),
              intent.ms,
            );
          } else {
            detected = []; // semantic ran, found nothing → trust it, no tools
          }
        }
      } catch (e) {
        console.warn("[chat] semantic tool detection failed, regex fallback:", (e as Error).message);
        detected = null; // fall through to regex
      }
      agentTools = detected ?? selectToolsForIntent(lastMsgText) ?? [];
    }
  } else {
    agentTools = [];
  }

  // §9.2: a code-GENERATION request wants the code in the reply, not an
  // fs_write/bash tool call. Strip FS/exec tools for code-gen prompts when
  // agent-mode is OFF (gates both the semantic router and the regex fallback).
  if (!convAgentMode && agentTools.length > 0 && isCodeGenRequest(lastMsgText)) {
    const before = agentTools.length;
    agentTools = agentTools.filter((t) => {
      const n = toolFnName(t);
      return !n.startsWith("fs_") && n !== "bash";
    });
    if (agentTools.length !== before) {
      console.log(
        "[chat] code-gen request → stripped %d FS/exec tool(s)",
        before - agentTools.length,
      );
    }
  }

  const tools = [...alwaysOn, ...agentTools];
  const toolsEnabled = tools.length > 0;
  // `agentToolsEnabled` = real agent-mode tools (FS/RAG/Web/MCP) — the
  // ones that trigger the XML tool-call leak on Qwen3/Hy3 streaming.
  // Skill tools alone don't warrant forcing non-stream because the model
  // only calls them on explicit user request (rare, not mid-response).
  // Without this distinction, every chat would non-stream on jaccl,
  // which kills TTFT on slow models like GLM-5.1 4-node.
  const agentToolsEnabled = agentTools.length > 0;

  // Probe routing — gateway mode only. If this request looks like a
  // probe (small max_tokens, no tools), route it to OdyssAI-X' `probe`
  // alias (Qwen2.5-Coder-1.5B on the autocomplete host) instead of letting it hit
  // Argo / Hades 3-node MLX which is wildly overprovisioned for 1-20
  // tokens of output. ~4× faster, frees the heavy cluster for real
  // responses. See BRIEF-companion-prefix-cache-and-probes.md.
  //
  // Skipped for hybrid/legacy modes (the `probe` alias is published
  // by OdyssAI-X only — LiteLLM won't know it). Probe routing tolerates
  // the always-on skill tools in the request (the probe model just
  // ignores them); only real agent-mode tools disqualify probe routing.
  if (
    effectiveMode === "gateway" &&
    !agentToolsEnabled &&
    typeof baseBody.max_tokens === "number" &&
    baseBody.max_tokens <= 20 &&
    body.model !== "probe"
  ) {
    console.log(
      "[chat] routing probe → 'probe' (max_tokens=%d, original=%s)",
      baseBody.max_tokens,
      body.model,
    );
    baseBody.model = "probe";
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...authHeaders(target),
  };

  // ── 7. Stream with a heartbeat keep-alive ──────────────────────────────
  //
  // Why: when a local model (e.g. GLM-5.1) is cold, exo can take 60–90s to
  // load it. During that time, LiteLLM's fetch() blocks waiting for the
  // first response byte, and our backend blocks waiting for LiteLLM. If we
  // sat at `await fetch(...)` and only wrote to the response when it
  // resolved, Cloudflare's 100s "time to first byte" cap would kill the
  // connection with a 524 long before the model warmed up.
  //
  // So we open the SSE response immediately, emit a `:keepalive` comment
  // every 25s while we wait, fire the upstream fetch in the background,
  // and pipe the upstream body into our stream when it arrives. The
  // browser-side parser ignores SSE comment lines (anything starting with
  // `:`), so the heartbeats are invisible to the UI.

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  // Safe wrapper around writer.write — never throws even if the downstream
  // client disconnected mid-stream. This matters for the MCP `send_message`
  // tool: it cancels its reader after headers arrive (so the tool call
  // returns fast), but the server-side worker MUST keep going to consume
  // the upstream SSE, persist the assistant message, trigger memory
  // compile, etc. Without this wrapper, the first `await writer.write` on
  // the dead socket throws → outer try/catch fires "[chat] upstream pipe
  // failed" → finishInference never runs → message is lost.
  const safeWrite = (data: Uint8Array) =>
    writer.write(data).catch(() => undefined);

  // Push one heartbeat immediately so the first byte hits the wire asap.
  safeWrite(encoder.encode(":keepalive\n\n"));
  const heartbeat: ReturnType<typeof setInterval> = setInterval(() => {
    safeWrite(encoder.encode(":keepalive\n\n"));
  }, 25_000);

  void runChatStream({
    writer,
    encoder,
    safeWrite,
    heartbeat,
    withSystem,
    baseBody,
    tools,
    toolsEnabled,
    agentToolsEnabled,
    modelCaps,
    target,
    headers,
    userId,
    projectCwd,
    body,
    userRow,
    guest,
    routedDecision,
    convKind,
    convMemoryEnabled,
    projectGlobalReadOnly,
    projectDedicatedMemoryEnabled,
    c,
  });

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no");
  return c.body(readable);
});

// ── Helpers ──────────────────────────────────────────────────────────────
// `prependTagToContent` moved to ../lib/prompt-builder; chat.ts now calls
// it via the unified `tagUserMessages()` wrapper. Don't re-add here —
// the audit explicitly warned that two copies will inevitably drift.

// ── Tool-call streaming infrastructure ─────────────────────────────────────

/** A row in the OpenAI-shaped messages array. We don't have to be strict —
 *  LiteLLM forwards extra fields like tool_calls or tool_call_id to its
 *  model adapters. */
export type ChatTurn =
  | IncomingMessage
  | {
      role: "assistant";
      content: string | ContentPart[] | null;
      tool_calls: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

// model-policy helpers (modelSupportsTools / getModelCaps / resolveModelLabel
// / maxTokensCap) extracted to ../lib/model-policy.ts — see issue #16.

export default chatRoute;
