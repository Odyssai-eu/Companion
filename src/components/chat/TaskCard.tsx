// Task card — the persistent, live-updating delegation card in the chat
// thread (v2.0 β). Rendered from the message_type='task' row; while the
// task runs, the live narration comes from the run-events SSE (via
// useRunEvents in ChatLayout). Click → Trace panel (the full
// sub-conversation).

import { useMemo, useState } from "react";
import type { UIMessage } from "~/hooks/useChat";
import type { TaskLiveState } from "~/hooks/useRunEvents";
import { renderMarkdown } from "~/lib/markdown";
import TracePanel from "./TracePanel";

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  done: "Done",
  error: "Failed",
  truncated: "Partial",
};

export default function TaskCard({
  message,
  live,
}: {
  message: UIMessage;
  live?: TaskLiveState;
}) {
  const [open, setOpen] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);

  const p = (message.payload ?? {}) as {
    sub_conversation_id?: string;
    agent?: string;
    description?: string;
    status?: string;
    result_summary?: string | null;
  };
  // Live state (SSE) wins while running; the persisted payload is the
  // durable fallback after reload / once the task is finished.
  const status = live?.status ?? p.status ?? "running";
  const agent = live?.agent || p.agent || "agent";
  const description = live?.description || p.description || "";
  const summary = p.result_summary || message.content || "";
  const running = status === "running";

  const statusColor =
    status === "done"
      ? "text-emerald-600"
      : status === "error"
        ? "text-red-600"
        : running
          ? "text-cyan"
          : "text-amber-600";

  const summaryHtml = useMemo(
    () => (summary ? renderMarkdown(summary) : ""),
    [summary],
  );

  return (
    <div className="my-2 rounded-lg border border-gray-200 bg-gray-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className={`text-[13px] ${statusColor}`}>
          {running ? (
            <span className="inline-block animate-pulse">▸</span>
          ) : status === "done" ? (
            "✓"
          ) : status === "error" ? (
            "✗"
          ) : (
            "◦"
          )}
        </span>
        <span className="font-sans text-[12px] font-medium tracking-[0.04em] text-navy uppercase">
          {agent}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-gray-700">
          {description}
        </span>
        <span className={`text-[11px] ${statusColor}`}>
          {STATUS_LABEL[status] ?? status}
        </span>
        <span className="text-[11px] text-gray-400">{open ? "▾" : "▸"}</span>
      </button>

      {running && (live?.lastLine || live?.toolCalls) ? (
        <div className="border-t border-gray-100 px-3 py-1.5 font-mono text-[11px] text-gray-500">
          {live?.lastLine || "working…"}
          {live && live.toolCalls > 0 && (
            <span className="ml-2 text-gray-400">
              · {live.toolCalls} tool call{live.toolCalls > 1 ? "s" : ""}
            </span>
          )}
        </div>
      ) : null}

      {open && !running && summaryHtml && (
        <div
          className="md-body border-t border-gray-100 px-3 py-2 text-[13px] text-ink"
          dangerouslySetInnerHTML={{ __html: summaryHtml }}
        />
      )}

      {open && p.sub_conversation_id && (
        <div className="border-t border-gray-100 px-3 py-1.5">
          <button
            type="button"
            onClick={() => setTraceOpen(true)}
            className="text-[11px] text-cyan hover:text-navy"
          >
            Open trace
          </button>
        </div>
      )}

      {traceOpen && p.sub_conversation_id && (
        <TracePanel
          subConversationId={p.sub_conversation_id}
          agent={agent}
          onClose={() => setTraceOpen(false)}
        />
      )}
    </div>
  );
}
