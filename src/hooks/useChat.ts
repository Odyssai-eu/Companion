import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  api,
  type ApiConversation,
  type ApiMessage,
  type ApiProject,
  type ApiServer,
} from "~/lib/api";
import { streamChat, type ChatMessage } from "~/lib/chat-stream";
import { buildUserMessage, type Attachment } from "~/lib/file-attach";

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

  // Load servers once
  useEffect(() => {
    api
      .listServers()
      .then((data) => {
        setServers(data.servers);
        if (data.servers[0]) setActiveServerId(data.servers[0].id);
      })
      .catch((e) => setError(e.message));
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

      const result = await streamChat({
        serverId: targetServer.id,
        messages: convoForModel,
        model:
          modelSelection.id === "auto" ? undefined : modelSelection.id,
        inference: effectiveInference,
        signal: controller.signal,
        onDelta: (delta) => {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantId) return m;
              if (delta.type === "reasoning") {
                return { ...m, reasoning: (m.reasoning ?? "") + delta.text };
              }
              return { ...m, content: m.content + delta.text };
            }),
          );
        },
      });

      abortRef.current = null;
      setSending(false);

      // Snapshot the final assistant message from state to persist
      let finalAssistant: UIMessage | null = null;
      setMessages((prev) => {
        const next = prev.map((m) => {
          if (m.id !== assistantId) return m;
          const stats = result.ok
            ? {
                ttft:
                  result.ttftMs !== undefined
                    ? `${result.ttftMs}ms`
                    : undefined,
                tokens: result.tokens,
                speed:
                  result.durationMs && result.tokens
                    ? `${((result.tokens / result.durationMs) * 1000).toFixed(1)} tok/s`
                    : undefined,
                cost: "$0.00 · local",
              }
            : undefined;
          const aborted = controller.signal.aborted;
          const finalContent =
            !result.ok && !m.content
              ? aborted
                ? "⏹ Stopped"
                : `⚠︎ ${result.error ?? "Couldn't reach the engine."}`
              : m.content;
          const updated = {
            ...m,
            content: finalContent,
            streaming: false,
            stats,
          };
          finalAssistant = updated;
          return updated;
        });
        return next;
      });

      if (!result.ok) setError(result.error ?? null);

      // Persist the assistant message (best effort)
      if (finalAssistant && convId) {
        const msg = finalAssistant as UIMessage;
        api
          .appendMessage(convId, {
            role: "assistant",
            content: msg.content,
            reasoning: msg.reasoning,
            stats: msg.stats as Record<string, unknown> | undefined,
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

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

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
    sendMessage,
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
