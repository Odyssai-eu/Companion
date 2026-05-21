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
// Both `fetch` and `Agent` must come from the SAME undici instance — Node's
// built-in `fetch` uses its internal undici (different version), whose
// Dispatcher interface (onRequestStart, …) doesn't match the userland
// `undici@8.x` package. Passing one's Agent to the other's fetch throws
// `UND_ERR_INVALID_ARG: invalid onRequestStart method`. The fix is to use
// undici's own fetch with undici's own Agent.
import { Agent, fetch as undiciFetch } from "undici";
import { db } from "../db/index";
import { conversations, messages, projects, users } from "../db/schema";
import { logAuthEvent, reqMeta } from "../lib/auth-log";
import { incrementGuestUsage } from "../lib/guest-token";
import { authHeaders } from "../lib/litellm";
import {
  routeMessage,
  EmbeddingServiceError,
} from "../lib/semantic-router";
import { loadRouterConfigForUser } from "./addon-router";
import { getMemoryContext } from "../lib/memory";
import { registerInactivityCompile } from "../lib/memory-scheduler";
import { fetchEngineCapabilities } from "../lib/odyssai-capabilities";
import { getProjectMemoryContext } from "../lib/project-memory";
import {
  buildSystemPrompt,
  tagUserMessages,
} from "../lib/prompt-builder";
import type { GuestTokenContext } from "../lib/guest-token";
import {
  appendInferenceContent,
  deleteInference,
  finishInference,
  markInferenceError,
  recordInferenceUsage,
  startInference,
} from "../lib/inference-state";
import {
  alwaysOnTools,
  buildSkillsIndex,
  executeTool,
  toolsForUser,
  type ToolResult,
} from "../lib/tools";

type Env = { Variables: { userId: string } };
const chatRoute = new Hono<Env>();

// Dedicated undici Agent for upstream LLM calls. Node's default global
// dispatcher has `bodyTimeout: 300_000` (5 min) which is too short for big
// prefills — observed symptom: Hy3-preview on Argo with a ~30k token wiki
// injection times out mid-prefill, undici aborts the socket with
// UND_ERR_BODY_TIMEOUT, finishInference never runs, and the client sees
// a "ghost answer" (the partial response disappears on reload because
// nothing got persisted to the DB).
//
// We disable bodyTimeout entirely (0 = no timeout). headersTimeout was
// 60s but that's too tight for the tools+jaccl path: `shouldUseNonStream`
// forces `stream: false` to avoid the XML tool-call leak on Qwen3/Hy3,
// and Odysseus then doesn't send any HTTP headers until the entire
// response is generated. On slow models (GLM-5.1 on 4-node pipeline-AP
// at ~7 tok/s with max_tokens 64k) that's >> 60s before first byte and
// undici fails the fetch with HeadersTimeoutError before generation
// completes. Bump to 600s (10 min) — generous for non-stream paths,
// invisible for streaming paths which see their first byte in <5s
// regardless. The chat route's heartbeat + finishInference cleanup
// still catches genuine dead connections.
const upstreamDispatcher = new Agent({
  connect: { timeout: 10_000 },   // 10s to TCP+TLS connect
  headersTimeout: 600_000,         // 10 min — generous for non-stream slow models
  bodyTimeout: 0,                  // unbounded body — long prefills OK
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

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

type ChatBody = {
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
   *  emitted. OpenAI-compatible engines (LiteLLM, vLLM, EXO, Odysseus)
   *  all accept either a single string or an array. */
  stop?: string | string[];
};

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
  let projectId: string | null = null;
  let memoryBlock = "";
  let convKind: "chat" | "talk" = "chat";
  // Project-level memory toggles. When the conv belongs to a project,
  // we pull these from `projects` and use them to gate global-wiki
  // injection AND the inactivity-compile registration.
  let projectGlobalReadOnly = false;
  let projectDedicatedMemoryEnabled = false;
  let convMemoryEnabled = true;
  // Per-conversation agent mode. False by default → no tool defs injected,
  // streaming works on jaccl, ~250-token prompts. User flips on per-conv
  // when they want agentic behaviour (fs / rag / web / mcp).
  let convAgentMode = false;
  if (body.conversationId) {
    try {
      const [conv] = await db
        .select({
          projectId: conversations.projectId,
          userId: conversations.userId,
          memorySnapshot: conversations.memorySnapshot,
          memoryEnabled: conversations.memoryEnabled,
          agentMode: conversations.agentMode,
          kind: conversations.kind,
        })
        .from(conversations)
        .where(eq(conversations.id, body.conversationId))
        .limit(1);
      if (conv && conv.userId === userId) {
        projectId = conv.projectId;
        // Defensive: legacy rows with kind='hermes' are treated as
        // regular 'chat' now that the Hermes integration is retired.
        // Migration 0037 normalises the column, but we coerce here in
        // case a stale row slips through.
        convKind = conv.kind === "talk" ? "talk" : "chat";
        convMemoryEnabled = conv.memoryEnabled !== false;
        convAgentMode = conv.agentMode === true;

        // Two-toggle composition (simplified layout):
        //   memoryEnabled            = "Global wiki" toggle. Conv-level
        //                              switch on whether the global user
        //                              wiki is injected at all.
        //   projects.dedicatedMemoryEnabled
        //                            = "Project wiki" toggle (project-level).
        //   projects.globalMemoryReadOnly
        //                            = Read-only sub-toggle under Global.
        //                              Only meaningful when global is on.
        //
        // The two main flags compose independently — you can have one,
        // both, or neither. The previous version coupled them ("project
        // ON disables global unless read-only ON"); the new model treats
        // them as orthogonal so the UI radio collapses cleanly into two
        // checkboxes.
        let dedicated = false;
        let globalReadOnly = false;
        if (projectId) {
          const [proj] = await db
            .select({
              dedicatedMemoryEnabled: projects.dedicatedMemoryEnabled,
              globalMemoryReadOnly: projects.globalMemoryReadOnly,
            })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1);
          if (proj) {
            dedicated = proj.dedicatedMemoryEnabled;
            globalReadOnly = proj.globalMemoryReadOnly;
            projectGlobalReadOnly = globalReadOnly;
            projectDedicatedMemoryEnabled = dedicated;
          }
        }

        // Project corpus — live every turn. Recompute on change so newly
        // imported / edited files surface immediately. Prefix stability
        // (KV cache) holds as long as no files changed.
        const projectMemory =
          projectId && dedicated
            ? await getProjectMemoryContext(projectId)
            : "";

        // Global wiki (Karpathy-style compiled articles from PG, served by
        // thecompai-memory at :8001/context/{userId}). This is the "what
        // do I remember about you" store, auto-maintained by the LLM
        // compiler after each assistant turn. NOT the Obsidian vault and
        // NOT the RAG/Qdrant index — those serve different purposes:
        //   - Karpathy wiki (here)   = stable personal context for prompts
        //   - rag_search tool        = encyclopedia lookups when the model
        //                              needs reference docs (vLLM, etc.)
        //   - Obsidian vault index   = available via the tool when curated
        //
        // Injected at SYSTEM-prompt level (stable across turns → KV cache
        // hits hold). We don't re-fetch per-turn because the wiki only
        // changes when the compiler runs, not when the user asks something.
        let globalBlock = "";
        if (convMemoryEnabled) {
          globalBlock = await getMemoryContext(userId, projectId);
        }
        memoryBlock = [projectMemory, globalBlock]
          .filter((s) => s.trim().length > 0)
          .join("\n\n---\n\n");
      }
    } catch (err) {
      console.warn("[chat] memory lookup failed:", (err as Error).message);
    }
  }

  // ── 3a. Inference-state buffer — open the server-side stream record so
  // the user can navigate away / refresh / open the same conv from another
  // tab and still get the live content via /api/conversations/:id/inference.
  // No-op when there's no conversationId (rare — the frontend always has one).
  if (body.conversationId) {
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

  const withSystem =
    composedSystem.length > 0
      ? [
          { role: "system" as const, content: composedSystem },
          ...taggedMessages,
        ]
      : taggedMessages;

  // ── 6. Build upstream body (without `messages` — set per iteration below)
  const baseBody: Record<string, unknown> = {
    model: body.model,
    stream: true,
  };
  for (const k of [
    "temperature",
    "max_tokens",
    "top_p",
    "top_k",
    "min_p",
    "repetition_penalty",
    "seed",
    "stop",
  ] as const) {
    const v = body[k];
    if (v !== undefined) baseBody[k] = v;
  }
  // Always be explicit about thinking. Previously we only set this when
  // body.thinking was true — that left the upstream provider to apply its
  // own default, which is OFF for our local mlx-lm runners (THINKING_DEFAULT
  // = false) but ON for Inferencer's API. The proxy translates
  // `enable_thinking: false` → `thinking: false` for Inferencer-style
  // providers, so we get consistent behaviour either way.
  baseBody.enable_thinking = body.thinking === true;
  if (body.thinking && body.reasoning_effort)
    baseBody.reasoning_effort = body.reasoning_effort;

  // Prefix-cache key for Odysseus (gateway mode). Odysseus reads
  // `session_id` from the body (or X-Session-Id header) and reuses the
  // KV cache across turns when prompts share a prefix. Using the
  // conversation id is exactly right: every turn of a conv shares the
  // system prompt + memory snapshot + prior messages, so the cache hit
  // rate is high. Hybrid/legacy paths through LiteLLM also tolerate
  // unknown body fields (they're ignored), so we send unconditionally
  // when conversationId is present.
  if (body.conversationId) {
    baseBody.session_id = body.conversationId;
  }

  // Anthropic API rejects requests that set both `temperature` and `top_p`.
  // We always honour temperature and drop top_p for any model that LiteLLM
  // routes to Anthropic (anthropic/* alias or claude-* default name).
  const looksAnthropic =
    /^anthropic\//i.test(body.model) || /^claude[-_]/i.test(body.model);
  if (looksAnthropic && "top_p" in baseBody && "temperature" in baseBody) {
    delete baseBody.top_p;
  }


  // Clamp max_tokens to the provider's published ceiling so we don't get
  // 400s from the upstream. Local models served by exo/Inferencer don't
  // need a clamp — they use whatever they accept and bail gracefully.
  if (typeof baseBody.max_tokens === "number") {
    const cap = maxTokensCap(body.model);
    if (cap !== null && baseBody.max_tokens > cap) {
      console.warn(
        "[chat] clamping max_tokens %d → %d for model %s",
        baseBody.max_tokens,
        cap,
        body.model,
      );
      baseBody.max_tokens = cap;
    }
  }

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
  // instead of 1000+). But "always-on" tools (skill_*) are always
  // injected so the user can ask the assistant to curate skills from
  // any chat.
  const alwaysOn = supportsTools ? alwaysOnTools() : [];
  const agentTools = supportsTools && convAgentMode
    ? await toolsForUser(userId)
    : [];
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
  // probe (small max_tokens, no tools), route it to Odysseus' `probe`
  // alias (Qwen2.5-Coder-1.5B on the autocomplete host) instead of letting it hit
  // Argo / Hades 3-node MLX which is wildly overprovisioned for 1-20
  // tokens of output. ~4× faster, frees the heavy cluster for real
  // responses. See BRIEF-companion-prefix-cache-and-probes.md.
  //
  // Skipped for hybrid/legacy modes (the `probe` alias is published
  // by Odysseus only — LiteLLM won't know it). Probe routing tolerates
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

  void (async () => {
    let conversation: ChatTurn[] = withSystem as ChatTurn[];
    const MAX_TOOL_ITERATIONS = 3;
    // Aggregate usage across tool-loop iterations — guests are billed for
    // every upstream call, not just the final one.
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalChunkCount = 0;
    let sawUpstreamUsage = false;

    // Stream/non-stream upstream policy:
    //
    // Most models route through this code path with `stream:true` so the
    // user gets typewriter UX on every token. But local backends (mlx-vlm,
    // Ollama, vLLM, llama.cpp) emit tool_calls correctly only in
    // non-stream mode — in stream they leak the model's native tool-call
    // syntax (e.g. Qwen-XML `<tool_call>...</tool_call>`) into the content
    // delta, and LiteLLM doesn't normalise that. Anthropic and OpenAI
    // handle stream + tools natively.
    //
    // Decision: if tools are enabled AND the model is not Anthropic/OpenAI,
    // we fetch this iteration in non-stream mode and synthesise a single
    // SSE chunk for the client. Subsequent iterations re-evaluate (e.g.
    // the post-tool reply doesn't always need tools).
    const modelLower = (body.model ?? "").toLowerCase();
    /**
     * Decide stream vs. non-stream for the upstream call when tools
     * are enabled. The Odyssai x_odyssai contract tells the truth:
     *
     *   backend=jaccl                            → local distributed MLX
     *                                              (argo, hades, …) — many
     *                                              chat templates leak the
     *                                              model's native tool-call
     *                                              syntax into content when
     *                                              streaming. Non-stream
     *                                              forces an atomic JSON
     *                                              response that the
     *                                              backend's parser can
     *                                              normalise into
     *                                              tool_calls correctly.
     *   backend=http-proxy + pool=openrouter     → cloud, stream OK
     *   backend=http-proxy + other pool          → local mlx-vlm/mlx-coder
     *                                              proxy, same issue as
     *                                              jaccl, force non-stream
     *   backend=null / no caps                   → fall back to the legacy
     *                                              name heuristic
     */
    function shouldUseNonStream(): boolean {
      // Only real agent-mode tools (fs/rag/web/MCP) trigger the XML leak
      // workaround. Skill tools alone stream fine — they're meta-curation,
      // the model doesn't emit them mid-response.
      if (!agentToolsEnabled) return false;
      if (modelCaps) {
        const backend = modelCaps.backend;
        const pool = modelCaps.pool;
        if (backend === "jaccl") return true;
        if (backend === "http-proxy") {
          // Cloud passthrough (OpenRouter) handles stream+tools natively
          if (pool === "openrouter" || pool === "or") return false;
          // Other http-proxy pools are local (mlx-vlm, mlx-coder, …)
          return true;
        }
        // Unknown backend with caps — be conservative, force non-stream
        return true;
      }
      // No caps published — fall back to name heuristic.
      if (modelLower.includes("claude") || modelLower.startsWith("anthropic/")) return false;
      if (modelLower.startsWith("gpt-") || modelLower.startsWith("openai/")) return false;
      return true;
    }

    // Track whether the loop ended via natural break (model produced
    // a final answer or no tools) vs. exhausting MAX_TOOL_ITERATIONS.
    // The latter signals a "tool-call loop" — model keeps emitting
    // tool_calls without ever writing a user-facing summary. We
    // surface a helpful message in that case so the user sees what
    // happened instead of "..." silently disappearing.
    let exitedNaturally = false;
    try {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const useNonStream = shouldUseNonStream();
        const requestBody = {
          ...baseBody,
          stream: !useNonStream,
          messages: conversation,
          ...(toolsEnabled ? { tools, tool_choice: "auto" } : {}),
        };

        // Debug: hash both the conversation prefix AND the actual body
        // sent to EXO. The first reveals our internal prompt drift, the
        // second reveals if any non-message field (params, headers, body
        // ordering, tools schema) is breaking the EXO-side cache key.
        const bodyJson = JSON.stringify(requestBody);
        // Per-user verbose request log. Off by default. Flip via Settings →
        // Inference → Debug. Logs the full upstream body before each POST so
        // we can diagnose tool-call shape, model id resolution, streaming
        // weirdness, etc. Truncated at 8 KiB to keep docker logs sane.
        if (userRow.debugVerbose || process.env.DEBUG_VERBOSE === "1") {
          const preview = bodyJson.length > 8192
            ? bodyJson.slice(0, 8192) + `…[+${bodyJson.length - 8192}B]`
            : bodyJson;
          console.log(
            `[chat:upstream] iter=${iter} target=${target.baseUrl} ` +
            `bytes=${bodyJson.length} body=${preview}`,
          );
        }
        if (process.env.DEBUG_PROMPT_HASH === "1") {
          const { createHash } = await import("node:crypto");
          const parts: string[] = [];
          for (let k = 1; k <= conversation.length; k++) {
            const sub = JSON.stringify(conversation.slice(0, k));
            const h = createHash("sha256")
              .update(sub)
              .digest("hex")
              .slice(0, 10);
            parts.push(`${k}:${conversation[k - 1].role[0]}=${h}`);
          }
          const fullJson = JSON.stringify(conversation);
          const bodyHash = createHash("sha256")
            .update(bodyJson)
            .digest("hex")
            .slice(0, 10);
          // Hash the body without the LAST message — should be byte-stable
          // across consecutive turns of the same conversation.
          const bodyMinusLast = JSON.stringify({
            ...requestBody,
            messages: conversation.slice(0, -1),
          });
          const bodyPrefixHash = createHash("sha256")
            .update(bodyMinusLast)
            .digest("hex")
            .slice(0, 10);
          console.log(
            `[chat:prompt-hash] msgs=${conversation.length} bytes=${fullJson.length} bodyBytes=${bodyJson.length} body=${bodyHash} bodyPrefix=${bodyPrefixHash} ${parts.join(" ")}`,
          );
        }

        const upstream = await undiciFetch(
          `${target.baseUrl}/v1/chat/completions`,
          {
            method: "POST",
            headers,
            body: bodyJson,
            dispatcher: upstreamDispatcher,
          },
        );

        if (!upstream.ok || !upstream.body) {
          const text = await upstream.text().catch(() => "");
          const err = `${upstream.status} ${upstream.statusText}: ${text.slice(0, 200)}`;
          console.error("[chat] upstream not ok:", err);
          await safeWrite(
            encoder.encode(`data: ${JSON.stringify({ error: err })}\n\n`),
          );
          break;
        }

        // undici's fetch returns its own Response type; structurally compatible
        // with the global Response that collectNonStream/pipeAndCollect expect.
        const upstreamResp = upstream as unknown as Response;
        const { toolCalls, finishReason, assistantContent, usage, chunkCount } =
          useNonStream
            ? await collectNonStream(upstreamResp, writer, encoder, body.conversationId)
            : await pipeAndCollect(upstreamResp, writer, encoder, body.conversationId);
        totalChunkCount += chunkCount;
        if (usage) {
          sawUpstreamUsage = true;
          totalPromptTokens += usage.promptTokens;
          totalCompletionTokens += usage.completionTokens;
        }

        if (
          toolsEnabled &&
          finishReason === "tool_calls" &&
          toolCalls.length > 0
        ) {
          // Notify the client visually (the parser ignores `_event` shape).
          await safeWrite(
            encoder.encode(
              `data: ${JSON.stringify({
                _event: "tool_start",
                calls: toolCalls.map((tc) => ({
                  name: tc.name,
                  args: tryParseJson(tc.argumentsRaw),
                })),
              })}\n\n`,
            ),
          );

          // Execute tools in parallel
          const results = await Promise.all(
            toolCalls.map((tc) =>
              executeTool(tc.name, tryParseJson(tc.argumentsRaw), userId),
            ),
          );

          await safeWrite(
            encoder.encode(
              `data: ${JSON.stringify({
                _event: "tool_done",
                calls: toolCalls.map((tc, i) => ({
                  name: tc.name,
                  result: summarizeResult(results[i]),
                })),
              })}\n\n`,
            ),
          );

          // For workspace-mutating fs_* tools, push a file_changed event so
          // the FilesPage hook (useWorkspaceFiles) can refresh in live.
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            const r = results[i];
            if (!r.ok) continue;
            if (tc.name !== "fs_write" && tc.name !== "fs_edit") continue;
            const path = (r.data as { path?: string } | undefined)?.path;
            if (!path) continue;
            await safeWrite(
              encoder.encode(
                `data: ${JSON.stringify({ _event: "file_changed", path })}\n\n`,
              ),
            );
          }

          // Append assistant tool_calls + tool results to history for next iter
          conversation = [
            ...conversation,
            {
              role: "assistant",
              content: assistantContent || null,
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: tc.argumentsRaw,
                },
              })),
            },
            ...toolCalls.map((tc, i) => ({
              role: "tool" as const,
              tool_call_id: tc.id,
              content: stringifyForTool(results[i]),
            })),
          ];
          // Loop again — the model will integrate tool results into a final
          // answer (or call more tools).
          continue;
        }
        // Either no tools requested, or finish_reason !== "tool_calls" → done.
        exitedNaturally = true;
        break;
      }
      // Tool-call loop: the model kept emitting tool_calls without ever
      // producing a final user-facing summary. Observed with Qwen3.6 on
      // mlx-vlm when the second iteration's prompt grows large (tool
      // results stuffed in). Without this fallback the user sees only
      // the model's intro line ("I'll search...") then silence.
      if (!exitedNaturally && body.conversationId) {
        const note =
          "\n\n_(The model kept asking to call tools without writing a final " +
          "answer — likely the result context is too large for it to " +
          "summarize. Try a hosted tool-trained model like `or:claude-haiku`, " +
          "or disable some MCP servers to shrink the context.)_";
        for (let i = 0; i < note.length; i += 32) {
          const piece = note.slice(i, i + 32);
          await safeWrite(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [
                  { index: 0, delta: { content: piece }, finish_reason: null },
                ],
              })}\n\n`,
            ),
          );
          appendInferenceContent(body.conversationId, piece);
        }
        await safeWrite(
          encoder.encode(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          ),
        );
      }
      // End-of-stream marker for the client parser
      await safeWrite(encoder.encode("data: [DONE]\n\n"));

      // Guest accounting — bill the token, log the use. We do this after
      // the stream has fully drained so we have the real usage numbers.
      if (guest) {
        // Fallback: when upstream didn't report `usage` (older EXO, some
        // local engines), use the chunk count as a coarse proxy. Each
        // streamed delta is ~1 token in practice for OpenAI-compat servers.
        const completionTokens = sawUpstreamUsage
          ? totalCompletionTokens
          : totalChunkCount;
        try {
          await incrementGuestUsage(guest.id, completionTokens);
        } catch (err) {
          console.error("[chat] guest usage increment failed:", err);
        }
        const meta = reqMeta(c);
        logAuthEvent({
          userId: guest.createdBy,
          event: "guest.use",
          ip: meta.ip,
          userAgent: meta.userAgent,
          meta: {
            tokenId: guest.id,
            promptTokens: sawUpstreamUsage ? totalPromptTokens : null,
            completionTokens,
            usageReported: sawUpstreamUsage,
          },
        });
      }
    } catch (err) {
      console.error("[chat] upstream pipe failed:", err);
      if (body.conversationId) markInferenceError(body.conversationId, String(err));
      await safeWrite(
        encoder.encode(`data: ${JSON.stringify({ error: String(err) })}\n\n`),
      );
      await safeWrite(encoder.encode("data: [DONE]\n\n"));
    } finally {
      clearInterval(heartbeat);
      try {
        await writer.close();
      } catch {
        // already closed
      }
      // Mark the inference-state buffer done. The persist callback is the
      // single source of assistant-message DB writes from now on — the
      // client used to call api.appendMessage('assistant', …) on stream
      // end, but Phase 2 of the inference-state port moves that here so
      // the message lands even if the client disconnected mid-stream.
      if (body.conversationId) {
        const convIdLocal = body.conversationId;
        // Resolve once before persistence — the cap cache is 60s TTL so this
        // is a Map.get in the steady state. Failure falls back to raw alias.
        const modelLabel = body.model
          ? await resolveModelLabel(
              body.model,
              target?.baseUrl ?? null,
              target?.apiKey ?? null,
            ).catch(() => body.model)
          : body.model;
        await finishInference(convIdLocal, async (content, _reasoning, st) => {
          const stats = sawUpstreamUsage
            ? {
                ttft: st.ttftMs !== null ? `${st.ttftMs}ms` : undefined,
                tokens: st.promptTokens + st.completionTokens,
                promptTokens: st.promptTokens,
                completionTokens: st.completionTokens,
                reasoningTokens: st.reasoningTokens,
                // Cached prompt tokens — 0 = full re-prefill, >0 = upstream
                // (oMLX tiered KV / Anthropic prompt cache) served part of
                // the prefix from cache. Surfaced in the UI as "Cached".
                cachedTokens: st.cachedTokens,
                chunks: totalChunkCount,
                durationMs: st.totalMs,
                speed:
                  st.totalMs && st.completionTokens
                    ? `${((st.completionTokens / st.totalMs) * 1000).toFixed(1)} tok/s`
                    : undefined,
                model: modelLabel,
              }
            : { chunks: totalChunkCount, durationMs: st.totalMs, model: modelLabel };
          // Surface the auto-router decision so the UI can render a chip
          // "via Auto → {model} ({label}, {score})". Stored on the
          // assistant message so it's visible when the chat is reopened.
          const statsWithRouting = routedDecision
            ? { ...stats, routedFrom: "auto", routedLabel: routedDecision.label, routedScore: routedDecision.score, routedMs: routedDecision.ms }
            : stats;
          try {
            await db.insert(messages).values({
              conversationId: convIdLocal,
              role: "assistant",
              content,
              stats: statsWithRouting as Record<string, unknown>,
            });
            await db
              .update(conversations)
              .set({ updatedAt: new Date() })
              .where(eq(conversations.id, convIdLocal));
          } catch (e) {
            console.error(
              "[chat] server-side assistant persist failed:",
              (e as Error).message,
            );
          }
        });
        // Drop the buffer after a grace window so a late-arriving client
        // can still see the final content via /inference. 60s is enough
        // for a tab-switch / page-reload to catch up.
        setTimeout(() => deleteInference(convIdLocal), 60_000);
      }
      // Memory wiki refresh — registered for inactivity-based compile.
      // Was previously a per-turn `triggerCompile` call, which hammered
      // the local Inferencer and contended with chat latency. Now we
      // just mark the conv as a candidate; memory-scheduler fires the
      // compile after MEMORY_INACTIVITY_COMPILE_MS (default 10 min) of
      // quiet, OR via the time-scheduled slots (06/12:30/19).
      // Suppressed when:
      //  - the conv kind isn't 'chat' (Talk handles its own context)
      //  - the conv's memoryEnabled is off
      //  - the conv is a guest session (don't pollute the owner's wiki)
      //  - the project has globalMemoryReadOnly = true (explicit opt-out)
      //  - the project has dedicatedMemoryEnabled = true (writes belong
      //    to the project corpus, not the global wiki)
      if (
        body.conversationId &&
        convKind === "chat" &&
        convMemoryEnabled &&
        !guest &&
        !projectGlobalReadOnly &&
        !projectDedicatedMemoryEnabled
      ) {
        registerInactivityCompile(userId, body.conversationId);
      }
    }
  })();

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
type ChatTurn =
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

type AccumulatedToolCall = {
  id: string;
  name: string;
  /** Tool args stream as JSON string fragments — we accumulate then parse. */
  argumentsRaw: string;
};

/**
 * Read a streaming chat-completions response, forward most chunks to the
 * client verbatim (so content + reasoning stream through naturally), and
 * pull out any tool_calls + finish_reason so the outer loop can react.
 *
 * Filters two kinds of upstream events:
 *   - `data: [DONE]` — we suppress these between iterations (and emit
 *     exactly one at the very end of the conversation).
 *   - tool_calls deltas — we don't strip them from the forwarded stream;
 *     the client parser already ignores fields it doesn't know about, so
 *     they're harmless. We just *also* parse them server-side.
 */
async function pipeAndCollect(
  upstream: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  /** When set, content deltas + usage are mirrored into the in-memory
   *  inference-state buffer so /inference can serve them to disconnected
   *  clients. Skip for routes that don't want the side effect. */
  convId?: string,
): Promise<{
  toolCalls: AccumulatedToolCall[];
  finishReason: string | null;
  assistantContent: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  chunkCount: number;
}> {
  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const tcByIndex = new Map<number, AccumulatedToolCall>();
  let finishReason: string | null = null;
  let assistantContent = "";
  let usage: { promptTokens: number; completionTokens: number } | null = null;
  let chunkCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value, { stream: true });
    buf += chunkText;

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    // Re-emit lines we want the client to see, line by line; suppress [DONE].
    const out: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (t === "data: [DONE]" || t === "data:[DONE]") {
        // suppress — we'll emit our own [DONE] at the very end
        continue;
      }
      out.push(line);

      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            input_tokens?: number;
            output_tokens?: number;
          };
        };
        if (parsed.usage) {
          // mlx-vlm reports usage under input_tokens/output_tokens; LiteLLM
          // forwards both shapes but zeroes the OpenAI-style fields when
          // upstream uses input/output. Read both, prefer non-zero.
          usage = {
            promptTokens:
              parsed.usage.prompt_tokens ||
              parsed.usage.input_tokens ||
              0,
            completionTokens:
              parsed.usage.completion_tokens ||
              parsed.usage.output_tokens ||
              0,
          };
          if (convId) recordInferenceUsage(convId, parsed.usage);
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          assistantContent += choice.delta.content;
          chunkCount += 1;
          if (convId) appendInferenceContent(convId, choice.delta.content);
        }
        if (choice.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = tcByIndex.get(idx) ?? {
              id: "",
              name: "",
              argumentsRaw: "",
            };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments) acc.argumentsRaw += tc.function.arguments;
            tcByIndex.set(idx, acc);
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      } catch {
        // ignore malformed payloads
      }
    }

    if (out.length > 0) {
      // .catch matches the safeWrite pattern in the caller — never throw
      // back into the SSE consumer just because the client disconnected.
      // The upstream must keep being drained so finishInference runs.
      await writer.write(encoder.encode(out.join("\n") + "\n")).catch(() => undefined);
    }
  }

  return {
    toolCalls: Array.from(tcByIndex.values()).filter((tc) => tc.name),
    finishReason,
    assistantContent,
    usage,
    chunkCount,
  };
}

/**
 * Non-stream variant: read the upstream response as a single JSON object
 * (returned when we send `stream: false`), then synthesise SSE chunks for
 * the client so it doesn't need to know whether upstream streamed or not.
 *
 * Used for local model + tools: mlx-vlm/Ollama/vLLM emit native-syntax
 * tool calls (Qwen-XML, etc.) inside content during streaming. LiteLLM
 * only converts those into proper tool_calls JSON when stream is off.
 */
async function collectNonStream(
  upstream: Response,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  encoder: TextEncoder,
  /** Mirror content slices + usage into the inference-state buffer
   *  so the polling endpoint can show progress to reconnecting clients
   *  even while we're typewriter-slicing a non-stream upstream. */
  convId?: string,
): Promise<{
  toolCalls: AccumulatedToolCall[];
  finishReason: string | null;
  assistantContent: string;
  usage: { promptTokens: number; completionTokens: number } | null;
  chunkCount: number;
}> {
  let chunkCountForReturn = 0;
  const text = await upstream.text();
  let parsed: {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    // mlx-vlm reports usage as input_tokens/output_tokens; LiteLLM forwards
    // both shapes (and unfortunately fills prompt_tokens/completion_tokens
    // to 0 when the upstream uses input/output_tokens). Read both.
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      input_tokens?: number;
      output_tokens?: number;
    };
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    // Surface to the client as an error chunk; let the upstream-not-ok
    // path catch the rest of the contract.
    await writer.write(
      encoder.encode(`data: ${JSON.stringify({ error: "invalid_json_from_upstream" })}\n\n`),
    ).catch(() => undefined);
    return { toolCalls: [], finishReason: null, assistantContent: "", usage: null, chunkCount: 0 };
  }

  const choice = parsed.choices?.[0];
  const assistantContent = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason ?? null;
  const rawCalls = choice?.message?.tool_calls ?? [];
  const toolCalls: AccumulatedToolCall[] = rawCalls.map((tc, i) => ({
    id: tc.id ?? `call_${i}`,
    name: tc.function?.name ?? "",
    argumentsRaw: tc.function?.arguments ?? "",
  })).filter((tc) => tc.name);

  // Temporary instrumentation for "réponse évaporée" diagnosis. When
  // the upstream returns no useful content AND no tool calls, log the
  // raw body (truncated) so we can see exactly what came back. Remove
  // once the root cause is identified.
  if (!assistantContent.trim() && toolCalls.length === 0) {
    console.warn(
      "[chat:empty-upstream]",
      JSON.stringify({
        convId: convId ?? null,
        finishReason,
        rawCallsCount: rawCalls.length,
        bodyLen: text.length,
        bodyPreview: text.slice(0, 2000),
      }),
    );
  }

  const usage = parsed.usage
    ? {
        promptTokens:
          parsed.usage.prompt_tokens ||
          parsed.usage.input_tokens ||
          0,
        completionTokens:
          parsed.usage.completion_tokens ||
          parsed.usage.output_tokens ||
          0,
      }
    : null;
  if (convId && parsed.usage) recordInferenceUsage(convId, parsed.usage);

  // Fallback for models that "give up" silently. Observed with
  // Qwen3.6-35B served via mlx-vlm when 20+ tools schemas are passed:
  // the model returns content="" + tool_calls=[] + finish_reason="stop".
  // Without this guard, the SSE stream closes with nothing visible and
  // finishInference skips persist (it requires inf.content truthy), so
  // the user sees the typing dots disappear with no response or error.
  let effectiveContent = assistantContent;
  if (
    !effectiveContent &&
    toolCalls.length === 0 &&
    (finishReason === "stop" || finishReason === null)
  ) {
    effectiveContent =
      "_(The model returned an empty response. This often happens with " +
      "local models when many tools are exposed at once. Try rephrasing, " +
      "disabling some MCP servers, or switching to a hosted model like " +
      "`or:claude-haiku`.)_";
  }
  if (effectiveContent) {
    const SLICE = 32;
    const DELAY_MS = 8;
    let chunkCount = 0;
    for (let i = 0; i < effectiveContent.length; i += SLICE) {
      const piece = effectiveContent.slice(i, i + SLICE);
      const synthChunk = {
        choices: [
          {
            index: 0,
            delta: { content: piece },
            finish_reason: null,
          },
        ],
      };
      await writer.write(
        encoder.encode(`data: ${JSON.stringify(synthChunk)}\n\n`),
      ).catch(() => undefined);
      if (convId) appendInferenceContent(convId, piece);
      chunkCount++;
      // Skip the delay on the last slice — no need to add latency before
      // the finish chunk.
      if (i + SLICE < effectiveContent.length) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }
    // Override the chunkCount returned at the end to reflect what we emitted.
    // (We update via the variable below.)
    // chunkCount usage is captured in the return.
    chunkCountForReturn = chunkCount;
  }
  // Emit a finish chunk so the client parser sees the turn close cleanly.
  const finishChunk = {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason ?? "stop",
      },
    ],
    ...(usage
      ? {
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
          },
        }
      : {}),
  };
  await writer.write(
    encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`),
  ).catch(() => undefined);

  return {
    toolCalls,
    finishReason,
    assistantContent,
    usage,
    chunkCount: chunkCountForReturn,
  };
}

/**
 * Heuristic: does this model accept the OpenAI-style `tools:` parameter
 * without crashing the upstream? Currently:
 *
 *   - Anthropic family (claude-*, anthropic/*) — yes, native tool use.
 *   - OpenAI family (gpt-*, openai/*) — yes, native function calling.
 *   - Anything else served by exo — NO. exo's MLX runner aborts (signal 6)
 *     on `tools:` even for tool-trained models like GLM-5.1.
 *
 * When this returns false, the chat route silently drops the tools param
 * even if the Web Search add-on is enabled, so picking GLM in the model
 * picker doesn't 500 the conversation. The user just doesn't get
 * web_search/web_fetch on that model — they'd switch to claude-* to use it.
 */
/**
 * Heuristic fallback for tools capability when the engine doesn't
 * publish an x_odyssai contract for a given alias (typical of
 * LiteLLM-routed models — Qwen, GLM, MiMo, Kimi, vlm:…, etc.).
 *
 * We flipped from a strict allowlist to a *denylist* because the
 * allowlist excluded every modern open-weights model with tool support
 * (Qwen 2.5/3.x, GLM 4.5+, MiMo, Kimi K2, etc.). The new posture:
 * assume tools are supported, except for the few backends we've
 * empirically seen crash or hang on the OpenAI tools field.
 *
 * Known broken (deny list):
 *   - EXO's MLX runner (model ids served via "exo:") — emits malformed
 *     tool_calls that LiteLLM can't normalize. EXO Direct addon was
 *     removed in v0.2; if anyone re-adds it, gate here.
 */
function modelSupportsTools(model: string): boolean {
  const m = model.toLowerCase();
  if (m.startsWith("exo:") || m.startsWith("exo/")) return false;
  return true;
}

/**
 * Pull the Odyssai capability snapshot for a model — `null` when the
 * engine doesn't publish caps for this id (LiteLLM-only aliases, or
 * the engine is unreachable). The caller falls back to a name
 * heuristic in that case.
 */
async function getModelCaps(
  engineUrl: string | null,
  engineToken: string | null,
  model: string,
): Promise<import("../lib/odyssai-contract").OdyssaiModelCapabilities | null> {
  if (!engineUrl) return null;
  try {
    const caps = await fetchEngineCapabilities(engineUrl, engineToken);
    return caps.get(model.toLowerCase()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the user-facing model label for the StatsRow. When the requested
 * model is a pool alias (e.g. "argo", "hades") and the engine reports a
 * concrete `alias_for` path, expand to "argo — Qwen3.5-122B-A10B-MLX-9bit"
 * so the user knows which actual model served the response.
 *
 * Falls back to the raw model id when:
 *   - no caps available (engine doesn't expose x_odyssai)
 *   - the model is already concrete (alias_for absent)
 *   - the caps lookup fails for any reason
 *
 * Uses the 60s capability cache shared across requests — no extra fetch
 * per chat completion.
 */
async function resolveModelLabel(
  model: string,
  engineUrl: string | null,
  engineToken: string | null,
): Promise<string> {
  const caps = await getModelCaps(engineUrl, engineToken, model);
  const aliasFor = caps?.alias_for;
  if (!aliasFor || aliasFor === model) return model;
  // alias_for is a filesystem path on the engine side (e.g.
  // "/Volumes/models/odysseus/inferencerlabs/Qwen3.5-122B-A10B-MLX-9bit").
  // Extract just the model basename — that's the readable part.
  const concrete = aliasFor.split("/").pop() || aliasFor;
  if (!concrete || concrete === model) return model;
  return `${model} — ${concrete}`;
}

/**
 * Per-provider max_tokens ceiling. Returns null when the model is local
 * (we let exo/Inferencer enforce their own limits). Heuristic on the
 * model id surfaced through LiteLLM:
 *
 *   "claude-haiku"               → Anthropic alias        → 64k
 *   "anthropic/claude-haiku-4-5" → Anthropic passthrough  → 64k
 *   "claude-sonnet"              → Anthropic alias        → 64k
 *   "gpt-4o" / "openai/..."      → OpenAI                 → 16k
 *   anything else                → local                  → no clamp
 */
function maxTokensCap(model: string): number | null {
  const m = model.toLowerCase();
  if (m.startsWith("anthropic/") || m.includes("claude")) return 64_000;
  if (m.startsWith("openai/") || m.startsWith("gpt-")) return 16_384;
  return null;
}

function tryParseJson(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Serialize a tool result so the LLM sees consistent JSON. Truncates very
 *  large bodies (Tavily extract can return huge raw_content) so we don't blow
 *  up the next round-trip's prompt budget. */
function stringifyForTool(r: ToolResult): string {
  if (!r.ok) return JSON.stringify({ error: r.error });
  const json = JSON.stringify(r.data);
  // 24k chars ≈ 6k tokens — generous but bounded.
  return json.length > 24_000 ? json.slice(0, 24_000) + "…[truncated]" : json;
}

/** A short summary of a tool result to display in the UI without blowing up
 *  the SSE stream. The full payload is fed back to the LLM separately. */
function summarizeResult(
  r: ToolResult,
): { ok: boolean; summary: string; sources?: Array<{ title: string; url: string }> } {
  if (!r.ok) return { ok: false, summary: r.error };
  // MCP tools (mcp-as-client) hand back r.data as a plain string —
  // the textual content concatenated from the tool's MCP response.
  // Show its length so the UI has something meaningful, but skip the
  // object-shape branches below (they'd crash with TypeError on `in`).
  if (typeof r.data === "string") {
    const len = r.data.length;
    return {
      ok: true,
      summary: `${len.toLocaleString()} chars`,
    };
  }
  if (!r.data || typeof r.data !== "object") {
    return { ok: true, summary: "" };
  }
  const data = r.data as
    | { results?: Array<{ title: string; url: string }>; query?: string }
    | { url?: string; content?: string };
  // Tavily search
  if ("results" in data && Array.isArray(data.results)) {
    return {
      ok: true,
      summary: `${data.results.length} result${data.results.length === 1 ? "" : "s"}`,
      sources: data.results.slice(0, 5).map((r) => ({
        title: r.title,
        url: r.url,
      })),
    };
  }
  // Tavily extract
  if ("url" in data && data.url) {
    const len = (data as { content?: string }).content?.length ?? 0;
    return {
      ok: true,
      summary: `Fetched ${len.toLocaleString()} chars from ${data.url}`,
      sources: [{ title: data.url, url: data.url }],
    };
  }
  return { ok: true, summary: "done" };
}

export default chatRoute;
