import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat, type ChatMessage } from "~/lib/chat-stream";
import { api, type ApiServer } from "~/lib/api";

export type UIMessage = {
  id: string;
  role: "user" | "assistant";
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

export function useChat() {
  const [servers, setServers] = useState<ApiServer[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    api
      .listServers()
      .then((data) => {
        setServers(data.servers);
        if (data.servers[0]) setActiveServerId(data.servers[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  const activeServer =
    servers.find((s) => s.id === activeServerId) ?? servers[0] ?? null;

  const sendMessage = useCallback(
    async (text: string) => {
      if (!activeServer || sending) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      setError(null);
      const userMsg: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
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

      const convoForModel: ChatMessage[] = [...messages, userMsg].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const controller = new AbortController();
      abortRef.current = controller;

      const result = await streamChat({
        serverId: activeServer.id,
        messages: convoForModel,
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

      if (!result.ok) {
        setError(result.error ?? "Stream failed");
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content:
                    m.content ||
                    `⚠︎ ${result.error ?? "Couldn't reach the engine."}`,
                  streaming: false,
                }
              : m,
          ),
        );
        return;
      }

      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                streaming: false,
                stats: {
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
                },
              }
            : m,
        ),
      );
    },
    [activeServer, messages, sending],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    messages,
    sending,
    error,
    activeServer,
    servers,
    setActiveServerId,
    sendMessage,
    cancel,
  };
}
