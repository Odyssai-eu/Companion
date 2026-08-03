// Live task-narration state — one EventSource per open conversation on
// /api/conversations/:id/run-events (v2.0 β). The server replays recent
// persisted events then streams live; we fold everything into a small
// per-sub-conversation state map the task cards render from.

import { useEffect, useState } from "react";

export type TaskLiveState = {
  status: "running" | "done" | "error" | "truncated";
  agent: string;
  description: string;
  /** Latest narration line (step text or tool name). */
  lastLine: string;
  toolCalls: number;
  startedAt: number | null;
  durationMs: number | null;
};

type RunEventFrame = {
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export function useRunEvents(
  conversationId: string | null,
): Map<string, TaskLiveState> {
  const [tasks, setTasks] = useState<Map<string, TaskLiveState>>(new Map());

  useEffect(() => {
    setTasks(new Map());
    if (!conversationId) return;
    const es = new EventSource(
      `/api/conversations/${conversationId}/run-events`,
    );
    es.onmessage = (e) => {
      let frame: RunEventFrame;
      try {
        frame = JSON.parse(e.data);
      } catch {
        return;
      }
      const subId = String(frame.payload?.sub_conversation_id ?? "");
      if (!subId) return;
      setTasks((prev) => {
        const next = new Map(prev);
        const cur: TaskLiveState = next.get(subId) ?? {
          status: "running",
          agent: String(frame.payload?.agent ?? ""),
          description: String(frame.payload?.description ?? ""),
          lastLine: "",
          toolCalls: 0,
          startedAt: null,
          durationMs: null,
        };
        switch (frame.type) {
          case "task_started":
            cur.status = "running";
            cur.agent = String(frame.payload.agent ?? cur.agent);
            cur.description = String(
              frame.payload.description ?? cur.description,
            );
            cur.startedAt = Date.parse(frame.createdAt) || Date.now();
            break;
          case "step":
            cur.lastLine = String(frame.payload.text ?? "");
            break;
          case "tool_call":
            cur.toolCalls += 1;
            cur.lastLine = `→ ${String(frame.payload.name ?? "tool")}`;
            break;
          case "tool_result":
            cur.lastLine = `${frame.payload.ok ? "✓" : "✗"} ${String(frame.payload.name ?? "tool")}`;
            break;
          case "task_done":
          case "task_error": {
            const s = String(frame.payload.status ?? "done");
            cur.status =
              s === "error" ? "error" : s === "truncated" ? "truncated" : "done";
            cur.durationMs = Number(frame.payload.duration_ms ?? 0) || null;
            break;
          }
        }
        next.set(subId, { ...cur });
        return next;
      });
    };
    return () => es.close();
  }, [conversationId]);

  return tasks;
}
