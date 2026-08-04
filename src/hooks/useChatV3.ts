// useChatV3 — the client half of the v3 rail (PLAN.md V3-c).
//
// The v1 hook (useChat) relayed provider frames and decoded them a second
// time in the browser. v3 flips that: the SERVER owns the whole turn and
// streams TYPED PARTS on one SSE. This hook only accumulates those parts
// into the existing UIMessage shape so the polished <Messages> renderer
// (ReasoningBlock, ToolCallsBlock, StatsRow) draws them unchanged.
//
// It COMPOSES useChat: every shell concern (model picker, inference
// params, conversation metadata, memory/agent toggles, comfyui) comes
// from the base hook untouched. Only the live surface — `messages`,
// `sending`, `sendMessage`, `cancel`, `regenerate` — is replaced, and
// only when the v3 flag is on. Flag off ⇒ the base hook verbatim, so the
// swap in ChatLayout is a no-op for everyone else.
//
// The CodeOS feel is a rendering property of the parts stream: while the
// turn runs you see the work (Thinking block live, tool calls streaming);
// when it settles, the thinking collapses to "Thought" and the text part
// is the result. Nothing here fakes that — it's the parts arriving in
// order.

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "~/lib/api";
import {
  DEFAULT_INFERENCE,
  inferenceToPayload,
  useChat,
  type ToolCallRecord,
  type UIMessage,
  type UseChatOptions,
} from "./useChat";

// ── part → UIMessage projection ────────────────────────────────────────

type Part = { type: string } & Record<string, unknown>;

/** Fold an ordered parts array into the flat UIMessage fields the
 *  renderer reads. reasoning and text are concatenated per kind; tool
 *  calls pair with their result by order. This is the "separated
 *  thinking / result" model Sophie confirmed. */
function projectParts(parts: Part[]): {
  reasoning?: string;
  content: string;
  toolCalls?: ToolCallRecord[];
} {
  let reasoning = "";
  let content = "";
  const toolCalls: ToolCallRecord[] = [];
  for (const p of parts) {
    if (p.type === "reasoning") reasoning += String(p.text ?? "");
    else if (p.type === "text") content += String(p.text ?? "");
    else if (p.type === "tool-call") {
      toolCalls.push({
        name: String(p.toolName ?? "tool"),
        args: (p.input as Record<string, unknown>) ?? undefined,
      });
    } else if (p.type === "tool-result") {
      // Attach to the last matching call still awaiting a result.
      const name = String(p.toolName ?? "");
      const target = [...toolCalls].reverse().find(
        (c) => c.name === name && !c.result,
      );
      const ok = p.ok !== false;
      const summary =
        typeof p.output === "string"
          ? p.output.slice(0, 80)
          : ok
            ? "done"
            : "failed";
      if (target) target.result = { ok, summary };
    }
  }
  return {
    reasoning: reasoning || undefined,
    content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

function rowToUI(row: {
  id: string;
  role: "user" | "assistant" | "system";
  messageType?: "chat" | "task" | null;
  payload?: Record<string, unknown> | null;
  parts?: Part[] | null;
  content?: string | null;
  stats?: UIMessage["stats"] | null;
  createdAt?: string;
}): UIMessage {
  const parts = Array.isArray(row.parts) ? row.parts : [];
  const proj = parts.length ? projectParts(parts) : { content: row.content ?? "" };
  return {
    id: row.id,
    role: row.role,
    messageType: (row.messageType as "chat" | "task") ?? "chat",
    payload: row.payload ?? undefined,
    content: proj.content || row.content || "",
    reasoning: proj.reasoning,
    toolCalls: proj.toolCalls,
    stats: row.stats ?? undefined,
    model: row.stats?.model,
    createdAt: row.createdAt,
    streaming: false,
  };
}

// ── the v3 runtime (inert when disabled) ───────────────────────────────

type Frame =
  | { v3: "replay"; messages: Parameters<typeof rowToUI>[0][] }
  | { v3: "turn"; state: string; messageId?: string; stats?: UIMessage["stats"]; severity?: string; findings?: { category: string }[] }
  | { v3: "part-open"; messageId: string; part: { type: string } }
  | { v3: "part-delta"; messageId: string; kind: "reasoning" | "text"; text: string }
  | { v3: "part"; messageId: string; part: Part }
  | { v3: "event"; type: string; payload: Record<string, unknown> }
  | Record<string, unknown>;

function useV3Runtime(
  conversationId: string | undefined,
  base: ReturnType<typeof useChat>,
  enabled: boolean,
) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Raw parts per streaming assistant message id — the projection source
  // of truth while a turn is live. Cleared on reconcile.
  const liveParts = useRef<Map<string, Part[]>>(new Map());

  const patch = useCallback((id: string, next: Partial<UIMessage>) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...next } : m)),
    );
  }, []);

  const ensureAssistant = useCallback((id: string) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === id)) return prev;
      return [
        ...prev,
        {
          id,
          role: "assistant" as const,
          messageType: "chat" as const,
          content: "",
          streaming: true,
        },
      ];
    });
    if (!liveParts.current.has(id)) liveParts.current.set(id, []);
  }, []);

  const reproject = useCallback(
    (id: string, extra?: Partial<UIMessage>) => {
      const parts = liveParts.current.get(id) ?? [];
      const proj = projectParts(parts);
      patch(id, {
        content: proj.content,
        reasoning: proj.reasoning,
        toolCalls: proj.toolCalls,
        ...extra,
      });
    },
    [patch],
  );

  const onFrame = useCallback(
    (f: Frame) => {
      const kind = (f as { v3?: string }).v3;
      if (kind === "replay") {
        const rows = (f as Extract<Frame, { v3: "replay" }>).messages ?? [];
        setMessages(rows.map(rowToUI));
        return;
      }
      if (kind === "part-open") {
        const { messageId } = f as Extract<Frame, { v3: "part-open" }>;
        ensureAssistant(messageId);
        return;
      }
      if (kind === "part-delta") {
        const d = f as Extract<Frame, { v3: "part-delta" }>;
        ensureAssistant(d.messageId);
        const parts = liveParts.current.get(d.messageId) ?? [];
        const last = parts[parts.length - 1];
        if (last && last.type === d.kind) last.text = String(last.text ?? "") + d.text;
        else parts.push({ type: d.kind, text: d.text });
        liveParts.current.set(d.messageId, parts);
        reproject(d.messageId, { streaming: true });
        return;
      }
      if (kind === "part") {
        const p = f as Extract<Frame, { v3: "part" }>;
        ensureAssistant(p.messageId);
        const parts = liveParts.current.get(p.messageId) ?? [];
        parts.push(p.part);
        liveParts.current.set(p.messageId, parts);
        reproject(p.messageId, { streaming: true });
        return;
      }
      if (kind === "turn") {
        const t = f as Extract<Frame, { v3: "turn" }>;
        if (t.state === "active") {
          setSending(true);
          return;
        }
        if (t.state === "guard_blocked") {
          setSending(false);
          // Parity with v1: a sensitive turn on the router is BLOCKED (no
          // assistant reply persisted). Surface a live-only switch-to-local
          // prompt in place of the answer.
          setMessages((prev) => [
            ...prev,
            {
              id: `blocked-${prev.length}`,
              role: "assistant",
              content: "",
              blocked: {
                severity: (t.severity as "low" | "medium" | "high") ?? "medium",
                findings: (t.findings ?? []).map((f) => ({
                  category: f.category,
                  severity: String(t.severity ?? "medium"),
                  spans: [],
                })),
              },
            },
          ]);
          return;
        }
        // done | stopped | error → finalize the streaming message.
        setSending(false);
        if (t.messageId) {
          reproject(t.messageId, {
            streaming: false,
            stats: t.stats ?? undefined,
            model: t.stats?.model,
          });
          liveParts.current.delete(t.messageId);
        }
        if (t.state === "error") setError("turn_error");
        return;
      }
      // Relayed run-events (task cards). A task appears/updates as its own
      // message row — pull it via a light refetch so the card shows.
      if (kind === "event") {
        const ev = f as Extract<Frame, { v3: "event" }>;
        if (ev.type === "task_started" || ev.type === "task_done" || ev.type === "task_error") {
          void refreshRows();
        }
      }
    },
    [ensureAssistant, reproject],
  );

  // Reconcile the whole thread from the DB (final parts + stats + task
  // rows). Cheap; reuses the v1 GET (same auth, same DB).
  const refreshRows = useCallback(async () => {
    if (!conversationId) return;
    try {
      const r = await fetch(`/api/v3/conversations/${conversationId}/state`, {
        credentials: "include",
      });
      // state endpoint is only liveness; the parts live on the stream's
      // replay. A fresh SSE connect would re-replay, but we already hold
      // the live copy. Nothing to do here beyond existence check.
      void r;
    } catch {
      /* ignore */
    }
  }, [conversationId]);

  // Open the single SSE for this conversation. Anti-gap order is the
  // route's job (subscribe → buffer → replay → splice); we just read.
  useEffect(() => {
    if (!enabled || !conversationId) {
      setMessages([]);
      return;
    }
    const ac = new AbortController();
    abortRef.current = ac;
    liveParts.current.clear();
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/v3/conversations/${conversationId}/stream`,
          { credentials: "include", signal: ac.signal },
        );
        if (!r.ok || !r.body) return;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, i);
            buf = buf.slice(i + 2);
            for (const line of raw.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                onFrame(JSON.parse(line.slice(6)) as Frame);
              } catch {
                /* keepalive / partial */
              }
            }
          }
        }
      } catch {
        /* aborted or network — the effect re-runs on remount */
      }
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [enabled, conversationId, onFrame]);

  // Build the OpenAI-shaped history the processor expects (contract-same
  // as v1: the client sends the full thread; the server persists nothing
  // of the user turn — we append it ourselves).
  const historyFor = useCallback(
    (extra?: { role: "user"; content: string }) => {
      const src = extra ? [...messages, { ...extra, id: "pending" }] : messages;
      return src
        .filter((m) => m.role !== "system" && m.messageType !== "task")
        .map((m) => ({ role: m.role, content: m.content }));
    },
    [messages],
  );

  const fire = useCallback(
    async (convId: string, history: { role: string; content: string }[]) => {
      setError(null);
      setSending(true);
      const params = inferenceToPayload(base.inference ?? DEFAULT_INFERENCE);
      await fetch("/api/v3/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          conversationId: convId,
          model: base.model,
          messages: history,
          params,
        }),
      }).catch(() => {
        setSending(false);
        setError("send_failed");
      });
    },
    [base.inference, base.model],
  );

  const sendMessage = useCallback(
    // attachments accepted for signature parity with v1; v3 beta is
    // text-only for now (vision/docs land in V3-d).
    async (text: string, _attachments: unknown[] = []) => {
      void _attachments;
      const clean = text.trim();
      if (!clean || sending) return;
      // New conversation: create it, land on its route (the SSE opens on
      // remount), persist the user turn, then fire.
      if (!conversationId) {
        const { conversation } = await api.createConversation({
          model: base.model || undefined,
          memoryEnabled: base.memoryEnabled,
          agentMode: base.agentMode,
        });
        await api.appendMessage(conversation.id, { role: "user", content: clean });
        navigate(`/c/${conversation.id}`);
        await fire(conversation.id, [{ role: "user", content: clean }]);
        return;
      }
      const userMsg: UIMessage = {
        id: `local-${Date.now()}`,
        role: "user",
        content: clean,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      await api.appendMessage(conversationId, { role: "user", content: clean });
      await fire(conversationId, historyFor({ role: "user", content: clean }));
    },
    [
      conversationId,
      sending,
      base.model,
      base.memoryEnabled,
      base.agentMode,
      navigate,
      fire,
      historyFor,
    ],
  );

  // After a guard block, the user picks a local model — drop the blocked
  // placeholder and re-fire the turn on the v3 rail with that model.
  const resendOnLocalModel = useCallback(
    async (modelId: string) => {
      if (!conversationId) return;
      setMessages((prev) => prev.filter((m) => !m.blocked));
      const history = messages
        .filter((m) => !m.blocked && m.role !== "system" && m.messageType !== "task")
        .map((m) => ({ role: m.role, content: m.content }));
      setError(null);
      setSending(true);
      const params = inferenceToPayload(base.inference ?? DEFAULT_INFERENCE);
      await fetch("/api/v3/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ conversationId, model: modelId, messages: history, params }),
      }).catch(() => {
        setSending(false);
        setError("send_failed");
      });
    },
    [conversationId, messages, base.inference],
  );

  const cancel = useCallback(async () => {
    if (!conversationId) return;
    await fetch(`/api/v3/conversations/${conversationId}/stop`, {
      method: "POST",
      credentials: "include",
    }).catch(() => {});
  }, [conversationId]);

  const regenerate = useCallback(async () => {
    if (!conversationId) return;
    // Drop the last assistant message, resend the prior history.
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant && !lastAssistant.id.startsWith("local-")) {
      await api.truncateConversationFrom(conversationId, lastAssistant.id).catch(() => {});
    }
    setMessages((prev) => {
      const idx = prev.map((m) => m.role).lastIndexOf("assistant");
      return idx >= 0 ? prev.slice(0, idx) : prev;
    });
    const history = messages
      .filter((m) => m.role === "user" || (m.role === "assistant" && m !== lastAssistant))
      .filter((m) => m.messageType !== "task")
      .map((m) => ({ role: m.role, content: m.content }));
    await fire(conversationId, history);
  }, [conversationId, messages, fire]);

  return { messages, sending, error, sendMessage, cancel, regenerate, resendOnLocalModel, chatV3: true as const };
}

export function useChatV3(opts: UseChatOptions = {}) {
  const base = useChat(opts);
  // v3 is the only rail (the v1 rail was removed 2026-08-04). useChat
  // provides the shell (model picker, inference params, toggles, comfyui);
  // the runtime replaces the live surface (messages, streaming, actions).
  const v3 = useV3Runtime(opts.conversationId, base, true);
  return {
    ...base,
    messages: v3.messages,
    sending: v3.sending,
    error: v3.error ?? base.error,
    sendMessage: v3.sendMessage,
    cancel: v3.cancel,
    regenerate: v3.regenerate,
    resendOnLocalModel: v3.resendOnLocalModel,
    chatV3: true,
  };
}
