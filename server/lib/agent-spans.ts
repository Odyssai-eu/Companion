// Agent spans — post-hoc tracing of the v2.0 runtime (llm/tool/task).
// OTLP-inspired NAMING only, no W3C trace-context conformance (PLAN.md
// F7). Fire-and-forget writes: tracing must never slow or break a task.
// 30-day retention, batched purge in the memory-scheduler.

import { db } from "../db/index";
import { agentSpans } from "../db/schema";

export type SpanInput = {
  conversationId: string;
  agent: string;
  type: "llm" | "tool" | "task";
  parentSpanId?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  durationMs?: number | null;
  status?: string;
  payload?: Record<string, unknown> | null;
};

export async function recordSpan(span: SpanInput): Promise<void> {
  try {
    await db.insert(agentSpans).values({
      conversationId: span.conversationId,
      agent: span.agent,
      type: span.type,
      parentSpanId: span.parentSpanId ?? null,
      tokensIn: span.tokensIn ?? null,
      tokensOut: span.tokensOut ?? null,
      durationMs: span.durationMs ?? null,
      status: span.status ?? "ok",
      payload: span.payload ?? null,
    });
  } catch (err) {
    console.warn("[spans] insert failed:", (err as Error).message);
  }
}
