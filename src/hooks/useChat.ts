import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  api,
  type ApiConversation,
  type ApiGlobalModel,
  type ApiMessage,
  type ApiProject,
} from "~/lib/api";
import { type ChatMessage } from "~/lib/chat-stream";
import { buildUserMessage, type Attachment } from "~/lib/file-attach";
import { estimateCost as lookupCost } from "~/lib/model-pricing";
import { StreamManager, type StreamEntry } from "~/lib/stream-manager";

/** Stable id for the in-flight assistant placeholder. The subscribe
 *  effect targets this id to patch content/reasoning/toolCalls as the
 *  stream progresses. Once the stream finishes and the conv is reloaded
 *  from DB, this placeholder is replaced by the real persisted message
 *  (with its UUID + stats). One stream per conversation → one placeholder
 *  per conversation → safe to share a constant. */
const LIVE_ID = "__live__";

export type InferenceParams = {
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  topP: number | null;
  topK: number | null;
  minP: number | null;
  repPenalty: number | null;
  seed: number | null;
  systemPrompt: string;
  systemPromptEnabled: boolean;
};

export const DEFAULT_INFERENCE: InferenceParams = {
  temperature: 0.7,
  maxTokens: 8192,
  thinking: false,
  reasoningEffort: "medium",
  topP: null,
  topK: null,
  minP: null,
  repPenalty: null,
  seed: null,
  systemPrompt: "",
  systemPromptEnabled: false,
};

export const STYLE_PRESETS: Record<
  "Creative" | "Normal" | "Code",
  Partial<InferenceParams>
> = {
  Creative: { temperature: 1.0, topP: 0.95, thinking: false },
  Normal: { temperature: 0.7, topP: null, thinking: false },
  Code: { temperature: 0.2, topP: 0.95, thinking: false },
};

export type ToolCallRecord = {
  name: string;
  /** Args may be absent on intermediate states (e.g. tool_start before
   *  the full arguments JSON has accumulated). The renderer should
   *  treat undefined as an empty object. */
  args?: Record<string, unknown>;
  /** Set once the tool finishes executing. */
  result?: {
    ok: boolean;
    summary: string;
    sources?: Array<{ title: string; url: string }>;
  };
};

export type UIMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  streaming?: boolean;
  /** ISO-8601 — set when the message is created locally (sendMessage) or
   *  loaded from the server (toUIMessage). Used by the chat client to send
   *  per-message timestamps so the backend can compute Δ tags. */
  createdAt?: string;
  /** Model id that produced this assistant message (set when the assistant
   *  reply lands). Shown as a badge under the message. */
  model?: string;
  /** Tool invocations the assistant made during this turn (web_search, etc). */
  toolCalls?: ToolCallRecord[];
  stats?: {
    ttft?: string;
    tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    /** Tokens served from the upstream's prefix cache (oMLX tiered KV
     *  cache, Anthropic prompt cache). 0 = cache miss. Surfaced as
     *  "Cached" in the StatsRow. */
    cachedTokens?: number;
    chunks?: number;
    durationMs?: number;
    speed?: string;
    cost?: string;
    /** Server-side echo of the model id used for this turn — lets the
     *  StatsRow show "Model: vlm:qwen3.6-35b" even after the page is
     *  reloaded and the live model picker state is gone. Set in chat.ts
     *  when the assistant message is persisted. */
    model?: string;
  };
};

export type UseChatOptions = {
  conversationId?: string;
};

const MODEL_LS_KEY = "thecompai:model";

export function useChat({ conversationId }: UseChatOptions = {}) {
  const navigate = useNavigate();

  const [globalModels, setGlobalModels] = useState<ApiGlobalModel[]>([]);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inferenceMode, setInferenceMode] = useState<
    "easy" | "advanced" | "expert"
  >("expert");
  const [easyModel, setEasyModel] = useState<string | null>(null);
  const [namedModels, setNamedModels] = useState<{
    conversation?: string;
    analyse?: string;
    engineer?: string;
    expert?: string;
  }>({});
  const [showMetrics, setShowMetrics] = useState(false);
  // Per-user picker hide list. Filtered out in easy mode; grayed
  // with an eye toggle elsewhere. PATCH'd back to /api/inference/settings
  // when the user clicks the toggle.
  const [hiddenModels, setHiddenModels] = useState<string[]>([]);
  // Pre-conversation memory override. Null = no override (use project
  // default / true on create). The TopBar memory toggle writes here when
  // no conversation exists yet so the user can flip memory OFF before
  // the first prompt; sendMessage forwards it to createConversation.
  // Reset on conversation load / cleared on navigation.
  const [pendingMemoryEnabled, setPendingMemoryEnabled] = useState<
    boolean | null
  >(null);
  const [conversation, setConversation] = useState<ApiConversation | null>(
    null,
  );
  const [project, setProject] = useState<ApiProject | null>(null);

  // Selected model — a single LiteLLM model id. Persisted in localStorage so
  // it survives reloads. Default falls back to inference settings → first
  // available model.
  const [model, setModel] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(MODEL_LS_KEY) ?? "";
  });
  const setModelAndPersist = useCallback((m: string) => {
    setModel(m);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODEL_LS_KEY, m);
    }
  }, []);

  const [inference, setInference] = useState<InferenceParams>(() => {
    if (typeof window === "undefined") return DEFAULT_INFERENCE;
    try {
      const raw = window.localStorage.getItem("thecompai:inference");
      if (raw) return { ...DEFAULT_INFERENCE, ...JSON.parse(raw) };
    } catch {
      // ignore
    }
    return DEFAULT_INFERENCE;
  });

  const updateInference = useCallback((patch: Partial<InferenceParams>) => {
    setInference((prev) => {
      const next = { ...prev, ...patch };
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          "thecompai:inference",
          JSON.stringify(next),
        );
      }
      return next;
    });
  }, []);


  const loadedIdRef = useRef<string | null>(null);
  const sendMessageRef = useRef<
    ((text: string, attachments?: Attachment[]) => Promise<void>) | null
  >(null);

  // Fetch the LiteLLM model list + the user's default model on mount. If the
  // user hasn't picked a model, default to inferenceSettings.defaultModel,
  // else the first available LiteLLM model.
  useEffect(() => {
    let cancelled = false;
    Promise.all([api.listAllModels(), api.inferenceSettings()])
      .then(([{ models }, settings]) => {
        if (cancelled) return;
        setGlobalModels(models);
        setInferenceMode(settings.inferenceMode);
        setEasyModel(settings.easyModel);
        setNamedModels(settings.namedModels ?? {});
        setShowMetrics(settings.showMetrics);
        setHiddenModels(settings.hiddenModels ?? []);

        // Choose a default model that respects the active mode.
        if (settings.inferenceMode === "easy") {
          // Easy mode forces the admin-set model, ignoring any local override.
          if (settings.easyModel) setModelAndPersist(settings.easyModel);
        } else if (settings.inferenceMode === "advanced") {
          // Advanced: if the persisted model isn't one of the 4 slots, default
          // to "conversation" (or the first non-empty slot).
          const slots = [
            settings.namedModels?.conversation,
            settings.namedModels?.analyse,
            settings.namedModels?.engineer,
            settings.namedModels?.expert,
          ].filter((v): v is string => Boolean(v && v.length > 0));
          if (!slots.includes(model)) {
            const fallback = slots[0] ?? settings.defaultModel ?? "";
            if (fallback) setModelAndPersist(fallback);
          }
        } else {
          // Expert: behave as before.
          if (!model) {
            const fallback = settings.defaultModel ?? models[0]?.id ?? "";
            if (fallback) setModelAndPersist(fallback);
          }
        }
      })
      .catch(() => {
        // Non-critical — chat will fail gracefully on send if no model.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load conversation when URL id changes — 3-case dispatch (Starbase /
  // ExoScopy pattern). The user can refresh, switch tab/conv, or open the
  // same conv from another device; we recover the right state in all three
  // cases.
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setConversation(null);
      // Clear any pre-conversation memory override when the user
      // returns to the "new chat" entry, so the next conv starts from
      // its project default (or true) instead of a stale pending flip.
      setPendingMemoryEnabled(null);
      loadedIdRef.current = null;
      return;
    }
    if (loadedIdRef.current === conversationId) return;

    loadedIdRef.current = conversationId;
    let serverPollAbort: (() => void) | null = null;

    api
      .getConversation(conversationId)
      .then(({ conversation, messages: msgs, inference }) => {
        setConversation(conversation);
        if (conversation.kind === "hermes") {
          setModel("hermes-agent");
        }
        if (conversation.projectId) {
          api
            .getProject(conversation.projectId)
            .then((r) => setProject(r.project))
            .catch(() => setProject(null));
        } else {
          setProject(null);
        }

        const clientStream = StreamManager.get(conversationId);
        const dbMessages = msgs.map(toUIMessage);

        if (clientStream && !clientStream.done) {
          // CASE 1 — client-side stream still running (we never left, or
          // came back during the pump). The subscribe effect below will
          // keep patching. Mount the live placeholder fed by the current
          // buffer so the user sees the in-flight content immediately.
          setMessages([
            ...dbMessages,
            buildLivePlaceholder(clientStream, conversation.model ?? null),
          ]);
          setSending(true);
        } else if (clientStream && clientStream.done) {
          // CASE 2 — client-side stream finished while we were away. DB
          // has the persisted message (Phase 2 server-side persist). Drop
          // the in-memory entry.
          setMessages(dbMessages);
          StreamManager.cleanup(conversationId);
          setSending(false);
        } else if (inference && inference.active) {
          // CASE 3 — no client stream, but the server is still pumping
          // (typically: same conv opened from another tab/device, or this
          // tab refreshed mid-stream). Render the server buffer + poll
          // /:id/inference until done, then reload from DB.
          setMessages([
            ...dbMessages,
            buildLivePlaceholderFromServer(
              inference,
              conversation.model ?? null,
            ),
          ]);
          setSending(true);
          serverPollAbort = pollServerInferenceUntilDone(
            conversationId,
            (latest) => {
              if (loadedIdRef.current !== conversationId) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === LIVE_ID
                    ? {
                        ...m,
                        content: latest.content,
                        reasoning: latest.reasoning || undefined,
                      }
                    : m,
                ),
              );
            },
            async () => {
              if (loadedIdRef.current !== conversationId) return;
              try {
                const fresh = await api.getConversation(conversationId);
                setMessages(fresh.messages.map(toUIMessage));
                setConversation(fresh.conversation);
              } catch {
                // ignore — UI will catch up on next conv reopen
              }
              setSending(false);
              api
                .clearInference(conversationId)
                .catch(() => undefined);
            },
          );
        } else {
          // CASE 0 — no stream anywhere. Just show what's in DB.
          setMessages(dbMessages);
          setSending(false);
        }
      })
      .catch((e) => setError(e.message));

    return () => {
      serverPollAbort?.();
    };
    // sending intentionally excluded — we only want this effect on conv
    // change. The subscribe effect tracks the live stream separately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  // Subscribe to the active StreamManager entry for this conversation.
  // Patches the LIVE_ID placeholder with content / reasoning / tool calls
  // as the pump emits them. On done, reload from DB to pick up the real
  // persisted assistant message (with its UUID, server-stamped stats)
  // and drop the in-memory entry.
  useEffect(() => {
    if (!conversationId) return;
    const cid = conversationId;
    // Track which stream we've already torn down (by startedAt). A plain
    // boolean would stick across sends in the same conversation (effect
    // doesn't re-mount when conversationId is unchanged), so the 2nd done
    // would never fire setSending(false). Each send creates a new entry
    // with a fresh startedAt — that's our identity key.
    let lastHandledStart: number | null = null;
    const unsub = StreamManager.subscribe(cid, (entry) => {
      setMessages((prev) => {
        const hasLive = prev.some((m) => m.id === LIVE_ID);
        const liveMsg: UIMessage = {
          id: LIVE_ID,
          role: "assistant",
          content: entry.content,
          reasoning: entry.reasoning || undefined,
          toolCalls:
            entry.toolCalls.length > 0 ? entry.toolCalls : undefined,
          streaming: !entry.done,
          model: model ?? undefined,
        };
        if (hasLive) {
          return prev.map((m) => (m.id === LIVE_ID ? liveMsg : m));
        }
        // Race: server stream still being subscribed to but our placeholder
        // got dropped by a DB reload that arrived after the cleanup. Re-mount.
        return [...prev, liveMsg];
      });
      if (entry.done && entry.startedAt !== lastHandledStart) {
        lastHandledStart = entry.startedAt;
        if (entry.error) setError(entry.error);
        // Capture the stream identity we're tearing down. Between this
        // setTimeout being armed and firing, the user may have sent the
        // next turn — which replaces the entry under the same convId
        // with a fresh startedAt. If we naively reload from DB at that
        // point we'd overwrite the new turn's LIVE_ID placeholder with
        // a DB snapshot that doesn't yet contain the new assistant
        // message — content disappears mid-stream from the user's POV.
        // So: before doing anything destructive, confirm we're still
        // tearing down the same stream.
        const teardownStart = entry.startedAt;
        // Tiny delay so any final notify lands before we tear down.
        setTimeout(async () => {
          const current = StreamManager.get(cid);
          if (current && current.startedAt !== teardownStart) {
            // A new stream has taken over — skip the teardown so the
            // new stream's live placeholder + sending state survive.
            return;
          }
          try {
            const fresh = await api.getConversation(cid);
            if (loadedIdRef.current === cid) {
              setMessages(fresh.messages.map(toUIMessage));
              setConversation(fresh.conversation);
            }
          } catch {
            // ignore — old placeholder stays visible until next reopen
          }
          StreamManager.cleanup(cid);
          api.clearInference(cid).catch(() => undefined);
          setSending(false);
        }, 300);
      }
    });
    return unsub;
  }, [conversationId, model]);

  // Prewarm the upstream KV cache when the user opens a conversation or
  // switches models. We fire a 1-token completion at the upstream with the
  // exact prompt prefix the next chat turn will use; EXO populates its
  // prefix-cache slot during this idle window. By the time the user types
  // their next message, the prefix is already cached → TTFT plummets.
  //
  // - Skipped for empty conversations (nothing useful to cache yet).
  // - Skipped while a real request is in flight (don't double-load EXO).
  // - Debounced 600ms so rapid model toggles don't fire many prewarms.
  useEffect(() => {
    if (!conversationId) return;
    if (!model) return;
    if (sending) return;
    if (messages.length === 0) return;
    const t = setTimeout(() => {
      api
        .prewarmConversation(conversationId, {
          model,
          ...(inference.systemPromptEnabled && inference.systemPrompt
            ? { system_prompt: inference.systemPrompt }
            : {}),
        })
        .catch(() => undefined);
    }, 200);
    return () => clearTimeout(t);
    // We intentionally exclude `inference.systemPrompt` itself from deps —
    // every keystroke in settings would otherwise trigger a prewarm. The
    // user's stable choice (enabled + saved) is what matters; the next
    // real chat will warm the right prefix anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, model, sending, messages.length]);

  const activeModelCapabilities: { vision: boolean; tools: boolean } =
    globalModels.find((m) => m.id === model)?.capabilities ??
    { vision: true, tools: false };

  const sendMessage = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      if (sending) return;
      if (!model) {
        setError(
          "No model selected. Pick one from the model picker in the composer.",
        );
        return;
      }
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;

      const built = buildUserMessage(trimmed, attachments);
      setError(null);

      // Ensure we have a conversation to write into
      let convId = conversationId ?? conversation?.id ?? null;
      const titleSeed =
        trimmed || attachments.map((a) => a.name).join(", ") || "New";
      if (!convId) {
        try {
          const created = await api.createConversation({
            title: titleSeed.slice(0, 80),
            // Honour the TopBar memory toggle if the user flipped it
            // before sending the first message. Otherwise the server
            // inherits from the project (or defaults to true).
            ...(pendingMemoryEnabled !== null
              ? { memoryEnabled: pendingMemoryEnabled }
              : {}),
          });
          convId = created.conversation.id;
          setConversation(created.conversation);
          loadedIdRef.current = convId;
          // Reset pending state — it's now persisted on the conversation.
          setPendingMemoryEnabled(null);
        } catch (e) {
          setError((e as Error).message);
          return;
        }
      }

      const nowIso = new Date().toISOString();
      const userMsg: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: built.persistText,
        createdAt: nowIso,
      };

      // Optimistic UI: user message + LIVE_ID placeholder. The placeholder
      // is patched by the subscribe useEffect (below) as the StreamManager
      // emits content / reasoning / tool_calls. Once the stream finishes,
      // the conv is reloaded from DB which has the persisted message and
      // overwrites this placeholder.
      const livePlaceholder: UIMessage = {
        id: LIVE_ID,
        role: "assistant",
        content: "",
        streaming: true,
        model,
      };
      setMessages((prev) => [...prev, userMsg, livePlaceholder]);
      setSending(true);

      if (!conversationId) {
        navigate(`/c/${convId}`, { replace: true });
      }

      // Persist user message immediately so a later /:id reload sees it
      // even if this tab dies before the stream finishes.
      api
        .appendMessage(convId, {
          role: "user",
          content: built.persistText,
          createdAt: nowIso,
        })
        .catch((e) => console.warn("persist user failed", e));

      // Pass per-message createdAt so the backend can compute Δ tags
      // for historical messages too. The latest user message uses NOW.
      const convoForModel: ChatMessage[] = [
        ...messages.map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
        { role: "user", content: built.content, createdAt: nowIso },
      ];

      const effectiveInference = inferenceToPayload(inference);
      if (project?.systemPrompt && project.systemPrompt.trim()) {
        effectiveInference.system_prompt = project.systemPrompt;
      }

      // Fire the stream and return immediately. The pump runs inside
      // StreamManager (singleton, survives this component's unmount). The
      // subscribe useEffect catches every delta + the final done event,
      // and the server-side inference-state module persists the assistant
      // message to DB when the stream completes (chat.ts finally block).
      StreamManager.startStream({
        conversationId: convId,
        messages: convoForModel,
        model,
        inference: effectiveInference,
      });
    },
    [
      conversation?.id,
      conversationId,
      inference,
      messages,
      model,
      navigate,
      project,
      sending,
      pendingMemoryEnabled,
    ],
  );

  sendMessageRef.current = sendMessage;

  const cancel = useCallback(() => {
    const cid = conversationId ?? conversation?.id;
    if (cid) {
      StreamManager.stop(cid);
      // Also clear the server-side buffer so /inference returns
      // { active: false } on the next poll. The chat.ts cleanup timeout
      // (60s) would do it eventually but explicit clear is snappier.
      api.clearInference(cid).catch(() => undefined);
    }
  }, [conversationId, conversation?.id]);

  const regenerate = useCallback(
    async (assistantId: string) => {
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx <= 0 || sending) return;
      let userIdx = idx - 1;
      while (userIdx >= 0 && messages[userIdx].role !== "user") userIdx--;
      if (userIdx < 0) return;
      const userText = messages[userIdx].content;
      const trimmed = messages.slice(0, userIdx);
      setMessages(trimmed);
      const convId = conversationId ?? conversation?.id ?? null;
      if (convId) {
        try {
          await api.truncateConversationFrom(convId, assistantId);
        } catch {
          // best effort
        }
      }
      await sendMessageRef.current?.(userText, []);
    },
    [messages, sending, conversationId, conversation?.id],
  );

  const editAndResend = useCallback(
    async (messageId: string, newText: string) => {
      const idx = messages.findIndex((m) => m.id === messageId);
      if (idx < 0 || sending) return;
      if (messages[idx].role !== "user") return;
      const trimmed = messages.slice(0, idx);
      setMessages(trimmed);
      const convId = conversationId ?? conversation?.id ?? null;
      if (convId) {
        try {
          await api.truncateConversationFrom(convId, messageId);
        } catch {
          // best effort
        }
      }
      await sendMessageRef.current?.(newText, []);
    },
    [messages, sending, conversationId, conversation?.id],
  );

  const startNew = useCallback(() => {
    navigate("/");
  }, [navigate]);

  const toggleMemoryEnabled = useCallback(async () => {
    // Pre-conversation: no row to PATCH yet, just flip the pending flag.
    // The current value comes from the existing pending state, falling
    // back to the project default (true). Persisted at conv creation
    // in sendMessage.
    if (!conversation) {
      setPendingMemoryEnabled((prev) => !(prev ?? true));
      return;
    }
    const next = !conversation.memoryEnabled;
    // Optimistic — flip locally so the UI feels snappy. Roll back on error.
    setConversation({ ...conversation, memoryEnabled: next });
    try {
      const r = await api.setConversationMemoryEnabled(conversation.id, next);
      setConversation(r.conversation);
    } catch (e) {
      setConversation(conversation);
      setError((e as Error).message);
    }
  }, [conversation]);

  const toggleAgentMode = useCallback(async () => {
    if (!conversation) return;
    const next = !(conversation.agentMode ?? false);
    setConversation({ ...conversation, agentMode: next });
    try {
      const r = await api.setConversationAgentMode(conversation.id, next);
      setConversation(r.conversation);
    } catch (e) {
      setConversation(conversation);
      setError((e as Error).message);
    }
  }, [conversation]);

  /**
   * Force a re-fetch of the active conversation. Useful for Talk mode,
   * where messages are appended out-of-band by VoiceLiveOverlay rather
   * than via sendMessage(), so the local cache wouldn't otherwise know
   * the message store grew.
   */
  const reload = useCallback(async () => {
    if (!conversationId) return;
    try {
      const { conversation: conv, messages: msgs } =
        await api.getConversation(conversationId);
      setConversation(conv);
      setMessages(msgs.map(toUIMessage));
    } catch {
      // ignore
    }
  }, [conversationId]);

  /** Flip a model id's hidden state. Optimistic local update + PATCH
   *  back to /api/inference/settings. Errors are silently logged —
   *  the next reload will reconcile from the server. */
  const toggleModelHidden = useCallback(
    async (id: string) => {
      const next = hiddenModels.includes(id)
        ? hiddenModels.filter((x) => x !== id)
        : [...hiddenModels, id];
      setHiddenModels(next);
      try {
        await api.updateInferenceSettings({ hiddenModels: next });
      } catch (e) {
        console.warn("[useChat] toggleModelHidden patch failed:", (e as Error).message);
      }
    },
    [hiddenModels],
  );

  return {
    messages,
    sending,
    error,
    conversation,
    project,
    model,
    setModel: setModelAndPersist,
    globalModels,
    inferenceMode,
    easyModel,
    namedModels,
    showMetrics,
    hiddenModels,
    toggleModelHidden,
    inference,
    setInference: updateInference,
    activeModelCapabilities,
    sendMessage,
    regenerate,
    editAndResend,
    cancel,
    startNew,
    toggleMemoryEnabled,
    toggleAgentMode,
    reload,
    /** Effective memory toggle: persisted conv value when the conv
     *  exists, else the pre-conversation pending override, else true. */
    memoryEnabled:
      conversation?.memoryEnabled ?? pendingMemoryEnabled ?? true,
  };
}

/**
 * Build a UIMessage placeholder fed by the current client-side stream
 * entry. Used on conv reopen (CASE 1) so the user immediately sees the
 * in-flight content before the subscribe effect kicks in for the next
 * delta.
 */
function buildLivePlaceholder(
  entry: StreamEntry,
  fallbackModel: string | null,
): UIMessage {
  return {
    id: LIVE_ID,
    role: "assistant",
    content: entry.content,
    reasoning: entry.reasoning || undefined,
    toolCalls: entry.toolCalls.length > 0 ? entry.toolCalls : undefined,
    streaming: !entry.done,
    model: fallbackModel ?? undefined,
  };
}

/**
 * Build a UIMessage placeholder fed by the server-side inference state
 * (CASE 3 — we have no client stream but the server is pumping). The
 * polling loop below patches `content` as new bytes arrive.
 */
function buildLivePlaceholderFromServer(
  inf: {
    active: boolean;
    done: boolean;
    content: string;
    reasoning: string;
    error: string | null;
  },
  fallbackModel: string | null,
): UIMessage {
  return {
    id: LIVE_ID,
    role: "assistant",
    content: inf.content,
    reasoning: inf.reasoning || undefined,
    streaming: !inf.done,
    model: fallbackModel ?? undefined,
  };
}

/**
 * Poll /:id/inference every second until `active === false`. Calls
 * `onProgress` for each refresh with content, and `onDone` once when
 * the server reports done so the caller can reload from DB. Cancellable.
 *
 * 5-min cap covers even slow Hermes loops; beyond that, the user almost
 * certainly closed the tab and we stop wasting cycles.
 */
function pollServerInferenceUntilDone(
  conversationId: string,
  onProgress: (latest: {
    content: string;
    reasoning: string;
  }) => void,
  onDone: () => void,
): () => void {
  const INTERVAL_MS = 1_000;
  const TIMEOUT_MS = 5 * 60_000;
  let stopped = false;
  let firedDone = false;
  const startedAt = Date.now();

  async function tick() {
    if (stopped) return;
    try {
      const r = await api.getInference(conversationId);
      if (stopped) return;
      if (r.active === false) {
        if (!firedDone) {
          firedDone = true;
          onDone();
        }
        stopped = true;
        return;
      }
      onProgress({ content: r.content, reasoning: r.reasoning });
      if (r.done) {
        if (!firedDone) {
          firedDone = true;
          onDone();
        }
        stopped = true;
        return;
      }
    } catch {
      // ignore — transient
    }
    if (Date.now() - startedAt >= TIMEOUT_MS) {
      stopped = true;
      return;
    }
    setTimeout(tick, INTERVAL_MS);
  }
  setTimeout(tick, INTERVAL_MS);

  return () => {
    stopped = true;
  };
}

function toUIMessage(m: ApiMessage): UIMessage {
  const stats = (m.stats as UIMessage["stats"]) ?? undefined;
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? undefined,
    createdAt: m.createdAt,
    // Surface the model id at the message level too, so the StatsRow
    // can show it for DB-loaded messages where the live model state
    // isn't available anymore.
    model: stats?.model,
    stats,
  };
}

// estimateCost helper removed — stats are now produced server-side
// in chat.ts when the inference-state buffer commits the assistant
// message. If we want the cost back as a display field, it should be
// computed in the persist callback and stored alongside other stats.
// `lookupCost` from model-pricing.ts is still available there.
void lookupCost;

function inferenceToPayload(i: InferenceParams) {
  return {
    temperature: i.temperature,
    max_tokens: i.maxTokens,
    top_p: i.topP,
    top_k: i.topK,
    min_p: i.minP,
    repetition_penalty: i.repPenalty,
    seed: i.seed,
    thinking: i.thinking,
    reasoning_effort: i.reasoningEffort,
    system_prompt: i.systemPromptEnabled ? i.systemPrompt : undefined,
  };
}
