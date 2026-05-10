import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  api,
  type ApiConversation,
  type ApiGlobalModel,
  type ApiMessage,
  type ApiProject,
} from "~/lib/api";
import { streamChat, type ChatMessage } from "~/lib/chat-stream";
import { emitFileChanged } from "~/lib/file-events";
import { buildUserMessage, type Attachment } from "~/lib/file-attach";
import { estimateCost as lookupCost } from "~/lib/model-pricing";

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
  args: Record<string, unknown>;
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
    chunks?: number;
    durationMs?: number;
    speed?: string;
    cost?: string;
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
  const abortRef = useRef<AbortController | null>(null);
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

  // Load conversation when URL id changes
  useEffect(() => {
    if (!conversationId) {
      setMessages([]);
      setConversation(null);
      loadedIdRef.current = null;
      return;
    }
    if (loadedIdRef.current === conversationId) return;

    loadedIdRef.current = conversationId;
    api
      .getConversation(conversationId)
      .then(({ conversation, messages: msgs }) => {
        setConversation(conversation);
        setMessages(msgs.map(toUIMessage));
        // Hermes conversations have no model picker — pin the model state
        // so sendMessage's "no model selected" guard doesn't silently
        // swallow user input. The backend ignores this value and uses
        // the gateway's configured model.
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
      })
      .catch((e) => setError(e.message));
  }, [conversationId]);

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
          });
          convId = created.conversation.id;
          setConversation(created.conversation);
          loadedIdRef.current = convId;
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
      const assistantId = crypto.randomUUID();
      const placeholder: UIMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        streaming: true,
        model,
      };

      setMessages((prev) => [...prev, userMsg, placeholder]);
      setSending(true);

      if (!conversationId) {
        navigate(`/c/${convId}`, { replace: true });
      }

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

      const controller = new AbortController();
      abortRef.current = controller;

      const effectiveInference = inferenceToPayload(inference);
      if (project?.systemPrompt && project.systemPrompt.trim()) {
        effectiveInference.system_prompt = project.systemPrompt;
      }

      let streamedContent = "";
      let streamedReasoning = "";
      let toolCalls: ToolCallRecord[] = [];

      const result = await streamChat({
        conversationId: convId ?? undefined,
        messages: convoForModel,
        model,
        inference: effectiveInference,
        signal: controller.signal,
        onDelta: (delta) => {
          if (delta.type === "reasoning") {
            streamedReasoning += delta.text;
          } else if (delta.type === "content") {
            streamedContent += delta.text;
          } else if (delta.type === "tool_start") {
            // Append placeholder records (result fills in on tool_done).
            toolCalls = [
              ...toolCalls,
              ...delta.calls.map((c) => ({ name: c.name, args: c.args })),
            ];
          } else if (delta.type === "tool_done") {
            // Match by ordinal — tool_start and tool_done arrive in order.
            const startIdx = toolCalls.length - delta.calls.length;
            toolCalls = toolCalls.map((tc, i) => {
              const matchIdx = i - startIdx;
              if (matchIdx < 0 || matchIdx >= delta.calls.length) return tc;
              return { ...tc, result: delta.calls[matchIdx].result };
            });
          } else if (delta.type === "file_changed") {
            // Notify any FilesPage / hook subscribed for live refresh.
            emitFileChanged(delta.path);
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: streamedContent,
                    reasoning: streamedReasoning || undefined,
                    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
                  }
                : m,
            ),
          );
        },
      });

      abortRef.current = null;
      setSending(false);

      const aborted = controller.signal.aborted;
      const stats = result.ok
        ? {
            ttft:
              result.ttftMs !== undefined ? `${result.ttftMs}ms` : undefined,
            tokens: result.tokens,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            reasoningTokens: result.reasoningTokens,
            chunks: result.chunks,
            durationMs: result.durationMs,
            speed:
              result.durationMs && (result.completionTokens ?? result.tokens)
                ? `${(((result.completionTokens ?? result.tokens ?? 0) / result.durationMs) * 1000).toFixed(1)} tok/s`
                : undefined,
            cost: estimateCost(
              model,
              result.promptTokens,
              result.completionTokens,
            ),
          }
        : undefined;
      const finalContent =
        !result.ok && !streamedContent
          ? aborted
            ? "⏹ Stopped"
            : `⚠︎ ${result.error ?? "Couldn't reach the engine."}`
          : streamedContent;
      const assistantCreatedAt = new Date().toISOString();
      const finalAssistant: UIMessage = {
        id: assistantId,
        role: "assistant",
        content: finalContent,
        reasoning: streamedReasoning || undefined,
        streaming: false,
        model,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        stats,
        createdAt: assistantCreatedAt,
      };

      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? finalAssistant : m)),
      );

      if (!result.ok) setError(result.error ?? null);

      if (convId && finalContent) {
        api
          .appendMessage(convId, {
            role: "assistant",
            content: finalContent,
            reasoning: streamedReasoning || undefined,
            stats: stats as Record<string, unknown> | undefined,
            createdAt: assistantCreatedAt,
          })
          .catch((e) => console.warn("persist assistant failed", e));
      }
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
    ],
  );

  sendMessageRef.current = sendMessage;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
    if (!conversation) return;
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
    inference,
    setInference: updateInference,
    activeModelCapabilities,
    sendMessage,
    regenerate,
    editAndResend,
    cancel,
    startNew,
    toggleMemoryEnabled,
    reload,
  };
}

function toUIMessage(m: ApiMessage): UIMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? undefined,
    createdAt: m.createdAt,
    stats: (m.stats as UIMessage["stats"]) ?? undefined,
  };
}

/**
 * Best-effort cost display string.
 * Looks up the static price table for known cloud model ids; otherwise
 * shows token count or "$0.00".
 */
function estimateCost(
  model: string,
  prompt?: number,
  completion?: number,
): string {
  if (prompt !== undefined && completion !== undefined) {
    const cost = lookupCost(model, prompt, completion);
    if (cost !== null) return `${cost}`;
    return `${prompt + completion} tok`;
  }
  return "—";
}

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
