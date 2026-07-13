/**
 * StreamManager — singleton that owns all in-flight chat SSE streams.
 *
 * Lives OUTSIDE the React tree. A stream created by useChat keeps running
 * after the component that started it unmounts (e.g. when the user
 * navigates to another conversation). When the user returns, useChat
 * re-subscribes to the same entry and re-renders from the current buffer.
 *
 * Pattern lifted from Starbase / ExoScopy (`window._streams` + subscribe).
 * Replaces the previous in-component `streamChat` + AbortController +
 * post-hoc client-side `api.appendMessage('assistant', …)` flow which lost
 * the response on tab-switch.
 *
 * Server-side persistence is handled by `chat.ts` via the inference-state
 * module — this client only displays. Once a stream finishes, the client
 * reloads the conversation from DB to pick up the persisted assistant
 * message with its real id + stats, then cleanups its in-memory copy.
 */

import {
  streamChat,
  type ChatMessage,
  type InferencePayload,
  type StreamChatResult,
  type StreamDelta,
} from "~/lib/chat-stream";
import { emitFileChanged } from "~/lib/file-events";

export type StreamToolCall = {
  name: string;
  args?: Record<string, unknown>;
  result?: {
    ok: boolean;
    summary: string;
    sources?: Array<{ title: string; url: string }>;
  };
};

export type GuardWarning = {
  severity: "low" | "medium" | "high";
  findings: Array<{ category: string; severity: string; spans: string[] }>;
  forcedLocal: boolean;
  forcedModel: string | null;
};

export type StreamEntry = {
  conversationId: string;
  content: string;
  reasoning: string;
  toolCalls: StreamToolCall[];
  /** Confidential Guard verdict for this turn (null = clean / add-on off). */
  guard: GuardWarning | null;
  /** True once the pump promise resolves (success OR error OR abort). */
  done: boolean;
  /** Set when the pump rejected with a non-abort error. */
  error: string | null;
  /** Filled when the pump resolved with `result.ok === true`. */
  stats: StreamChatResult | null;
  /** Used by stop() — opens the door for the user to cancel mid-stream. */
  controller: AbortController;
  startedAt: number;
  /** Wall-clock of first content delta. Used to compute TTFT locally
   *  when the server didn't send usage. */
  firstContentAt: number | null;
};

type Listener = (entry: StreamEntry) => void;
type GlobalListener = (activeIds: string[]) => void;

export type StreamStartOptions = {
  conversationId: string;
  messages: ChatMessage[];
  model: string;
  inference?: InferencePayload | null;
};

class StreamManagerImpl {
  private streams = new Map<string, StreamEntry>();
  private listeners = new Map<string, Set<Listener>>();
  private globalListeners = new Set<GlobalListener>();

  /**
   * Start a stream for a conversation. Returns immediately — the pump
   * runs in the background. Idempotent: a second call while the same
   * conversation is already streaming returns the existing entry.
   */
  startStream(opts: StreamStartOptions): StreamEntry {
    const existing = this.streams.get(opts.conversationId);
    if (existing && !existing.done) return existing;

    const controller = new AbortController();
    const entry: StreamEntry = {
      conversationId: opts.conversationId,
      content: "",
      reasoning: "",
      toolCalls: [],
      guard: null,
      done: false,
      error: null,
      stats: null,
      controller,
      startedAt: Date.now(),
      firstContentAt: null,
    };
    this.streams.set(opts.conversationId, entry);
    this.notifyGlobal();
    this.pump(entry, opts).catch(() => {
      // pump catches its own errors; this is only here to silence the
      // unhandled-rejection warning if something slips through.
    });
    return entry;
  }

  private async pump(
    entry: StreamEntry,
    opts: StreamStartOptions,
  ): Promise<void> {
    const onDelta = (delta: StreamDelta) => {
      if (delta.type === "content") {
        if (!entry.firstContentAt) entry.firstContentAt = Date.now();
        entry.content += delta.text;
      } else if (delta.type === "reasoning") {
        entry.reasoning += delta.text;
      } else if (delta.type === "tool_start") {
        entry.toolCalls = [
          ...entry.toolCalls,
          ...delta.calls.map((c) => ({ name: c.name, args: c.args })),
        ];
      } else if (delta.type === "tool_done") {
        // Match by ordinal — tool_start/tool_done arrive in order.
        const startIdx = entry.toolCalls.length - delta.calls.length;
        entry.toolCalls = entry.toolCalls.map((tc, i) => {
          const matchIdx = i - startIdx;
          if (matchIdx < 0 || matchIdx >= delta.calls.length) return tc;
          return { ...tc, result: delta.calls[matchIdx].result };
        });
      } else if (delta.type === "guard_warning") {
        entry.guard = {
          severity: delta.severity,
          findings: delta.findings,
          forcedLocal: delta.forcedLocal,
          forcedModel: delta.forcedModel,
        };
      } else if (delta.type === "file_changed") {
        // Notify FilesPage / workspace listeners. Not part of the visible
        // entry state so we don't bother calling notify() for this.
        emitFileChanged(delta.path);
        return;
      }
      this.notify(entry.conversationId);
    };

    try {
      const result = await streamChat({
        conversationId: opts.conversationId,
        messages: opts.messages,
        model: opts.model,
        inference: opts.inference,
        signal: entry.controller.signal,
        onDelta,
      });
      entry.stats = result;
      if (!result.ok) entry.error = result.error ?? "stream failed";
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // user-initiated stop — no error to surface
      } else {
        entry.error = (e as Error).message;
      }
    } finally {
      entry.done = true;
      this.notify(entry.conversationId);
      this.notifyGlobal();
    }
  }

  /** Cancel a stream. The server keeps pumping into its in-memory buffer
   *  unless the user also calls /:id/inference/clear, so this is a UI
   *  gesture rather than a hard kill. */
  stop(conversationId: string): void {
    const entry = this.streams.get(conversationId);
    if (entry && !entry.done) {
      entry.controller.abort();
      // The pump's finally block will mark done + notify.
    }
  }

  subscribe(conversationId: string, fn: Listener): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.listeners.set(conversationId, set);
    }
    set.add(fn);
    // Immediate fire with the current state so the subscriber doesn't
    // need to call get() separately.
    const entry = this.streams.get(conversationId);
    if (entry) {
      try {
        fn(entry);
      } catch {
        // ignore
      }
    }
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(conversationId);
    };
  }

  onGlobal(fn: GlobalListener): () => void {
    this.globalListeners.add(fn);
    try {
      fn(this.getActiveIds());
    } catch {
      // ignore
    }
    return () => {
      this.globalListeners.delete(fn);
    };
  }

  get(conversationId: string): StreamEntry | null {
    return this.streams.get(conversationId) ?? null;
  }

  isActive(conversationId: string): boolean {
    const e = this.streams.get(conversationId);
    return !!e && !e.done;
  }

  getActiveIds(): string[] {
    const out: string[] = [];
    for (const [id, entry] of this.streams) {
      if (!entry.done) out.push(id);
    }
    return out;
  }

  /** Drop the in-memory entry. Call after the client has reloaded the
   *  conversation from DB to pick up the persisted final message. */
  cleanup(conversationId: string): void {
    const e = this.streams.get(conversationId);
    if (!e) return;
    if (!e.done) {
      // Defensive — never drop an in-flight entry, else its pump will
      // try to notify a Map that no longer has it.
      return;
    }
    this.streams.delete(conversationId);
    this.notifyGlobal();
  }

  private notify(conversationId: string): void {
    const entry = this.streams.get(conversationId);
    const subs = this.listeners.get(conversationId);
    if (!entry || !subs) return;
    for (const fn of subs) {
      try {
        fn(entry);
      } catch {
        // ignore
      }
    }
  }

  private notifyGlobal(): void {
    const ids = this.getActiveIds();
    for (const fn of this.globalListeners) {
      try {
        fn(ids);
      } catch {
        // ignore
      }
    }
  }
}

export const StreamManager = new StreamManagerImpl();
