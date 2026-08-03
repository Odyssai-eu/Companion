// v3 processor — THE chat core (PLAN.md V3-a/b, Kimi-approved rd3).
//
// One code path runs a turn for a PRIMARY conversation or a task
// SUB-CONVERSATION: assemble prompt (existing byte-stable stack), guard,
// resolve model (auto→CoeOS / pinned / guard force-local), streamText
// through the provider factory, persist typed PARTS progressively
// (source of truth), publish live frames on the broker, own the durable
// turn_state (single-flight, cancel between parts, done/error/stopped)
// and the turn lifecycle (stats, spans, guest billing, memory trigger).
//
// The old worker's diseases die here by construction: no provider frame
// ever reaches a client; there is exactly ONE decode (the AI SDK's).

import {
  streamText,
  stepCountIs,
  jsonSchema,
  tool as aiTool,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { and, eq, sql as dsql } from "drizzle-orm";
import { db } from "../../db/index";
import {
  conversations,
  messages,
  turnStates,
  users,
} from "../../db/schema";
import { makeProvider, type ExtraBody, type RoutedCapture } from "./provider";
import {
  CONNECTION_COLUMNS,
  effectiveProviderMode,
  providerTarget,
  resolveUserSettings,
} from "../global-settings";
import { resolveConvContext } from "../chat-context";
import { getUserIdentityBlock } from "../memory";
import { buildSystemPrompt, tagUserMessages } from "../prompt-builder";
import { buildSkillsIndex, executeTool, resolveAllowedToolDefs, alwaysOnTools, toolsForUser } from "../tools";
import { buildTaskToolDef, resolveAgentByName } from "../agent-rows";
import { loadGuardConfigForUser } from "../../routes/addon-guard";
import { classifyText, lastUserText } from "../guard";
import { classifyOrigin } from "../model-origin";
import { fetchEngineOrigins } from "../odyssai-capabilities";
import { getModelCaps, modelSupportsTools, maxTokensCap } from "../model-policy";
import { emitLive, emitRunEvent } from "../run-events";
import { recordSpan } from "../agent-spans";
import { incrementGuestUsage, type GuestTokenContext } from "../guest-token";
import { logAuthEvent } from "../auth-log";
import { registerInactivityCompile } from "../memory-scheduler";

export const COEOS_ID = "CoeOS";
const MAX_STEPS_PRIMARY = 20;
const MAX_TASKS_PER_TURN = 3;
const TURN_STEP_BUDGET = 30;
const MAX_DEPTH = 2;

// ── Types ──────────────────────────────────────────────────────────────

export type Part = Record<string, unknown> & { type: string };

export type TurnRequest = {
  userId: string;
  conversationId: string;
  /** Full OpenAI-shaped history from the client (same contract as v1 —
   *  the client persists the user message itself). */
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: string | Array<Record<string, unknown>>;
    createdAt?: string;
  }>;
  model: string;
  params?: {
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
  };
  guest?: GuestTokenContext;
};

export type TurnOutcome = {
  status: "done" | "error" | "stopped" | "guard_blocked";
  messageId?: string;
  text: string;
  error?: string;
  guard?: Record<string, unknown>;
};

type TaskBudget = { tasksStarted: number; stepsUsed: number };

// ── turn_state helpers ─────────────────────────────────────────────────

async function acquireTurn(conversationId: string): Promise<boolean> {
  // Single-flight: one active turn per conversation. Upsert wins only if
  // the existing row is not active.
  const res = await db.execute(dsql`
    INSERT INTO turn_states (conversation_id, status, cancel_requested, started_at, updated_at)
    VALUES (${conversationId}, 'active', false, now(), now())
    ON CONFLICT (conversation_id) DO UPDATE
      SET status = 'active', cancel_requested = false,
          error = NULL, started_at = now(), updated_at = now()
      WHERE turn_states.status <> 'active'
    RETURNING conversation_id`);
  return ((res as unknown as { rowCount?: number }).rowCount ?? 0) > 0;
}

async function settleTurn(
  conversationId: string,
  status: "done" | "error" | "stopped",
  error?: string,
): Promise<void> {
  await db
    .update(turnStates)
    .set({ status, error: error ?? null, updatedAt: new Date() })
    .where(eq(turnStates.conversationId, conversationId))
    .catch(() => {});
}

async function cancelRequested(conversationId: string): Promise<boolean> {
  const [row] = await db
    .select({ c: turnStates.cancelRequested })
    .from(turnStates)
    .where(eq(turnStates.conversationId, conversationId))
    .limit(1);
  return row?.c === true;
}

export async function requestStop(conversationId: string): Promise<void> {
  await db
    .update(turnStates)
    .set({ cancelRequested: true, updatedAt: new Date() })
    .where(
      and(
        eq(turnStates.conversationId, conversationId),
        eq(turnStates.status, "active"),
      ),
    );
}

export async function getTurnState(conversationId: string) {
  const [row] = await db
    .select()
    .from(turnStates)
    .where(eq(turnStates.conversationId, conversationId))
    .limit(1);
  return row ?? null;
}

// ── Message conversion (OpenAI shape → AI SDK ModelMessage) ────────────

function toModelMessages(
  msgs: TurnRequest["messages"],
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of msgs) {
    if (m.role === "system") continue; // system is passed separately
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content } as ModelMessage);
      continue;
    }
    const parts = m.content
      .map((p) => {
        const t = p as { type?: string; text?: string; image_url?: { url?: string } };
        if (t.type === "text") return { type: "text" as const, text: t.text ?? "" };
        if (t.type === "image_url" && t.image_url?.url)
          return { type: "image" as const, image: t.image_url.url };
        return null;
      })
      .filter(Boolean) as Array<{ type: "text"; text: string } | { type: "image"; image: string }>;
    out.push({ role: m.role, content: parts } as ModelMessage);
  }
  return out;
}

// ── Parts persistence ──────────────────────────────────────────────────

class PartsWriter {
  parts: Part[] = [];
  private open: { type: string; text: string } | null = null;
  constructor(
    private messageId: string,
    private conversationId: string,
  ) {}

  /** Append a streaming delta to the currently open text/reasoning part
   *  (creates it if needed). Live frame per delta; DB flush on close. */
  delta(kind: "text" | "reasoning", text: string) {
    if (!this.open || this.open.type !== kind) {
      this.closeOpen();
      this.open = { type: kind, text: "" };
      emitLive(this.conversationId, {
        v3: "part-open",
        messageId: this.messageId,
        part: { type: kind },
      });
    }
    this.open.text += text;
    emitLive(this.conversationId, {
      v3: "part-delta",
      messageId: this.messageId,
      kind,
      text,
    });
  }

  closeOpen() {
    if (!this.open) return;
    if (this.open.text.length > 0) {
      this.parts.push({ type: this.open.type, text: this.open.text });
    }
    this.open = null;
  }

  /** Push a complete (non-delta) part: tool-call, tool-result, step. */
  push(part: Part) {
    this.closeOpen();
    this.parts.push(part);
    emitLive(this.conversationId, {
      v3: "part",
      messageId: this.messageId,
      part,
    });
  }

  textContent(): string {
    return this.parts
      .filter((p) => p.type === "text")
      .map((p) => String(p.text ?? ""))
      .join("");
  }

  async flush(stats?: Record<string, unknown>) {
    this.closeOpen();
    await db
      .update(messages)
      .set({
        parts: this.parts,
        content: this.textContent(),
        ...(stats ? { stats } : {}),
      })
      .where(eq(messages.id, this.messageId));
  }
}

// ── The turn ───────────────────────────────────────────────────────────

export async function runTurnV3(req: TurnRequest): Promise<TurnOutcome> {
  const { userId, conversationId } = req;
  const t0 = Date.now();

  if (!(await acquireTurn(conversationId))) {
    return { status: "error", text: "", error: "turn_already_active" };
  }

  emitLive(conversationId, { v3: "turn", state: "active" });

  let writer: PartsWriter | null = null;
  try {
    // ── Context + prompt (existing, byte-stable) ─────────────────────
    const [userRow] = await db
      .select({ ...CONNECTION_COLUMNS, timezone: users.timezone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!userRow) throw new Error("user_not_found");
    const conn = await resolveUserSettings(userRow as never);
    const mode = effectiveProviderMode(conn);
    let target = providerTarget(conn, mode);

    const body = {
      conversationId,
      messages: req.messages,
      model: req.model,
      system_prompt: req.params?.system_prompt,
    };
    const ctx = await resolveConvContext(
      userId,
      body as never,
      "advanced",
    );

    // ── Model resolution (auto→CoeOS / pinned) ───────────────────────
    let model = req.model;
    let routedLabel: string | null = null;
    if (model === "auto") {
      if (conn.engineUrl) {
        model = COEOS_ID;
        routedLabel = "coeos";
      } else {
        model = conn.defaultModel ?? "";
        routedLabel = "fallback";
        if (!model) throw new Error("no_model");
      }
    }

    // ── Guard (chat surface: block on router origin, force-local on
    //    cloud, banner otherwise — same semantics as v1) ──────────────
    let guardStats: Record<string, unknown> = {};
    const guardCfg = await loadGuardConfigForUser(userId);
    if (guardCfg) {
      const gtext = lastUserText(req.messages as never);
      if (gtext.trim()) {
        const verdict = await classifyText(gtext.slice(0, 8000), guardCfg);
        if (verdict?.sensitive) {
          let origin = classifyOrigin({ id: model });
          if (conn.engineUrl) {
            const origins = await fetchEngineOrigins(conn.engineUrl, conn.engineToken);
            origin = origins.get(model.toLowerCase()) ?? origin;
          }
          if (origin === "router") {
            await settleTurn(conversationId, "done");
            emitLive(conversationId, {
              v3: "turn",
              state: "guard_blocked",
              severity: verdict.maxSeverity,
              findings: verdict.findings,
            });
            logAuthEvent({
              userId,
              event: "guard.blocked",
              meta: { severity: verdict.maxSeverity, model, conversationId },
            });
            return {
              status: "guard_blocked",
              text: "",
              guard: { severity: verdict.maxSeverity, findings: verdict.findings },
            };
          }
          if (origin === "cloud" && guardCfg.action === "force-local" && conn.engineUrl && guardCfg.localModel) {
            model = guardCfg.localModel;
            guardStats = {
              guardFlagged: true,
              guardSeverity: verdict.maxSeverity,
              guardForcedLocal: true,
              guardForcedModel: model,
            };
          } else {
            guardStats = { guardFlagged: true, guardSeverity: verdict.maxSeverity };
          }
        }
      }
    }

    // ── Tools (same gating as v1: agentMode ‖ ALWAYS_ON_TOOLS, guests
    //    excluded; task rides the always-on group) ────────────────────
    const modelCaps = await getModelCaps(conn.engineUrl, conn.engineToken, model);
    const supportsTools = modelCaps
      ? modelCaps.supports_tools !== false
      : model === COEOS_ID || modelSupportsTools(model);
    const toolsOn =
      !req.guest &&
      supportsTools &&
      (ctx.convAgentMode || process.env.ALWAYS_ON_TOOLS === "1");

    const budget: TaskBudget = { tasksStarted: 0, stepsUsed: 0 };
    const aiTools: ToolSet = {};
    if (toolsOn) {
      const defs: unknown[] = [...alwaysOnTools()];
      const taskDef = await buildTaskToolDef(userId);
      if (taskDef) defs.push(taskDef);
      if (ctx.convAgentMode) defs.push(...(await toolsForUser(userId)));
      for (const d of defs) {
        const fn = (d as { function: { name: string; description?: string; parameters?: unknown } }).function;
        if (fn.name === "task") {
          aiTools.task = aiTool({
            description: fn.description ?? "",
            inputSchema: jsonSchema<Record<string, unknown>>(fn.parameters as never),
            execute: async (args: Record<string, unknown>) =>
              runTaskV3({
                userId,
                parentConversationId: conversationId,
                args: args as { subagent?: string; prompt?: string; description?: string },
                target,
                conn,
                budget,
              }),
          });
        } else {
          aiTools[fn.name] = aiTool({
            description: fn.description ?? "",
            inputSchema: jsonSchema<Record<string, unknown>>((fn.parameters ?? { type: "object", properties: {} }) as never),
            execute: async (args: Record<string, unknown>) =>
              executeTool(fn.name, args as never, userId, ctx.projectCwd),
          });
        }
      }
    }

    // ── System + messages (existing byte-stable stack) ───────────────
    const identity = await getUserIdentityBlock(userId, ctx.convMemoryEnabled);
    const skillsIndex = ctx.convAgentMode ? await buildSkillsIndex(userId) : null;
    const system = buildSystemPrompt({
      agentSystemPrompt: ctx.agentPromptSnapshot,
      userSystemPrompt: req.params?.system_prompt,
      identity,
      projectMemory: ctx.memoryBlock,
      globalMemory: null,
      skillsIndex,
    });
    const tagged = tagUserMessages(req.messages as never, {
      enabled: ctx.convMemoryEnabled,
      timezone: conn.timezone || "UTC",
      nowFallback: new Date(),
    }) as TurnRequest["messages"];

    // ── Assistant message row (parts land here) ──────────────────────
    const [assistantRow] = await db
      .insert(messages)
      .values({ conversationId, role: "assistant", content: "", parts: [] })
      .returning({ id: messages.id });
    writer = new PartsWriter(assistantRow.id, conversationId);

    // ── Provider + stream ────────────────────────────────────────────
    const capture: RoutedCapture = { routed: null, responseModel: null };
    const extraBody: ExtraBody = {
      session_id: conversationId,
      enable_thinking: model === COEOS_ID ? true : req.params?.thinking === true,
      ...(req.params?.reasoning_effort && req.params.reasoning_effort !== "none"
        ? { reasoning_effort: req.params.reasoning_effort }
        : {}),
      ...(req.params?.top_k != null ? { top_k: req.params.top_k } : {}),
      ...(req.params?.min_p != null ? { min_p: req.params.min_p } : {}),
      ...(req.params?.repetition_penalty != null
        ? { repetition_penalty: req.params.repetition_penalty }
        : {}),
    };
    const provider = makeProvider({
      baseUrl: target.baseUrl.replace(/\/$/, "") + "/v1",
      apiKey: target.apiKey,
      extraBody,
      capture,
    });

    const cap = maxTokensCap(model);
    const requestedMax = req.params?.max_tokens ?? 32768;
    const abort = new AbortController();

    const result = streamText({
      model: provider(model),
      system: system || undefined,
      messages: toModelMessages(tagged),
      ...(Object.keys(aiTools).length > 0 ? { tools: aiTools } : {}),
      stopWhen: stepCountIs(MAX_STEPS_PRIMARY),
      temperature: req.params?.temperature,
      topP: req.params?.top_p ?? undefined,
      seed: req.params?.seed ?? undefined,
      maxOutputTokens: cap ? Math.min(requestedMax, cap) : requestedMax,
      abortSignal: abort.signal,
    });

    let ttftMs: number | null = null;
    let usage: { inputTokens?: number; outputTokens?: number } = {};
    let stopped = false;

    for await (const part of result.fullStream) {
      if (ttftMs === null && (part.type === "text-delta" || part.type === "reasoning-delta")) {
        ttftMs = Date.now() - t0;
      }
      switch (part.type) {
        case "reasoning-delta":
          writer.delta("reasoning", (part as { text?: string }).text ?? "");
          break;
        case "text-delta":
          writer.delta("text", (part as { text?: string }).text ?? "");
          break;
        case "tool-call": {
          const p = part as { toolName?: string; input?: unknown };
          writer.push({ type: "tool-call", toolName: p.toolName, input: p.input });
          void recordSpan({
            conversationId,
            agent: "nemo",
            type: "tool",
            status: "ok",
            payload: { name: p.toolName },
          });
          break;
        }
        case "tool-result": {
          const p = part as { toolName?: string; output?: unknown };
          const out = p.output as { ok?: boolean } | undefined;
          writer.push({
            type: "tool-result",
            toolName: p.toolName,
            ok: out?.ok !== false,
            output: summarizeOutput(p.output),
          });
          break;
        }
        case "start-step":
          writer.push({ type: "step-start" });
          break;
        case "finish":
          usage = (part as { totalUsage?: typeof usage }).totalUsage ?? {};
          break;
        case "error": {
          const err = (part as { error?: unknown }).error;
          throw new Error(String((err as Error)?.message ?? err));
        }
      }
      // STOP: cancel flag checked between parts — partial parts stay.
      if (await cancelRequested(conversationId)) {
        abort.abort();
        stopped = true;
        break;
      }
    }

    // ── Stats + persist ──────────────────────────────────────────────
    const durationMs = Date.now() - t0;
    const promptTokens = usage.inputTokens ?? 0;
    const completionTokens = usage.outputTokens ?? 0;
    const stats: Record<string, unknown> = {
      model:
        model === COEOS_ID && (capture.routed?.concrete || capture.responseModel)
          ? `CoeOS — ${capture.routed?.concrete ?? capture.responseModel}`
          : model,
      ttft: ttftMs != null ? `${ttftMs}ms` : undefined,
      promptTokens,
      completionTokens,
      tokens: promptTokens + completionTokens,
      durationMs,
      speed:
        completionTokens > 0 && durationMs > 0
          ? `${((completionTokens / durationMs) * 1000).toFixed(1)} tok/s`
          : undefined,
      ...(routedLabel ? { routedFrom: "auto", routedLabel } : {}),
      ...(capture.routed ? { coeosRouted: capture.routed } : {}),
      ...guardStats,
      v3: true,
    };
    await writer.flush(stats);

    void recordSpan({
      conversationId,
      agent: "nemo",
      type: "llm",
      tokensIn: promptTokens,
      tokensOut: completionTokens,
      durationMs,
      status: stopped ? "stopped" : "ok",
      payload: { model, routed: capture.routed },
    });

    // ── Lifecycle (owned by the processor — review rd3) ──────────────
    if (req.guest && (promptTokens || completionTokens)) {
      void incrementGuestUsage(req.guest.id, promptTokens + completionTokens);
      logAuthEvent({
        userId,
        event: "guest.use",
        meta: { conversationId, tokens: promptTokens + completionTokens },
      });
    }
    if (
      ctx.convKind === "chat" &&
      ctx.convMemoryEnabled &&
      !req.guest &&
      !ctx.projectGlobalReadOnly &&
      !ctx.projectDedicatedMemoryEnabled &&
      !req.params?.system_prompt
    ) {
      registerInactivityCompile(userId, conversationId);
    }

    await settleTurn(conversationId, stopped ? "stopped" : "done");
    emitLive(conversationId, { v3: "turn", state: stopped ? "stopped" : "done" });
    return {
      status: stopped ? "stopped" : "done",
      messageId: assistantRow.id,
      text: writer.textContent(),
    };
  } catch (err) {
    const msg = (err as Error).message;
    if (writer) {
      await writer.flush({ v3: true, error: msg }).catch(() => {});
    }
    await settleTurn(conversationId, "error", msg);
    emitLive(conversationId, { v3: "turn", state: "error", error: msg });
    return { status: "error", text: writer?.textContent() ?? "", error: msg };
  }
}

function summarizeOutput(output: unknown): unknown {
  const s = JSON.stringify(output);
  if (s && s.length > 2000) return { truncated: s.slice(0, 2000) };
  return output;
}

// ── Task delegation on the same core ───────────────────────────────────

async function runTaskV3(opts: {
  userId: string;
  parentConversationId: string;
  args: { subagent?: string; prompt?: string; description?: string };
  target: { baseUrl: string; apiKey: string | null };
  conn: { engineUrl: string | null; defaultModel: string | null };
  budget: TaskBudget;
}): Promise<{ ok: boolean; status: string; result?: string; error?: string; sub_conversation_id?: string }> {
  const { userId, parentConversationId, args, budget } = opts;
  const subagent = String(args.subagent ?? "");
  const prompt = String(args.prompt ?? "");
  const description = String(args.description ?? "").slice(0, 120);

  if (budget.tasksStarted >= MAX_TASKS_PER_TURN) {
    return { ok: false, status: "error", error: `Task limit (${MAX_TASKS_PER_TURN}/turn) reached.` };
  }
  const agent = await resolveAgentByName(userId, subagent);
  if (!agent || !agent.enabled || agent.mode !== "subagent") {
    return { ok: false, status: "error", error: `Unknown or disabled subagent '${subagent}'.` };
  }

  // Ownership + depth via parent chain.
  const [parent] = await db
    .select({ id: conversations.id, userId: conversations.userId, parentId: conversations.parentId })
    .from(conversations)
    .where(eq(conversations.id, parentConversationId))
    .limit(1);
  if (!parent || parent.userId !== userId) {
    return { ok: false, status: "error", error: "Parent conversation not found." };
  }
  let depth = 1;
  let cursor = parent.parentId;
  while (cursor && depth <= MAX_DEPTH) {
    depth += 1;
    const [row] = await db
      .select({ parentId: conversations.parentId })
      .from(conversations)
      .where(eq(conversations.id, cursor))
      .limit(1);
    cursor = row?.parentId ?? null;
  }
  if (depth > MAX_DEPTH) {
    return { ok: false, status: "error", error: `Delegation depth cap (${MAX_DEPTH}).` };
  }
  const rootId = parent.parentId ?? parent.id;

  // Guard runtime surface — force-local or fail closed (v2.1 semantics).
  let model = agent.model ?? COEOS_ID;
  try {
    const guardCfg = await loadGuardConfigForUser(userId);
    if (guardCfg) {
      const verdict = await classifyText(prompt.slice(0, 8000), guardCfg);
      if (verdict?.sensitive) {
        const localModel = guardCfg.localModel?.trim() ?? "";
        if (!localModel) {
          return {
            ok: false,
            status: "error",
            error: "Sensitive content and no local model configured (Guard). Content not sent.",
          };
        }
        model = localModel;
      }
    }
  } catch {
    /* fail-soft classification */
  }

  budget.tasksStarted += 1;

  // Spawn sub-conversation + persistent task card in the parent.
  const [subConv] = await db
    .insert(conversations)
    .values({
      userId,
      parentId: parent.id,
      agentName: agent.name,
      title: description || `Task: ${agent.name}`,
      kind: "chat",
      activeAgent: null,
      model,
      memoryEnabled: false,
      agentMode: false,
      agentPromptSnapshot: agent.systemPrompt,
    })
    .returning({ id: conversations.id });
  const [card] = await db
    .insert(messages)
    .values({
      conversationId: parent.id,
      role: "assistant",
      messageType: "task",
      content: "",
      payload: {
        sub_conversation_id: subConv.id,
        agent: agent.name,
        description,
        status: "running",
        result_summary: null,
      },
    })
    .returning({ id: messages.id });
  await emitRunEvent({
    conversationId: rootId,
    type: "task_started",
    payload: { sub_conversation_id: subConv.id, agent: agent.name, description, model },
  });

  // Persist the task prompt as the sub-conv's user message, then run a
  // TURN on the same core with the agent's allow-list enforced.
  await db.insert(messages).values({ conversationId: subConv.id, role: "user", content: prompt });

  const { allowed } = await resolveAllowedToolDefs(userId, agent.toolsAllow);
  const outcome = await runSubTurn({
    userId,
    conversationId: subConv.id,
    agent: { name: agent.name, systemPrompt: agent.systemPrompt, maxSteps: agent.maxSteps },
    prompt,
    model,
    target: opts.target,
    allowed,
    budget,
    rootId,
  });

  const summary = outcome.text.length > 500 ? `${outcome.text.slice(0, 500)}…` : outcome.text;
  await db
    .update(messages)
    .set({
      content: summary,
      payload: {
        sub_conversation_id: subConv.id,
        agent: agent.name,
        description,
        status: outcome.status,
        result_summary: summary,
      },
    })
    .where(eq(messages.id, card.id));
  await emitRunEvent({
    conversationId: rootId,
    type: outcome.status === "error" ? "task_error" : "task_done",
    payload: { sub_conversation_id: subConv.id, agent: agent.name, status: outcome.status },
  });

  return {
    ok: outcome.status === "done",
    status: outcome.status,
    result: outcome.text,
    error: outcome.error,
    sub_conversation_id: subConv.id,
  };
}

/** A bounded sub-turn: same streaming core, agent socle as system, the
 *  agent's allow-list enforced fail-closed, budget shared with the
 *  parent turn. */
async function runSubTurn(opts: {
  userId: string;
  conversationId: string;
  agent: { name: string; systemPrompt: string; maxSteps: number };
  prompt: string;
  model: string;
  target: { baseUrl: string; apiKey: string | null };
  allowed: Set<string>;
  budget: TaskBudget;
  rootId: string;
}): Promise<{ status: "done" | "error" | "truncated"; text: string; error?: string }> {
  const { userId, conversationId, agent, prompt, model, target, allowed, budget, rootId } = opts;
  const t0 = Date.now();

  const { defs } = await resolveAllowedToolDefs(userId, [...allowed]);
  const aiTools: ToolSet = {};
  for (const d of defs) {
    const fn = (d as { function: { name: string; description?: string; parameters?: unknown } }).function;
    aiTools[fn.name] = aiTool({
      description: fn.description ?? "",
      inputSchema: jsonSchema<Record<string, unknown>>((fn.parameters ?? { type: "object", properties: {} }) as never),
      execute: async (args: Record<string, unknown>) => {
        await emitRunEvent({
          conversationId: rootId,
          type: "tool_call",
          payload: { sub_conversation_id: conversationId, name: fn.name },
        });
        const r = await executeTool(fn.name, args as never, userId, null, allowed);
        await emitRunEvent({
          conversationId: rootId,
          type: "tool_result",
          payload: { sub_conversation_id: conversationId, name: fn.name, ok: r.ok },
        });
        return r;
      },
    });
  }

  const [assistantRow] = await db
    .insert(messages)
    .values({ conversationId, role: "assistant", content: "", parts: [] })
    .returning({ id: messages.id });
  const writer = new PartsWriter(assistantRow.id, conversationId);

  const capture: RoutedCapture = { routed: null, responseModel: null };
  const provider = makeProvider({
    baseUrl: target.baseUrl.replace(/\/$/, "") + "/v1",
    apiKey: target.apiKey,
    extraBody: {
      session_id: conversationId,
      enable_thinking: model === COEOS_ID ? true : undefined,
    },
    capture,
  });

  const remaining = Math.max(1, Math.min(agent.maxSteps, TURN_STEP_BUDGET - budget.stepsUsed));
  try {
    const result = streamText({
      model: provider(model),
      system: buildSystemPrompt({ agentSystemPrompt: agent.systemPrompt }) || undefined,
      messages: [{ role: "user", content: prompt }],
      ...(Object.keys(aiTools).length > 0 ? { tools: aiTools } : {}),
      stopWhen: stepCountIs(remaining),
      maxOutputTokens: 32768,
    });
    for await (const part of result.fullStream) {
      switch (part.type) {
        case "reasoning-delta":
          writer.delta("reasoning", (part as { text?: string }).text ?? "");
          break;
        case "text-delta":
          writer.delta("text", (part as { text?: string }).text ?? "");
          break;
        case "tool-call":
          writer.push({
            type: "tool-call",
            toolName: (part as { toolName?: string }).toolName,
            input: (part as { input?: unknown }).input,
          });
          break;
        case "tool-result":
          writer.push({
            type: "tool-result",
            toolName: (part as { toolName?: string }).toolName,
            output: summarizeOutput((part as { output?: unknown }).output),
          });
          break;
        case "start-step":
          budget.stepsUsed += 1;
          writer.push({ type: "step-start" });
          break;
        case "error":
          throw new Error(String(((part as { error?: unknown }).error as Error)?.message ?? "stream error"));
      }
    }
    await writer.flush({
      v3: true,
      model: capture.routed?.concrete ?? capture.responseModel ?? model,
      durationMs: Date.now() - t0,
    });
    void recordSpan({
      conversationId,
      agent: agent.name,
      type: "task",
      durationMs: Date.now() - t0,
      status: "ok",
      payload: { model, routed: capture.routed },
    });
    const text = writer.textContent();
    return text.trim()
      ? { status: "done", text }
      : { status: "truncated", text: "Step budget reached before a final answer." };
  } catch (err) {
    const msg = (err as Error).message;
    await writer.flush({ v3: true, error: msg }).catch(() => {});
    return { status: "error", text: "", error: msg };
  }
}
