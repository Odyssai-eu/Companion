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

/** UUID v4 fallback for environments where crypto.randomUUID() throws
 *  (Safari refuses it on insecure http:// origins, which is the default
 *  for a LAN install of Companion). Uses crypto.getRandomValues which
 *  is available everywhere; degrades to Math.random as a last resort. */
function _fallbackUuid(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      const h = (n: number) => n.toString(16).padStart(2, "0");
      return (
        Array.from(b.slice(0, 4)).map(h).join("") + "-" +
        Array.from(b.slice(4, 6)).map(h).join("") + "-" +
        Array.from(b.slice(6, 8)).map(h).join("") + "-" +
        Array.from(b.slice(8, 10)).map(h).join("") + "-" +
        Array.from(b.slice(10)).map(h).join("")
      );
    }
  } catch {
    /* fall through to Math.random */
  }
  // Last-resort, low-quality, but never throws.
  const rand = () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return Array.from({ length: 16 }, rand).join("").replace(
    /(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5",
  );
}

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
  // "none" = no explicit reasoning directive → the engine's per-model default
  // decides (Step-3.7 → minimal, set server-side). Pick a level to override.
  reasoningEffort: "none",
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
    /** Decode-only tok/s — completion / (duration - ttft). Matches the
     *  rates model providers advertise (they don't count prompt eval).
     *  Shown alongside `speed` in StatsRow when available. */
    decodeSpeed?: string;
    cost?: string;
    /** Server-side echo of the model id used for this turn — lets the
     *  StatsRow show "Model: vlm:qwen3.6-35b" even after the page is
     *  reloaded and the live model picker state is gone. Set in chat.ts
     *  when the assistant message is persisted. */
    model?: string;
    /** Auto-router decision. Set only when the picker was "auto" and the
     *  server routed via the semantic-router add-on. */
    routedFrom?: string;
    routedLabel?: string;
    routedScore?: number;
    routedMs?: number;
    /** /help answer markers. Set when the message was generated by the
     *  /help slash command (RAG over the user-guide wiki). */
    isHelp?: boolean;
    helpFrom?: string[];      // article slugs used as context
    helpTitles?: string[];    // article titles for the chip
  };
};

export type UseChatOptions = {
  conversationId?: string;
};

const MODEL_LS_KEY = "companion:model";

export function useChat({ conversationId }: UseChatOptions = {}) {
  const navigate = useNavigate();

  const [globalModels, setGlobalModels] = useState<ApiGlobalModel[]>([]);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Agent sub-thread (`/hermes`) — transcript loaded on conv switch,
  // accumulates locally as user invokes more prompts.
  const [agentMessages, setAgentMessages] = useState<
    Array<{
      id: string;
      role: "user" | "agent" | "tool";
      content: string;
      stats?: Record<string, unknown> | null;
      createdAt?: string;
    }>
  >([]);
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  // Pi Agent — TUI variant. When the user enters `/pi` mode we render
  // a full-height iframe pointed at this URL (typically the ttyd
  // process running `tmux attach -t pi` on the Pi host). Fetched once
  // from the Pi Agent add-on config.
  const [piBridgeUrl, setPiBridgeUrl] = useState<string>("");
  // #25 — Hermes runs as a shared enterprise TUI embedded via iframe (the
  // Hermes web dashboard), same as Pi. URL from the Hermes Agent add-on config.
  // When set, `/hermes` opens the iframe instead of the (retired) ACP bubble.
  const [hermesBridgeUrl, setHermesBridgeUrl] = useState<string>("");
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
  // #28 — same pre-conversation pattern as memory, for agent mode (tools).
  // Lets the user flip tools ON/OFF on a blank chat before the first message;
  // persisted at conversation creation, then reset.
  const [pendingAgentMode, setPendingAgentMode] = useState<boolean | null>(
    null,
  );
  const [conversation, setConversation] = useState<ApiConversation | null>(
    null,
  );
  const [project, setProject] = useState<ApiProject | null>(null);

  // Selected model — bound to the active conversation when one is loaded,
  // else to localStorage as the "default for new chats". Switching to a
  // conversation that has a `conversations.model` set restores it; picking
  // a new model from the picker writes both to localStorage AND PATCHes
  // the active conversation so the choice survives navigation away and back.
  const [model, setModel] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem(MODEL_LS_KEY) ?? "";
  });
  // Tracks the conversation the current `model` state belongs to. Used to
  // PATCH only when the user CHANGES the picker mid-conversation, not when
  // the conversation load restores its own saved model (which would be a
  // pointless self-PATCH and a write-amplification spiral on refresh).
  const conversationIdForModelRef = useRef<string | null>(null);

  // Restore a model from a conversation load: state-only, no localStorage,
  // no PATCH. The conv-id ref tracks which conversation this `model` belongs
  // to, so the next picker change knows whether to persist to that conv.
  const restoreModelFromConv = useCallback(
    (m: string, convId: string | null) => {
      setModel(m);
      conversationIdForModelRef.current = convId;
    },
    [],
  );

  // The picker calls this. Updates state, localStorage (so new chats inherit
  // the choice), AND PATCHes the active conversation (so future visits land
  // on the same model). Fire-and-forget on the PATCH — failure to persist
  // is non-blocking, the user can re-pick.
  const setModelAndPersist = useCallback((m: string) => {
    setModel(m);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODEL_LS_KEY, m);
    }
    const convId = conversationIdForModelRef.current;
    if (convId) {
      api
        .setConversationModel(convId, m)
        .catch((e) => {
          // Non-fatal — log and move on. Next page load will fall back to
          // localStorage / inferenceSettings.default.
          console.warn(
            `[useChat] failed to persist model=${m} on conv ${convId}:`,
            e,
          );
        });
    }
  }, []);

  const [inference, setInference] = useState<InferenceParams>(() => {
    if (typeof window === "undefined") return DEFAULT_INFERENCE;
    try {
      const raw = window.localStorage.getItem("companion:inference");
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
          "companion:inference",
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
  // Fetch the Pi Agent ttyd URL once on mount. Cheap, optional —
  // if the add-on isn't configured we just leave the URL empty and
  // the /pi panel won't render (the slash command surfaces an error
  // instead).
  useEffect(() => {
    let cancelled = false;
    api
      .piAddonInfo()
      .then((info) => {
        if (cancelled) return;
        if (info.enabled && info.bridgeUrl) {
          setPiBridgeUrl(info.bridgeUrl);
        }
      })
      .catch(() => {
        /* not configured — leave piBridgeUrl empty */
      });
    // #25 — same for Hermes (enterprise dashboard iframe).
    api
      .hermesAddonInfo()
      .then((info) => {
        if (cancelled) return;
        if (info.enabled && info.bridgeUrl) {
          setHermesBridgeUrl(info.bridgeUrl);
        }
      })
      .catch(() => {
        /* not configured — leave hermesBridgeUrl empty (falls back to bubble) */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listAllModels(),
      api.inferenceSettings(),
      api.routerInfo().catch(() => null),
    ])
      .then(([{ models }, settings, router]) => {
        if (cancelled) return;
        setGlobalModels(models);
        setInferenceMode(settings.inferenceMode);
        setEasyModel(settings.easyModel);
        setNamedModels(settings.namedModels ?? {});
        setShowMetrics(settings.showMetrics);
        setHiddenModels(settings.hiddenModels ?? []);

        // Choose a default model that respects the active mode.
        if (settings.inferenceMode === "easy") {
          // Easy = Odysseus picks the best model: auto-route when the Auto
          // Router add-on is enabled AND configured, otherwise fall back to
          // the admin-set fallback model. Either way ignore local override.
          const routerReady = Boolean(router?.enabled && router?.configured);
          const easyTarget = routerReady
            ? "auto"
            : (settings.easyModel ?? settings.defaultModel ?? "");
          if (easyTarget) setModelAndPersist(easyTarget);
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
      setAgentMessages([]);
      setAgentError(null);
      // Clear any pre-conversation memory override when the user
      // returns to the "new chat" entry, so the next conv starts from
      // its project default (or true) instead of a stale pending flip.
      setPendingMemoryEnabled(null);
      setPendingAgentMode(null);
      loadedIdRef.current = null;
      return;
    }
    if (loadedIdRef.current === conversationId) return;
    // Switching from a previously-loaded conv → clear stale messages /
    // agent state / project context immediately. Without this, the brief
    // window between the conv-id change and the getConversation fetch
    // resolving leaves the OLD conv's messages on screen — and the
    // defensive `prev.length > dbMessages.length` check in CASE 0 below
    // then incorrectly keeps them when the new conv has fewer messages.
    // Only fires on conv-to-conv switch (loadedIdRef.current is the
    // previous loaded id); fresh-conv first-load skips this because
    // loadedIdRef.current is still null.
    if (loadedIdRef.current && loadedIdRef.current !== conversationId) {
      setMessages([]);
      setConversation(null);
      setProject(null);
      setAgentMessages([]);
      setAgentError(null);
      setError(null);
    }
    // Load the Hermes agent transcript ONCE per conv — gated behind the
    // loaded-id ref above so it doesn't re-fire on every render. Without
    // this guard, the load races the live stream (when /hermes was just
    // sent on a new conv, navigate(/c/:id) re-triggers this effect; the
    // server doesn't have the persisted messages yet, so the empty
    // response would wipe the optimistic state mid-stream).
    api
      .hermesTranscript(conversationId)
      .then(({ messages: agentMsgs }) => {
        // Skip if a stream landed first OR if we got more messages
        // locally than the server reports (the server persists at the
        // END of the stream, not chunk-by-chunk).
        setAgentMessages((prev) =>
          prev.length > agentMsgs.length ? prev : agentMsgs,
        );
      })
      .catch(() => {
        /* not configured or 404 — leave empty */
      });

    loadedIdRef.current = conversationId;
    let serverPollAbort: (() => void) | null = null;

    api
      .getConversation(conversationId)
      .then(({ conversation, messages: msgs, inference }) => {
        setConversation(conversation);
        // Restore the conv's saved model (if any). When absent, the
        // existing `model` state (= localStorage default) stays. The
        // ref binds the active model to this conv so the next picker
        // change PATCHes the right row.
        if (conversation.model) {
          restoreModelFromConv(conversation.model, conversationId);
        } else {
          // No saved model on this conv yet — bind the current default
          // to it. The first user message will land with whatever the
          // picker shows; chat.ts persists conversations.model on first
          // send too (so this is mostly back-fill UX).
          conversationIdForModelRef.current = conversationId;
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
          // CASE 0 — no stream anywhere. Adopt DB state, but defensively:
          // if local has strictly MORE messages than the server returned,
          // keep local. This handles the race where /help on a fresh conv
          // does setConversation + navigate + setMessages(optimistic)
          // before the server has persisted anything — the conv-load
          // effect re-fires with the new convId, fetches an empty msg
          // list, and would clobber the optimistic /help user message +
          // streaming placeholder. Mirrors the agent-transcript defence
          // we put in place 2026-05-21.
          setMessages((prev) =>
            prev.length > dbMessages.length ? prev : dbMessages,
          );
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

  /**
   * Generic agent-bridge invocation. Streams SSE chunks into the local
   * agentMessages state. Used by both `/hermes` and `/pi` — they speak
   * the same `sessionUpdate: agent_message_chunk | tool_call` SSE shape
   * thanks to translation in their respective backend routes.
   */
  const invokeAgent = useCallback(
    async (endpoint: string, convId: string, prompt: string) => {
      setAgentError(null);
      setAgentStreaming(true);

      // Optimistic user line — server will mirror it but local feedback
      // beats the round-trip.
      const userLineId = `local-user-${Date.now()}`;
      setAgentMessages((prev) => [
        ...prev,
        { id: userLineId, role: "user", content: prompt },
      ]);

      const agentLineId = `local-agent-${Date.now()}`;
      let agentText = "";
      // Placeholder agent line we'll grow as chunks arrive
      setAgentMessages((prev) => [
        ...prev,
        { id: agentLineId, role: "agent", content: "" },
      ]);

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: convId, prompt }),
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({
            detail: res.statusText || `bridge error ${res.status}`,
          }));
          setAgentError(
            (err as { detail?: string; error?: string }).detail ??
              (err as { error?: string }).error ??
              `bridge error ${res.status}`,
          );
          // Drop the placeholder agent line
          setAgentMessages((prev) => prev.filter((m) => m.id !== agentLineId));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            let event = "message";
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;
            try {
              const parsed = JSON.parse(data);
              if (event === "update") {
                const kind = parsed.sessionUpdate;
                if (kind === "agent_message_chunk") {
                  agentText += parsed.content?.text ?? "";
                  setAgentMessages((prev) =>
                    prev.map((m) =>
                      m.id === agentLineId ? { ...m, content: agentText } : m,
                    ),
                  );
                } else if (kind === "tool_call") {
                  // ACP `tool_call` is flat — `title` is the human-readable
                  // action ("write: /tmp/foo.txt"). `locations` lists the
                  // paths involved. We dedup-insert on toolCallId so a
                  // future `tool_call_update` (status change) doesn't add
                  // a second line.
                  const callId = parsed.toolCallId ?? `${Date.now()}-${Math.random()}`;
                  setAgentMessages((prev) => {
                    if (prev.some((m) => m.id === `tool-${callId}`)) return prev;
                    return [
                      ...prev,
                      {
                        id: `tool-${callId}`,
                        role: "tool",
                        content:
                          parsed.title ?? parsed.kind ?? "(unknown)",
                        stats: {
                          kind: parsed.kind,
                          args:
                            parsed.locations ??
                            parsed.content ??
                            null,
                        },
                      },
                    ];
                  });
                }
                // bridge_auto_approved is auto-permission metadata, not
                // a user-visible tool action. The preceding `tool_call`
                // already shows the action — skip to avoid noise.
              } else if (event === "error") {
                setAgentError(
                  (parsed as { message?: string }).message ?? "stream error",
                );
              }
            } catch {
              /* non-JSON SSE chunk, ignore */
            }
          }
        }
      } catch (e) {
        setAgentError((e as Error).message);
      } finally {
        setAgentStreaming(false);
      }
    },
    [],
  );

  const hermesInvoke = useCallback(
    (convId: string, prompt: string) =>
      invokeAgent("/api/agents/hermes/invoke", convId, prompt),
    [invokeAgent],
  );

  const piInvoke = useCallback(
    (convId: string, prompt: string) =>
      invokeAgent("/api/agents/pi/invoke", convId, prompt),
    [invokeAgent],
  );

  /**
   * /help <question> — RAG against the user-guide wiki.
   *
   * Server-side strips conv context: only the wiki + the question are
   * sent to the LLM. So the answer can't drift into whatever was being
   * discussed in this chat. The user message gets inserted as a normal
   * chat turn; the assistant reply is also a normal message but with
   * `stats.helpFrom = [slug, …]` for the UI to render a "Help · from:
   * …" chip.
   */
  const helpAsk = useCallback(
    async (convId: string, question: string) => {
      setSending(true);
      setError(null);
      const userMsgId = `local-help-q-${Date.now()}`;
      const assistantMsgId = `local-help-a-${Date.now()}`;
      let acc = "";
      let sources: Array<{ slug: string; title: string; score: number }> = [];

      // Optimistic insert: the user question + a placeholder assistant
      setMessages((prev) => [
        ...prev,
        {
          id: userMsgId,
          role: "user",
          content: `/help ${question}`,
          createdAt: new Date().toISOString(),
          streaming: false,
        },
        {
          id: assistantMsgId,
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString(),
          streaming: true,
        },
      ]);

      try {
        const res = await fetch("/api/help/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, conversationId: convId }),
        });
        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({
            detail: res.statusText || `help error ${res.status}`,
          }));
          setError(
            (err as { detail?: string; error?: string }).detail ??
              (err as { error?: string }).error ??
              `help error ${res.status}`,
          );
          setMessages((prev) => prev.filter((m) => m.id !== assistantMsgId));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            let event = "message";
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;
            if (data === "[DONE]") continue;
            try {
              if (event === "sources") {
                const parsed = JSON.parse(data);
                sources = parsed.articles ?? [];
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          stats: {
                            ...(m.stats ?? {}),
                            isHelp: true,
                            helpFrom: sources.map((s) => s.slug),
                            helpTitles: sources.map((s) => s.title),
                          },
                        }
                      : m,
                  ),
                );
              } else if (event === "done") {
                // closed below in finally
              } else if (event === "error") {
                const parsed = JSON.parse(data);
                setError(parsed.message ?? "help stream error");
              } else {
                // chat-completion delta (no explicit event tag)
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content ?? "";
                if (delta) {
                  acc += delta;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId ? { ...m, content: acc } : m,
                    ),
                  );
                }
              }
            } catch {
              /* non-JSON ignored */
            }
          }
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setSending(false);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, streaming: false } : m,
          ),
        );
      }
    },
    [],
  );

  /**
   * Drop the Hermes session for the current conv. Next /hermes opens a
   * fresh ACP session on the bridge.
   */
  const piReset = useCallback(async () => {
    const convId = conversationId ?? conversation?.id;
    if (!convId) return;
    try {
      await api.piReset(convId);
      setAgentMessages([]);
      setAgentError(null);
    } catch (e) {
      setAgentError((e as Error).message);
    }
  }, [conversationId, conversation?.id]);

  const hermesReset = useCallback(async () => {
    const convId = conversationId ?? conversation?.id;
    if (!convId) return;
    try {
      await api.hermesReset(convId);
      setAgentMessages([]);
      setAgentError(null);
    } catch (e) {
      setAgentError((e as Error).message);
    }
  }, [conversationId, conversation?.id]);

  const sendMessage = useCallback(
    async (text: string, attachments: Attachment[] = []) => {
      if (sending) return;
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;

      // ── Slash commands + persistent agent mode ────────────────────────
      // `/hermes` enters Hermes mode (with or without a prompt to run
      // immediately). Once in mode, every message routes to the Hermes
      // bridge until `/exit` (or `/hermes_off`) clears it.
      const slashMatch =
        trimmed.match(/^\/([a-z][\w-]*)\s+([\s\S]+)$/i) ??
        trimmed.match(/^\/([a-z][\w-]*)\s*$/i);
      const currentAgent = conversation?.activeAgent ?? null;

      if (slashMatch) {
        const cmd = slashMatch[1].toLowerCase();
        const rest = (slashMatch[2] ?? "").trim();

        // Exit any active agent mode. Works for `/exit` (universal) and
        // the agent-specific `/<kind>_off` (e.g. `/hermes_off`).
        if (cmd === "exit" || cmd.endsWith("_off")) {
          const convId = conversationId ?? conversation?.id;
          if (convId && currentAgent) {
            try {
              await api.setConversationActiveAgent(convId, null);
              setConversation((prev) =>
                prev ? { ...prev, activeAgent: null } : prev,
              );
            } catch (e) {
              setError((e as Error).message);
            }
          }
          return;
        }

        if (cmd === "help") {
          if (!rest) {
            setError(
              "Type a question after /help — e.g. /help how do I configure semantic routing? Full docs at https://odyssai.eu/docs/.",
            );
            return;
          }
          // Need a conv so the Q&A persists. Create one if needed.
          let convId = conversationId ?? conversation?.id ?? null;
          if (!convId) {
            try {
              const created = await api.createConversation({
                title: `/help ${rest}`.slice(0, 80),
                ...(model ? { model } : {}),
              });
              convId = created.conversation.id;
              setConversation(created.conversation);
              navigate(`/c/${convId}`, { replace: true });
            } catch (e) {
              setError((e as Error).message);
              return;
            }
          }
          await helpAsk(convId, rest);
          return;
        }

        if (cmd === "hermes" || cmd === "pi") {
          const kind = cmd as "hermes" | "pi";
          // Need a conv before invoking; create one if this is a fresh chat
          let convId = conversationId ?? conversation?.id ?? null;
          if (!convId) {
            try {
              const created = await api.createConversation({
                title:
                  (rest || `${kind === "hermes" ? "Hermes" : "Pi"} session`).slice(0, 80),
                ...(model ? { model } : {}),
              });
              convId = created.conversation.id;
              setConversation(created.conversation);
              navigate(`/c/${convId}`, { replace: true });
            } catch (e) {
              setError((e as Error).message);
              return;
            }
          }
          // Enter agent mode (persistent — stays until /exit)
          if (currentAgent !== kind) {
            try {
              await api.setConversationActiveAgent(convId, kind);
              setConversation((prev) =>
                prev ? { ...prev, activeAgent: kind } : prev,
              );
            } catch (e) {
              setError((e as Error).message);
              return;
            }
          }
          // Hermes runs through the SSE bridge — fire the rest as a
          // prompt now. Pi runs in a TUI iframe — the composer doesn't
          // route there, the user types directly in the terminal. So
          // we just enter mode and ignore any `rest` for /pi.
          // When a Hermes iframe is configured, the dashboard handles the
          // interaction directly — only fall back to the (retired) ACP bubble
          // invoke when there's no iframe URL (#25).
          if (kind === "hermes" && rest && !hermesBridgeUrl) {
            await hermesInvoke(convId, rest);
          }
          return;
        }
        // Unknown slash — fall through to normal chat.
      }

      // Persistent agent mode: every plain message goes to the agent
      // until `/exit`. Hermes uses the SSE bridge; Pi runs in a TUI
      // iframe so plain composer text doesn't route to it (the user
      // types directly in the terminal). We silently no-op for Pi so
      // accidentally-typed composer text doesn't hit normal chat with
      // the wrong context.
      if (currentAgent === "hermes" && !hermesBridgeUrl) {
        // Legacy ACP-bubble path — only when no Hermes iframe is configured.
        const convId = conversationId ?? conversation?.id;
        if (convId) {
          await hermesInvoke(convId, trimmed);
          return;
        }
      } else if (
        currentAgent === "pi" ||
        (currentAgent === "hermes" && hermesBridgeUrl)
      ) {
        // iframe TUI (Pi terminal or the enterprise Hermes dashboard) — the
        // user types directly in the window above; composer text doesn't route
        // here. Silently no-op so stray text doesn't hit normal chat (#25).
        const label = currentAgent === "pi" ? "Pi terminal" : "Hermes window";
        setError(`Type directly in the ${label} above. Use /exit to return.`);
        return;
      }

      if (!model) {
        setError(
          "No model selected. Pick one from the model picker in the composer.",
        );
        return;
      }

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
            // Persist the currently-picked model on the new conv so future
            // visits restore it (the picker is per-conversation now).
            ...(model ? { model } : {}),
            // Honour the TopBar memory toggle if the user flipped it
            // before sending the first message. Otherwise the server
            // inherits from the project (or defaults to true).
            ...(pendingMemoryEnabled !== null
              ? { memoryEnabled: pendingMemoryEnabled }
              : {}),
            // #28 — same for the agent-mode (tools) toggle flipped on the
            // blank chat before the first message.
            ...(pendingAgentMode !== null
              ? { agentMode: pendingAgentMode }
              : {}),
          });
          convId = created.conversation.id;
          setConversation(created.conversation);
          loadedIdRef.current = convId;
          // Bind the picker's model state to this newly-created conv id,
          // so the next picker change PATCHes the right row.
          conversationIdForModelRef.current = convId;
          // Reset pending state — it's now persisted on the conversation.
          setPendingMemoryEnabled(null);
          setPendingAgentMode(null);
        } catch (e) {
          setError((e as Error).message);
          return;
        }
      }

      const nowIso = new Date().toISOString();
      const userMsg: UIMessage = {
        // crypto.randomUUID() throws in Safari on non-secure contexts
        // (http:// origins) — observed 2026-05-25 on Sophie's
        // http://192.168.86.39:3100 deploy: every Enter in the chat
        // box created the conversation server-side but the user
        // message and downstream stream never fired because this line
        // threw silently, breaking sendMessage. Fall back to
        // getRandomValues which is available everywhere.
        id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? (() => {
              try { return crypto.randomUUID(); }
              catch { return _fallbackUuid(); }
            })()
          : _fallbackUuid(),
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
      pendingAgentMode,
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
    // Pre-conversation: no row to PATCH yet — flip the pending flag (agent
    // mode defaults to false). Persisted at conv creation in sendMessage. (#28)
    if (!conversation) {
      setPendingAgentMode((prev) => !(prev ?? false));
      return;
    }
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
    // Agent sub-thread (/hermes)
    agentMessages,
    agentStreaming,
    agentError,
    hermesInvoke,
    hermesReset,
    piInvoke,
    piReset,
    piBridgeUrl,
    hermesBridgeUrl,
    /** Persistent agent mode for this conv ('hermes' | null). When set,
     *  every plain message in the composer routes to that agent's
     *  bridge instead of the LLM chat path. `/exit` clears it. */
    activeAgent: conversation?.activeAgent ?? null,
    /** Effective memory toggle: persisted conv value when the conv
     *  exists, else the pre-conversation pending override, else true. */
    memoryEnabled:
      conversation?.memoryEnabled ?? pendingMemoryEnabled ?? true,
    /** Effective agent-mode (tools) toggle: persisted conv value when the
     *  conv exists, else the pre-conversation pending override, else false.
     *  Lets the TopBar tools button reflect a pre-first-message flip. (#28) */
    agentMode:
      conversation?.agentMode ?? pendingAgentMode ?? false,
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
