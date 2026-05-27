/**
 * AgentBubble — inline terminal-style panel for agent sub-threads (/hermes).
 *
 * Lives below the message list in a chat. Persistent per conversation:
 * each `/hermes <prompt>` continues the same Hermes ACP session, with
 * the full transcript visible. The transcript is loaded from the server
 * on conv switch, then accumulates locally as the user invokes more
 * prompts.
 */

import { useEffect, useRef } from "react";

export type AgentMessage = {
  id: string;
  role: "user" | "agent" | "tool";
  content: string;
  stats?: Record<string, unknown> | null;
  createdAt?: string;
  pending?: boolean;
};

type Props = {
  messages: AgentMessage[];
  /** True while a turn is in flight — shows a blinking cursor */
  streaming: boolean;
  /** Optional error to surface above the transcript */
  error?: string | null;
  /** Drop the bridge session — next /hermes (or /pi) opens a fresh one */
  onReset?: () => void;
  /** Optional agent label — defaults to "Hermes" for back-compat */
  agentLabel?: string;
};

export function AgentBubble({
  messages,
  streaming,
  error,
  onReset,
  agentLabel = "Hermes",
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  if (messages.length === 0 && !streaming && !error) return null;

  return (
    <div className="mx-auto my-4 w-full max-w-3xl overflow-hidden rounded-lg border border-gray-800 bg-[#0d1117] font-mono text-[12.5px] text-gray-200 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 bg-[#161b22] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${streaming ? "animate-pulse bg-emerald-400" : "bg-gray-600"}`} />
            <span className="text-[11px] font-semibold tracking-wide text-gray-100">{agentLabel}</span>
          </span>
          <span className="text-[10px] text-gray-500">
            {streaming ? "thinking…" : "ready"}
          </span>
        </div>
        {onReset && messages.length > 0 && (
          <button
            type="button"
            onClick={onReset}
            className="text-[10px] text-gray-500 hover:text-gray-200"
            title="Drop the current bridge session — next /hermes starts fresh"
          >
            ⟲ reset
          </button>
        )}
      </div>

      {/* Body */}
      <div
        ref={bodyRef}
        className="max-h-[60vh] overflow-y-auto px-4 py-3 leading-[1.55]"
      >
        {error && (
          <div className="mb-3 rounded border border-red-900 bg-red-950 px-3 py-2 text-[12px] text-red-200">
            <span className="font-semibold">error:</span> {error}
          </div>
        )}
        {messages.map((m) => (
          <AgentLine key={m.id} message={m} />
        ))}
        {streaming && (
          <div className="mt-1 inline-block h-3 w-1.5 animate-pulse bg-gray-400 align-middle" />
        )}
      </div>
    </div>
  );
}

function AgentLine({ message }: { message: AgentMessage }) {
  if (message.role === "user") {
    return (
      <div className="mb-3">
        <span className="select-none pr-2 text-cyan-400">$</span>
        <span className="whitespace-pre-wrap text-cyan-100">
          {message.content}
        </span>
      </div>
    );
  }
  if (message.role === "tool") {
    const args = (message.stats as { args?: unknown } | null)?.args;
    // Hide the args block when it's just a `locations` array of single
    // {path} entries — the title already has the path. Show it when
    // there's something genuinely supplementary (raw inputs, diffs).
    const argsIsJustPaths =
      Array.isArray(args) &&
      args.every(
        (a) =>
          a != null &&
          typeof a === "object" &&
          Object.keys(a as object).length === 1 &&
          "path" in (a as object),
      );
    return (
      <div className="mb-3 border-l-2 border-amber-700 pl-3">
        <div className="text-[11px] uppercase tracking-wide text-amber-400">
          ⚒ tool · {message.content}
        </div>
        {args != null && !argsIsJustPaths && (
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-amber-200/70">
            {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
          </pre>
        )}
      </div>
    );
  }
  // agent
  return (
    <div className="mb-3">
      <span className="whitespace-pre-wrap text-gray-100">{message.content}</span>
    </div>
  );
}
