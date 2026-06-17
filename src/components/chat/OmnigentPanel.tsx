/**
 * OmnigentPanel — inline terminal-style panel for the `/omnigent` agent mode.
 *
 * Cloned from HermesPanel / AgentBubble, but adapted to the Omnigent bridge:
 * unlike Hermes / Pi (which embed the agent's OWN web TUI in an iframe), the
 * Omnigent bridge has no web UI — it is a pure SSE bridge. So this panel
 * RENDERS the agent run client-side, consuming the collapsed SSE shape the
 * bridge emits (`{kind: tool_start | tool_done | approval | status | text}`)
 * via Companion's `POST /api/addons/omnigent/run` route.
 *
 * The transcript + streaming flag are owned by useChat (the same `agentMessages`
 * state Hermes' ACP bubble uses) and the SSE send loop lives in
 * useChat.omnigentInvoke — so the composer's submit, while in `/omnigent` mode,
 * routes here instead of the LLM chat path.
 */

import { useEffect, useRef } from "react";
import type { AgentMessage } from "./AgentBubble";

type Props = {
  messages: AgentMessage[];
  /** True while a run is in flight — shows a blinking cursor */
  streaming: boolean;
  /** Optional error to surface above the transcript */
  error?: string | null;
  /** Drop the local transcript — next prompt starts a fresh bridge session */
  onReset?: () => void;
  /** Leave `/omnigent` mode (return to normal chat) */
  onExit?: () => void;
  /** Agent profile in use (from the add-on config), shown in the header */
  agentLabel?: string;
};

export function OmnigentPanel({
  messages,
  streaming,
  error,
  onReset,
  onExit,
  agentLabel = "Omnigent",
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  return (
    <div className="mx-auto my-4 w-full max-w-3xl overflow-hidden rounded-lg border border-gray-800 bg-[#0d1117] font-mono text-[12.5px] text-gray-200 shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-800 bg-[#161b22] px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={`h-2 w-2 rounded-full ${
                streaming ? "animate-pulse bg-emerald-400" : "bg-gray-600"
              }`}
            />
            <span className="text-[11px] font-semibold tracking-wide text-gray-100">
              {agentLabel}
            </span>
          </span>
          <span className="text-[10px] text-gray-500">
            {streaming
              ? "running…"
              : "agent · tape directement, /exit pour sortir"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {onReset && messages.length > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="text-[10px] text-gray-500 hover:text-gray-200"
              title="Drop the transcript — next prompt starts a fresh session"
            >
              ⟲ reset
            </button>
          )}
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="text-[10px] text-gray-500 hover:text-gray-200"
              title="Sortir du mode Omnigent (revient au chat normal)"
            >
              × exit
            </button>
          )}
        </div>
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
        {messages.length === 0 && !streaming && !error && (
          <div className="text-[12px] text-gray-500">
            Mode Omnigent actif. Tape une tâche ci-dessous — elle part à
            l'agent (pas au LLM). <span className="text-gray-400">/exit</span>{" "}
            pour revenir au chat normal.
          </div>
        )}
        {messages.map((m) => (
          <OmnigentLine key={m.id} message={m} />
        ))}
        {streaming && (
          <div className="mt-1 inline-block h-3 w-1.5 animate-pulse bg-gray-400 align-middle" />
        )}
      </div>
    </div>
  );
}

function OmnigentLine({ message }: { message: AgentMessage }) {
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
    const stats = (message.stats ?? {}) as {
      args?: unknown;
      phase?: string;
      approval?: boolean;
    };
    const args = stats.args;
    return (
      <div className="mb-3 border-l-2 border-amber-700 pl-3">
        <div className="text-[11px] uppercase tracking-wide text-amber-400">
          {stats.approval ? "⚑ approval" : "⚒ tool"} · {message.content}
        </div>
        {args != null && (
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px] text-amber-200/70">
            {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
          </pre>
        )}
      </div>
    );
  }
  if (message.role === "agent" && message.content === "") {
    // Placeholder agent line (no text yet) — render nothing until text arrives.
    return null;
  }
  // agent text
  return (
    <div className="mb-3">
      <span className="whitespace-pre-wrap text-gray-100">
        {message.content}
      </span>
    </div>
  );
}
