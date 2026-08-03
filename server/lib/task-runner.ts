// Task runner — the sub-pump of the v2.0 agent runtime (PLAN.md §4).
//
// One call = one delegation: spawn a sub-conversation for a subagent,
// run its own bounded LLM loop (agent.max_steps — NOT the parent's
// MAX_TOOL_ITERATIONS), enforce the agent's tools_allow fail-closed,
// persist the transcript in the sub-conversation, keep a persistent
// task card (message_type='task') in the parent thread, emit run_events
// under the ROOT conversation key, and return the final text to the
// caller (the parent's tool loop).
//
// v2.0 execution contract:
//  - sequential (the parent runs tasks one after the other — no
//    parallel spawns; cold starts would saturate the upstream),
//  - no `background` mode (v2.1),
//  - per-turn guards live in the TurnBudget the parent owns:
//    max 3 tasks/turn, 30 cumulative LLM steps across all tasks,
//  - depth cap 2, derived from the parent_id chain (persistent).

import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { conversations, messages } from "../db/schema";
import { resolveAgentByName } from "./agent-rows";
import { COEOS_MODEL_ID } from "../routes/chat";
import { loadGuardConfigForUser } from "../routes/addon-guard";
import { classifyText } from "./guard";
import { buildSystemPrompt } from "./prompt-builder";
import { emitRunEvent } from "./run-events";
import { recordSpan } from "./agent-spans";
import { executeTool, resolveAllowedToolDefs } from "./tools";
import { stringifyForTool } from "./stream-collector";

const MAX_TASKS_PER_TURN = 3;
const TURN_STEP_BUDGET = 30;
const MAX_DEPTH = 2;
const HEARTBEAT_MS = 20_000;

// Same rationale as chat-stream's dispatcher: non-stream calls on slow
// local models can take minutes before the first byte.
const taskDispatcher = new UndiciAgent({
  connect: { timeout: 10_000 },
  headersTimeout: 600_000,
  bodyTimeout: 0,
  keepAliveTimeout: 60_000,
});

/** Per-primary-turn guard state. The parent's tool loop creates ONE of
 *  these per turn and passes it to every task call of that turn. */
export type TurnBudget = {
  tasksStarted: number;
  stepsUsed: number;
};

export function newTurnBudget(): TurnBudget {
  return { tasksStarted: 0, stepsUsed: 0 };
}

export type TaskRunArgs = {
  userId: string;
  /** The conversation the task tool was called from. */
  parentConversationId: string;
  subagent: string;
  prompt: string;
  description: string;
  /** Effective model of the parent turn (post-router). */
  parentModel: string;
  /** Fallback when neither agent.model nor parentModel resolve. */
  defaultModel: string | null;
  target: { baseUrl: string; apiKey: string | null };
  headers: Record<string, string>;
  budget: TurnBudget;
};

export type TaskRunResult = {
  ok: boolean;
  status: "done" | "error" | "truncated";
  /** Final text of the subagent (or error message). */
  text: string;
  subConversationId?: string;
};

type Turn = Record<string, unknown>;

export async function runTask(args: TaskRunArgs): Promise<TaskRunResult> {
  const {
    userId, parentConversationId, subagent, prompt, description,
    parentModel, defaultModel, target, headers, budget,
  } = args;
  void parentModel; // v2.1: CoeOS decides — kept in the signature for call-site stability

  // ── Guards ──────────────────────────────────────────────────────────
  if (budget.tasksStarted >= MAX_TASKS_PER_TURN) {
    return {
      ok: false, status: "error",
      text: `Task limit reached (${MAX_TASKS_PER_TURN} per turn). Integrate the results you already have.`,
    };
  }
  if (budget.stepsUsed >= TURN_STEP_BUDGET) {
    return {
      ok: false, status: "error",
      text: `Step budget for this turn is exhausted (${TURN_STEP_BUDGET}). Answer from what you have.`,
    };
  }

  const agent = await resolveAgentByName(userId, subagent);
  if (!agent || !agent.enabled || agent.mode !== "subagent") {
    return {
      ok: false, status: "error",
      text: `Unknown or disabled subagent '${subagent}'.`,
    };
  }

  // Ownership + depth from the parent chain (persistent by construction).
  const [parent] = await db
    .select({
      id: conversations.id,
      userId: conversations.userId,
      parentId: conversations.parentId,
    })
    .from(conversations)
    .where(eq(conversations.id, parentConversationId))
    .limit(1);
  if (!parent || parent.userId !== userId) {
    return { ok: false, status: "error", text: "Parent conversation not found." };
  }
  let depth = 1; // the sub-conversation we are about to create
  let cursor = parent.parentId;
  while (cursor) {
    depth += 1;
    if (depth > MAX_DEPTH) break;
    const [row] = await db
      .select({ parentId: conversations.parentId })
      .from(conversations)
      .where(eq(conversations.id, cursor))
      .limit(1);
    cursor = row?.parentId ?? null;
  }
  if (depth > MAX_DEPTH) {
    return {
      ok: false, status: "error",
      text: `Delegation depth cap (${MAX_DEPTH}) reached — do the work yourself.`,
    };
  }

  // Root conversation = the key the UI listens on.
  let rootId = parent.id;
  if (parent.parentId) rootId = parent.parentId; // depth ≤ 2 ⇒ parent's parent is the root

  // ── Model resolution (frozen at spawn, never "auto") ────────────────
  // v2.1: the classification decides — an agent without a pinned model
  // runs on CoeOS (the gateway federates it). Pinned agent.model keeps
  // the direct rail (custom agents, banc d'essai).
  let model = agent.model ?? COEOS_MODEL_ID;
  if (model === "auto") model = defaultModel ?? COEOS_MODEL_ID;

  // ── Guard — runtime surface (v2.1 P1.4) ─────────────────────────────
  // A sub-conversation has no UI to prompt mid-task, so the semantics
  // differ from chat (block+prompt): sensitive → force-local
  // automatically; no local rail available → FAIL CLOSED (task_error,
  // the content is never sent). Classification happens here at spawn on
  // the task prompt — the single entry point of external content into
  // the sub-conversation.
  try {
    const guardCfg = await loadGuardConfigForUser(userId);
    if (guardCfg) {
      const verdict = await classifyText(prompt.slice(0, 8_000), guardCfg);
      if (verdict?.sensitive) {
        const localModel = guardCfg.localModel?.trim() ?? "";
        if (localModel) {
          console.log(
            "[task] guard flagged prompt (severity=%s) → force-local %s",
            verdict.maxSeverity,
            localModel,
          );
          model = localModel;
        } else {
          return {
            ok: false, status: "error",
            text:
              "This task contains sensitive content and no local model is " +
              "configured to run it (Confidential Guard). Content not sent.",
          };
        }
      }
    }
  } catch {
    /* guard fail-soft on classification errors, same as chat */
  }

  budget.tasksStarted += 1;

  // ── Spawn the sub-conversation ──────────────────────────────────────
  const [subConv] = await db
    .insert(conversations)
    .values({
      userId,
      parentId: parent.id,
      agentName: agent.name,
      title: description.slice(0, 120) || `Task: ${agent.name}`,
      kind: "chat",
      activeAgent: null, // forced — never a slash-command runtime in a sub-conv
      model,
      memoryEnabled: false,
      agentMode: false,
      agentPromptSnapshot: agent.systemPrompt,
    })
    .returning({ id: conversations.id });
  const subId = subConv.id;

  // Persistent task card in the parent thread (status: running → final).
  const [card] = await db
    .insert(messages)
    .values({
      conversationId: parent.id,
      role: "assistant",
      messageType: "task",
      content: "",
      payload: {
        sub_conversation_id: subId,
        agent: agent.name,
        description,
        status: "running",
        result_summary: null,
      },
    })
    .returning({ id: messages.id });

  const taskStartedAt = Date.now();
  await emitRunEvent({
    conversationId: rootId,
    type: "task_started",
    payload: { sub_conversation_id: subId, agent: agent.name, description, model },
  });

  // ── Tools for the sub-conversation (fail-closed) ────────────────────
  const { defs: toolDefs, allowed } = await resolveAllowedToolDefs(
    userId,
    agent.toolsAllow,
  );

  // ── Transcript ──────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt({ agentSystemPrompt: agent.systemPrompt });
  let turns: Turn[] = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: prompt },
  ];
  await db.insert(messages).values({
    conversationId: subId,
    role: "user",
    content: prompt,
  });

  const maxSteps = Math.max(1, agent.maxSteps);
  let status: TaskRunResult["status"] = "truncated";
  let finalText = "";
  let stepsThisTask = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  // Heartbeat — keeps the parent SSE alive through long cold starts.
  const heartbeat = setInterval(() => {
    void emitRunEvent({
      conversationId: rootId,
      type: "heartbeat",
      payload: { sub_conversation_id: subId },
    });
  }, HEARTBEAT_MS);

  try {
    for (let step = 0; step < maxSteps; step++) {
      if (budget.stepsUsed >= TURN_STEP_BUDGET) {
        status = "truncated";
        break;
      }
      budget.stepsUsed += 1;
      stepsThisTask += 1;

      const isFinal = step === maxSteps - 1;
      const requestBody = {
        model,
        stream: false,
        session_id: subId, // own KV prefix — no sharing with the parent
        messages: turns,
        ...(toolDefs.length > 0
          ? { tools: toolDefs, tool_choice: isFinal ? "none" : "auto" }
          : {}),
      };

      const llmStart = Date.now();
      const upstream = await undiciFetch(`${target.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
        dispatcher: taskDispatcher,
      });
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
        finalText = `Upstream error ${upstream.status}: ${text.slice(0, 200)}`;
        status = "error";
        break;
      }
      const json = (await upstream.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              function: { name: string; arguments: string };
            }>;
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
        /** CoeOS/OdyssAI routing metadata (same field the stream
         *  collector reads) — feeds the P0 table via the llm span. */
        x_odyssai_routed?: {
          router?: string;
          routed_to?: string;
          category?: string;
          concrete?: string;
        };
      };
      tokensIn += json.usage?.prompt_tokens ?? 0;
      tokensOut += json.usage?.completion_tokens ?? 0;

      const msg = json.choices?.[0]?.message;
      const content = (msg?.content ?? "").trim();
      const toolCalls = msg?.tool_calls ?? [];

      void recordSpan({
        conversationId: subId,
        agent: agent.name,
        type: "llm",
        tokensIn: json.usage?.prompt_tokens ?? null,
        tokensOut: json.usage?.completion_tokens ?? null,
        durationMs: Date.now() - llmStart,
        status: "ok",
        payload: {
          step,
          tool_calls: toolCalls.length,
          model,
          response_model: json.model ?? null,
          routed: json.x_odyssai_routed ?? null,
        },
      });

      // Narration step → event + persisted assistant message in sub-conv.
      if (content) {
        await db.insert(messages).values({
          conversationId: subId,
          role: "assistant",
          content,
        });
        await emitRunEvent({
          conversationId: rootId,
          type: "step",
          payload: {
            sub_conversation_id: subId,
            text: content.slice(0, 300),
            step,
          },
        });
      }

      if (toolCalls.length === 0) {
        finalText = content;
        status = "done";
        break;
      }

      // Execute the tool calls (fail-closed on the allow-list).
      const results: Awaited<ReturnType<typeof executeTool>>[] = [];
      for (const tc of toolCalls) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(tc.function.arguments || "{}");
        } catch {
          /* leave empty */
        }
        await emitRunEvent({
          conversationId: rootId,
          type: "tool_call",
          payload: { sub_conversation_id: subId, name: tc.function.name },
        });
        const toolStart = Date.now();
        const result = await executeTool(
          tc.function.name,
          parsed,
          userId,
          null,
          allowed,
        );
        void recordSpan({
          conversationId: subId,
          agent: agent.name,
          type: "tool",
          durationMs: Date.now() - toolStart,
          status: result.ok ? "ok" : "error",
          payload: { name: tc.function.name },
        });
        await emitRunEvent({
          conversationId: rootId,
          type: "tool_result",
          payload: {
            sub_conversation_id: subId,
            name: tc.function.name,
            ok: result.ok,
          },
        });
        results.push(result);
      }

      turns = [
        ...turns,
        {
          role: "assistant",
          content: content || null,
          tool_calls: toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        },
        ...toolCalls.map((tc, i) => ({
          role: "tool",
          tool_call_id: tc.id,
          content: stringifyForTool(results[i]),
        })),
      ];
    }

    if (status === "truncated" && !finalText) {
      finalText =
        "Step budget reached before a final answer. Partial narration is in the task trace.";
    }
  } catch (err) {
    status = "error";
    finalText = `Task failed: ${(err as Error).message}`;
  } finally {
    clearInterval(heartbeat);
  }

  // ── Finalize card + events + span ───────────────────────────────────
  const summary =
    finalText.length > 500 ? `${finalText.slice(0, 500)}…` : finalText;
  await db
    .update(messages)
    .set({
      content: summary,
      payload: {
        sub_conversation_id: subId,
        agent: agent.name,
        description,
        status,
        result_summary: summary,
      },
    })
    .where(eq(messages.id, card.id));

  await emitRunEvent({
    conversationId: rootId,
    type: status === "error" ? "task_error" : "task_done",
    payload: {
      sub_conversation_id: subId,
      agent: agent.name,
      status,
      steps: stepsThisTask,
      duration_ms: Date.now() - taskStartedAt,
    },
  });
  void recordSpan({
    conversationId: parent.id,
    agent: agent.name,
    type: "task",
    tokensIn,
    tokensOut,
    durationMs: Date.now() - taskStartedAt,
    status: status === "done" ? "ok" : status,
    payload: { sub_conversation_id: subId, steps: stepsThisTask },
  });

  return {
    ok: status === "done",
    status,
    text: finalText,
    subConversationId: subId,
  };
}
