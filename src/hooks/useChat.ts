import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  api,
  type ApiConversation,
  type ApiGlobalModel,
  type ApiMessage,
  type ApiProject,
  type ApiServer,
} from "~/lib/api";
import { streamChat, type ChatMessage } from "~/lib/chat-stream";
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
  maxTokens: 32768,
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

export type UIMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  streaming?: boolean;
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

export function useChat({ conversationId }: UseChatOptions = {}) {
  const navigate = useNavigate();

  const [servers, setServers] = useState<ApiServer[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [globalModels, setGlobalModels] = useState<ApiGlobalModel[]>([]);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ApiConversation | null>(
    null,
  );
  const [project, setProject] = useState<ApiProject | null>(null);
  type ModelSelection = { id: string; serverId: string | null };
  const [modelSelection, setModelSelection] = useState<ModelSelection>(() => {
    if (typeof window === "undefined") return { id: "auto", serverId: null };
    try {
      const raw = window.localStorage.getItem("thecompai:modelSelection");
      if (raw) {
        const parsed = JSON.parse(raw) as ModelSelection;
        if (parsed && typeof parsed.id === "string") return parsed;
      }
      // Migration from old shape (just a string)
      const old = window.localStorage.getItem("thecompai:model");
      if (old) return { id: old, serverId: null };
    } catch {
      // ignore
    }
    return { id: "auto", serverId: null };
  });

  const setModelAndPersist = useCallback((m: ModelSelection) => {
    setModelSelection(m);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        "thecompai:modelSelection",
        JSON.stringify(m),
      );
    }
  }, []);

  // When the user picks a specific model, the server it lives on becomes the
  // active server for chat. "auto" leaves the activeServer logic alone (first
  // server or whatever the conversation was tied to).
  useEffect(() => {
    if (modelSelection.serverId) {
      setActiveServerId(modelSelection.serverId);
    }
  }, [modelSelection.serverId]);

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
  // Holds the latest sendMessage closure so regenerate/editAndResend (defined
  // earlier) can call it without circular deps.
  const sendMessageRef = useRef<
    ((text: string, attachments?: Attachment[]) => Promise<void>) | null
  >(null);

  // Load servers once
  useEffect(() => {
    api
      .listServers()
      .then((data) => {
        setServers(data.servers);
        if (data.servers[0]) setActiveServerId(data.servers[0].id);
      })
      .catch((e) => setError(e.message));
    // Fetch global model list for capability detection (vision warning, etc.)
    // Non-critical: failures are silently ignored.
    api
      .listAllModels()
      .then(({ models }) => setGlobalModels(models))
      .catch(() => {});
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
        if (conversation.serverId) setActiveServerId(conversation.serverId);
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

  const activeServer =
    servers.find((s) => s.id === activeServerId) ?? servers[0] ?? null;

  // Capabilities of the currently-selected model (vision, tools). Used to
  // warn the user before they send an incompatible request (e.g. image on a
  // text-only model). Falls back to permissive defaults when unknown.
  const activeModelCapabilities: { vision: boolean; tools: boolean } =
    globalModels.find((m) => m.id === modelSelection.id)?.capabilities ??
    { vision: true, tools: false };

  const sendMessage = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      // Prefer the server attached to the user's picked model. Falls back to
      // the active server (set by conversation load or by hand). Without this,
      // picking an OpenRouter model on a conversation that was started with
      // exo would still send to exo and 404.
      const targetServerId =
        modelSelection.serverId ??
        activeServer?.id ??
        servers[0]?.id ??
        null;
      const targetServer =
        servers.find((s) => s.id === targetServerId) ?? activeServer;
      if (!targetServer || sending) return;
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
            serverId: targetServer.id,
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

      const userMsg: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: built.persistText,
      };
      const assistantId = crypto.randomUUID();
      const placeholder: UIMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
        streaming: true,
      };

      setMessages((prev) => [...prev, userMsg, placeholder]);
      setSending(true);

      // Update URL to /c/:id if we just created it (silent, no reload)
      if (!conversationId) {
        navigate(`/c/${convId}`, { replace: true });
      }

      // Persist user message (fire and forget — don't block the stream).
      // We persist the flat text version so the DB stays sane (no 5 MB image
      // data URLs); the multimodal version only goes to the model in-flight.
      api
        .appendMessage(convId, { role: "user", content: built.persistText })
        .catch((e) => console.warn("persist user failed", e));

      // Send prior messages as-is (they're plain strings on reload), and
      // attach the multimodal payload only on the new user turn.
      const convoForModel: ChatMessage[] = [
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: built.content },
      ];

      const controller = new AbortController();
      abortRef.current = controller;

      // If the conversation belongs to a project, its system prompt takes
      // precedence over the user's inference-panel one.
      const effectiveInference = inferenceToPayload(inference);
      if (project?.systemPrompt && project.systemPrompt.trim()) {
        effectiveInference.system_prompt = project.systemPrompt;
      }

      // Accumulate stream chunks in local closure vars rather than reading
      // them back out of React state. With React 19 concurrent rendering, a
      // setState updater can be deferred — so building `finalAssistant` from
      // *inside* a setMessages updater used to leave it null at persist time,
      // which is why assistant replies were never written to the DB.
      let streamedContent = "";
      let streamedReasoning = "";

      const result = await streamChat({
        serverId: targetServer.id,
        conversationId: convId ?? undefined,
        messages: convoForModel,
        model:
          modelSelection.id === "auto" ? undefined : modelSelection.id,
        inference: effectiveInference,
        signal: controller.signal,
        onDelta: (delta) => {
          if (delta.type === "reasoning") {
            streamedReasoning += delta.text;
          } else {
            streamedContent += delta.text;
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? {
                    ...m,
                    content: streamedContent,
                    reasoning: streamedReasoning || undefined,
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
              targetServer,
              modelSelection.id,
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
      const finalAssistant: UIMessage = {
        id: assistantId,
        role: "assistant",
        content: finalContent,
        reasoning: streamedReasoning || undefined,
        streaming: false,
        stats,
      };

      setMessages((prev) =>
        prev.map((m) => (m.id === assistantId ? finalAssistant : m)),
      );

      if (!result.ok) setError(result.error ?? null);

      // Persist the assistant message (best effort, fire and forget)
      if (convId && finalContent) {
        api
          .appendMessage(convId, {
            role: "assistant",
            content: finalContent,
            reasoning: streamedReasoning || undefined,
            stats: stats as Record<string, unknown> | undefined,
          })
          .catch((e) => console.warn("persist assistant failed", e));
      }
    },
    [
      activeServer,
      conversation?.id,
      conversationId,
      inference,
      messages,
      modelSelection.id,
      navigate,
      project,
      sending,
    ],
  );

  // Keep the ref in sync so regenerate / editAndResend can invoke the
  // latest closure without listing it as a dep (which would loop).
  sendMessageRef.current = sendMessage;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Drop the assistant reply for `assistantId` (and any later turns), then
   * resend the most recent user message to get a fresh answer.
   */
  const regenerate = useCallback(
    async (assistantId: string) => {
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx <= 0 || sending) return;
      // Find the user message that produced this assistant reply
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
          // best effort — server may have already deleted, or the id is local
        }
      }
      // Re-send. NB: we pass [] for attachments because the original
      // attachment data (image data URLs) only lived in-flight, not in DB.
      await sendMessageRef.current?.(userText, []);
    },
    [messages, sending, conversationId, conversation?.id],
  );

  /**
   * Edit a previous user message and re-run the conversation from there.
   */
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

  return {
    messages,
    sending,
    error,
    activeServer,
    servers,
    setActiveServerId,
    conversation,
    project,
    modelSelection,
    setModelSelection: setModelAndPersist,
    inference,
    setInference: updateInference,
    activeModelCapabilities,
    sendMessage,
    regenerate,
    editAndResend,
    cancel,
    startNew,
  };
}

function toUIMessage(m: ApiMessage): UIMessage {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    reasoning: m.reasoning ?? undefined,
    stats: (m.stats as UIMessage["stats"]) ?? undefined,
  };
}

/**
 * Best-effort cost display string.
 * - Local servers: always "$0.00 · local"
 * - Cloud (OpenRouter / Anthropic / OpenAI direct): look up price from the
 *   static table in model-pricing.ts. Falls back to "— · cloud" when the
 *   model isn't in the table.
 */
function estimateCost(
  server: ApiServer | null,
  model: string,
  prompt?: number,
  completion?: number,
): string {
  if (!server) return "$0.00 · local";
  const isCloud = /openrouter\.ai|anthropic\.com|openai\.com/.test(server.url);
  if (!isCloud) return "$0.00 · local";
  if (prompt !== undefined && completion !== undefined) {
    const cost = lookupCost(model, prompt, completion);
    if (cost !== null) return `${cost} · cloud`;
    // Model not in table — still show total tokens so it's not empty
    return `${prompt + completion} tok · cloud`;
  }
  return "— · cloud";
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
