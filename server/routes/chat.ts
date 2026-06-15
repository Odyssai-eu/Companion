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
  detectToolIntent,
  EmbeddingServiceError,
} from "../lib/semantic-router";
import { loadRouterConfigForUser } from "./addon-router";
import { getMemoryContext, nemoQuery } from "../lib/memory";
import { registerInactivityCompile } from "../lib/memory-scheduler";
import {
  modelSupportsTools,
  getModelCaps,
  resolveModelLabel,
  maxTokensCap,
} from "../lib/model-policy";
import { getProjectMemoryContext } from "../lib/project-memory";
import {
  buildSystemPrompt,
  prependTagToContent,
  tagUserMessages,
} from "../lib/prompt-builder";
import type { GuestTokenContext } from "../lib/guest-token";
import {
  appendInferenceContent,
  deleteInference,
  finishInference,
  isInferenceActive,
  markInferenceError,
  startInference,
} from "../lib/inference-state";
import {
  alwaysOnTools,
  buildSkillsIndex,
  executeTool,
  selectToolsForIntent,
  getToolDefs,
  toolsForUser,
} from "../lib/tools";
import { pipeAndCollect, collectNonStream, stringifyForTool, summarizeResult } from "../lib/stream-collector";

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
// and OdyssAI-X then doesn't send any HTTP headers until the entire
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
  let projectId: string | null = null;
  // Working directory for local-agent tool execution. null → companion-local
  // uses its default (~/companion). A project can override it via its picker.
  let projectCwd: string | null = null;
  let memoryBlock = "";
  // Per-turn RAG retrieval (#30). Rides WITH the question at the END of the
  // sequence — never in the system prompt (a per-turn block there invalidates
  // the KV prefix of the whole conversation history: measured 8% cache hit,
  // TTFT 113s on 6.9k tok). Injected into the outgoing copy of the last user
  // message only; never persisted.
  let ragBlock = "";
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
        let projectTeamId: string | null = null;
        if (projectId) {
          const [proj] = await db
            .select({
              dedicatedMemoryEnabled: projects.dedicatedMemoryEnabled,
              globalMemoryReadOnly: projects.globalMemoryReadOnly,
              teamId: projects.teamId,
              workingDir: projects.workingDir,
            })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1);
          if (proj) {
            dedicated = proj.dedicatedMemoryEnabled;
            globalReadOnly = proj.globalMemoryReadOnly;
            projectGlobalReadOnly = globalReadOnly;
            projectDedicatedMemoryEnabled = dedicated;
            projectTeamId = proj.teamId ?? null;
            projectCwd = proj.workingDir ?? null;
          }
        }

        // Project memory is a RAG tier now (collection = projectId in nemo,
        // fed by the project compiler). The raw vault dump below survives
        // only as the cold-start fallback while the collection is empty —
        // see the "## Project memory" marker check after the RAG query.
        let projectMemory = "";

        // Memory split for KV-cache stability (#30):
        //   ragBlock    = per-turn semantic retrieval (user/team/project/
        //                 company tiers) — VARIABLE, goes with the question
        //                 at the end of the sequence, never in system.
        //   memoryBlock = stable-per-conversation fallbacks only (raw
        //                 wiki/vault while the RAG is cold) — cacheable,
        //                 stays in the system prompt.
        let stableFallback = "";
        if (convMemoryEnabled) {
          const lastUserMsg = body.messages
            ?.filter((m: { role: string }) => m.role === "user")
            .at(-1);
          const query =
            typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
          // Tiers fan out in parallel: user + team (team project) + project
          // (dedicated memory) + company.
          ragBlock = await nemoQuery(
            userId, query, projectId, projectTeamId,
            dedicated && projectId ? projectId : null,
          );
          if (!ragBlock) {
            // Cold start (empty index / service down): the raw wiki+vault
            // dump is stable per conversation → safe in the system prompt.
            stableFallback = await getMemoryContext(userId, projectId);
          }
        }
        // Cold-start fallback for the project tier (independent of the
        // conv-level memory toggle, like the old vault injection): until
        // the project's RAG collection has content, inject the raw vault.
        if (projectId && dedicated && !ragBlock.includes("## Project memory")) {
          projectMemory = await getProjectMemoryContext(projectId);
        }
        memoryBlock = [projectMemory, stableFallback]
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
  // reasoning_effort is independent of the thinking toggle — reasoning-first
  // models (Step-3.7) always think; the dial sets how much. Forward whenever
  // the client sent a concrete level so it reaches the engine even with
  // thinking off ("none"/empty → let the engine's per-model default decide).
  if (body.reasoning_effort && body.reasoning_effort !== "none")
    baseBody.reasoning_effort = body.reasoning_effort;

  // Prefix-cache key for OdyssAI-X (gateway mode). OdyssAI-X reads
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

  void (async () => {
    let conversation: ChatTurn[] = withSystem as ChatTurn[];
    // Max upstream calls in the tool loop. History: 3 → 8 (2026-05-29) → 20.
    // In agent mode the model legitimately needs many rounds — with N distinct
    // tools (Hy3 case: 8 different tools) a real workflow can chain well past 8,
    // and capping at 8 cut the model off mid-task with the misleading loop-guard
    // message even though it was working correctly. This is just a cost/latency
    // ceiling now, NOT the loop's safety: the final iteration forces a closing
    // answer (tool_choice:"none" below), so hitting the cap always yields a
    // real synthesis instead of an error.
    const MAX_TOOL_ITERATIONS = 20;
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
    // Most recent real answer text the model produced across the loop. Used to
    // suppress the loop-guard message when the model DID write a reply but the
    // turn still closed on a tool_calls finish_reason (content + trailing
    // tool_call, or a model that ignores tool_choice:"none"). "Il a tout fini
    // mais erreur à la fin" — don't claim "no answer" when there is one.
    let lastAssistantContent = "";
    try {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        const useNonStream = shouldUseNonStream();
        // On the final allowed iteration, forbid further tool calls
        // (tool_choice:"none") so the model MUST write a closing answer from the
        // accumulated results instead of being cut off mid-loop with an error.
        // We keep the `tools` field present (some strict OpenAI-compat backends
        // reject a history containing tool messages when `tools` is absent) and
        // only flip the choice. In agent mode the model can legitimately need
        // many rounds — this guarantees the turn always ends with a real reply.
        const isFinalIteration = iter === MAX_TOOL_ITERATIONS - 1;
        const requestBody = {
          ...baseBody,
          stream: !useNonStream,
          messages: conversation,
          ...(toolsEnabled
            ? { tools, tool_choice: isFinalIteration ? "none" : "auto" }
            : {}),
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
        // Retain the last non-empty reply (don't reset to "" on pure tool turns).
        if (assistantContent && assistantContent.trim()) {
          lastAssistantContent = assistantContent;
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
              executeTool(tc.name, tryParseJson(tc.argumentsRaw), userId, projectCwd),
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
        // Ghost guard: if the turn ends with NO assistant content and no
        // tool calls, finishInference would skip persist (it requires
        // inf.content truthy) → the bubble vanishes on reload. This is the
        // recurring "ghost answer": a thinking model streams only
        // `reasoning_content` (captured above into the reasoning channel)
        // and never emits a `content` delta — e.g. thinking is enabled and
        // the turn closes after the reasoning, or it hits the token cap
        // mid-think. Mirror collectNonStream's fallback: emit a short note
        // so the turn persists with something visible instead of ghosting.
        if (!assistantContent.trim() && body.conversationId) {
          const note =
            "_(No answer was produced. If this model streams its reasoning on "
            + "a separate channel, it may have spent the turn thinking without "
            + "writing a reply — try disabling thinking for this model, or use a "
            + "hosted model like `or:claude-haiku`.)_";
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
      // Suppress when the model DID write a real reply this turn — the message
      // would otherwise contradict an answer the user can plainly see.
      if (!exitedNaturally && !lastAssistantContent.trim() && body.conversationId) {
        const note =
          "\n\nError - The model kept asking to call tools without writing a final answer";
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
                // Decode-only tok/s — completion / (duration - ttft). Matches
                // the throughput numbers model providers advertise (e.g.
                // inferencer announces 5 tok/s for Mistral-Medium-3.5; the
                // raw end-to-end "speed" pulls that down because it counts
                // the prompt-eval phase in the denominator). Both rates
                // shown side-by-side so users can sanity-check vs spec.
                //
                // Only meaningful when there's a genuine decode window. In
                // non-stream mode (the tools path) the whole response lands
                // at once, so ttft ≈ total, the decode window collapses to a
                // few ms, and the rate explodes to a garbage ~1000 tok/s
                // (observed 2026-05-29). Require the decode phase to be a
                // non-trivial slice of total (≥250 ms AND ≥10% of duration)
                // and at least a few tokens before trusting the number;
                // otherwise suppress it (the UI just shows overall speed).
                decodeSpeed: (() => {
                  if (!st.totalMs || st.ttftMs === null || !st.completionTokens) {
                    return undefined;
                  }
                  const decodeMs = st.totalMs - st.ttftMs;
                  if (
                    decodeMs < 250 ||
                    decodeMs < st.totalMs * 0.1 ||
                    st.completionTokens < 5
                  ) {
                    return undefined;
                  }
                  return `${((st.completionTokens / decodeMs) * 1000).toFixed(1)} tok/s`;
                })(),
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
      //  - a custom system prompt is active (persona / fiction / writing
      //    benchmark sessions). Compiling one into the biographical wiki
      //    is exactly how "Le Bruit Blanc" became a lived memory
      //    (2026-06-12) — so the conv is tainted DURABLY: memoryEnabled
      //    flips off in DB (visible as the conv's memory toggle), which
      //    also shields it from the scheduled global slots, not just
      //    from this turn's registration.
      if (body.system_prompt && body.conversationId && convMemoryEnabled) {
        void db
          .update(conversations)
          .set({ memoryEnabled: false })
          .where(eq(conversations.id, body.conversationId))
          .then(() =>
            console.log(
              `[memory] conv ${body.conversationId} memoryEnabled→off (custom system prompt active)`,
            ),
          )
          .catch(() => {});
      } else if (
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

// model-policy helpers (modelSupportsTools / getModelCaps / resolveModelLabel
// / maxTokensCap) extracted to ../lib/model-policy.ts — see issue #16.

function tryParseJson(s: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export default chatRoute;
