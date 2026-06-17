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
import {
  routeMessage,
  EmbeddingServiceError,
} from "../lib/semantic-router";
import { loadRouterConfigForUser } from "./addon-router";
import { resolveChatTools } from "../lib/chat-tools";
import { buildUpstreamBody } from "../lib/upstream-request";
import { resolveConvContext } from "../lib/chat-context";
import { getUserIdentityBlock } from "../lib/memory";
import { assembleMessages } from "../lib/chat-messages";
import type { GuestTokenContext } from "../lib/guest-token";
import {
  isInferenceActive,
  startInference,
} from "../lib/inference-state";
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
        memoryMode: users.memoryMode,
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
  } = await resolveConvContext(
    userId,
    body,
    (userRow.memoryMode === "basic" ? "basic" : "advanced"),
  );

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

  // ── 4/5. Inject time tags + compose system prompt + assemble withSystem.
  // Extracted to ../lib/chat-messages (issue #31) to keep this handler under
  // 400 loc. Byte-for-byte identical to the old inline block — see that file
  // for the full rationale (tagging rules, RAG-block attachment, the
  // byte-stability invariant that lets the upstream KV prefix cache hit).
  // Always-on identity (#profile): computed UNCONDITIONALLY — independent of
  // convMemoryEnabled, the RAG retrieval, and persona/talk kind — so the
  // assistant always knows who it is talking to (regression: with memory OFF
  // or a persona conv, "qui suis-je ?" returned "I can't identify you").
  const identityBlock = await getUserIdentityBlock(userId);
  const { withSystem } = await assembleMessages({ body, userRow, userId, now, convMemoryEnabled, memoryBlock, ragBlock, identityBlock });

  // ── 6. Build upstream body (without `messages` — set per iteration below)
  const baseBody = buildUpstreamBody(body);

  const { modelCaps, tools, toolsEnabled, agentToolsEnabled, headers } = await resolveChatTools({ userRow, body, convAgentMode, guest, userId, effectiveMode, baseBody, target });

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
    memoryBlock,
    ragBlock,
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
