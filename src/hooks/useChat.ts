import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  api,
  type ApiConversation,
  type ApiGlobalModel,
  type ApiInferenceMode,
  type ApiMessage,
  type ApiProject,
  AUTO_ROUTER_MODEL_ID,
} from "~/lib/api";
import {
  type Attachment,
  type ParserConfig,
} from "~/lib/file-attach";
import { getMemoryDefaultNewConv } from "~/lib/memory-prefs";
import { estimateCost as lookupCost } from "~/lib/model-pricing";
import type { GuardWarning, GuardBlock } from "~/lib/chat-types";

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

export type ComfyuiAttachment = {
  filename: string;
  mime: string;
  /** Bridge base URL (e.g. "http://192.168.86.141:8008") captured at
   *  generation time. The full image URL is
   *  `{bridge_url}/v1/image/{filename}`. */
  bridge_url: string;
  template_slug?: string;
};

export type UIMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  /** v2.0 — 'task' rows render as task cards, not chat bubbles. */
  messageType?: "chat" | "task";
  /** Task card payload: {sub_conversation_id, agent, description,
   *  status, result_summary}. */
  payload?: Record<string, unknown> | null;
  content: string;
  reasoning?: string;
  streaming?: boolean;
  /** ComfyUI image attachments. Bytes live on the compute host — we
   *  only persist a reference and the browser fetches via the bridge
   *  URL at render time. Set by pushComfyuiResult and loaded from the
   *  `messages.attachments` JSONB column by toUIMessage. */
  attachments?: ComfyuiAttachment[];
  /** ISO-8601 — set when the message is created locally (sendMessage) or
   *  loaded from the server (toUIMessage). Used by the chat client to send
   *  per-message timestamps so the backend can compute Δ tags. */
  createdAt?: string;
  /** Model id that produced this assistant message (set when the assistant
   *  reply lands). Shown as a badge under the message. */
  model?: string;
  /** Tool invocations the assistant made during this turn (web_search, etc). */
  toolCalls?: ToolCallRecord[];
  /** Confidential Guard verdict for the live turn (streaming only —
   *  persisted messages carry it in stats.guard* instead). */
  guard?: GuardWarning;
  /** Set when the send was blocked (CoeOS router + sensitive). Rendered as
   *  a switch-to-local prompt in place of an assistant reply. Live-only —
   *  blocked turns never persist an assistant message. */
  blocked?: GuardBlock;
  stats?: {
    ttft?: string;
    tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    reasoningTokens?: number;
    /** Tokens served from the upstream's prefix cache (tiered KV
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
    /** Set instead of a real routing decision when the router couldn't run
     *  and the turn was answered by the Auto Router's fallback model. Kept
     *  on the message so reopening the conversation still explains why the
     *  answer came from that model. */
    routedError?: string;
    /** Confidential Guard verdict — persisted flavour of UIMessage.guard
     *  so the banner survives a reload. */
    guardFlagged?: boolean;
    guardSeverity?: "low" | "medium" | "high";
    guardCategories?: string[];
    guardForcedLocal?: boolean;
    guardForcedModel?: string | null;
    guardDestinationLocal?: boolean;
    /** #36 memory transparency — what memory was actually injected this turn.
     *  Set only when something WAS injected (>0). `memoryInjected` is the
     *  inspectable text (stable wiki/vault + per-turn RAG, labelled). */
    memoryChars?: number;
    ragChars?: number;
    memoryTokens?: number;
    memoryInjected?: string;
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

  // Hermes/Pi bridge state removed 2026-08-03 (v2.0 γb2) — delegation
  // now runs through the native task tool (task cards in the thread).
  // Parser add-on (Docling). Governs how document attachments are routed by
  // the composer: when enabled, docs (and PDFs in text mode) upload their
  // raw bytes for server-side parsing instead of being rasterized / inlined.
  const [parserConfig, setParserConfig] = useState<ParserConfig>({
    enabled: false,
    pdfMode: "text",
  });
  // Inference mode (0058): 'auto' = no picker, the Auto Router decides
  // per message; 'expert' = full catalog picker. The retired 'easy' and
  // 'advanced' modes are read-mapped to 'auto' server-side.
  const [inferenceMode, setInferenceMode] = useState<ApiInferenceMode>(
    "expert",
  );
  // Same value, readable synchronously from the conversation-load effect.
  // The two effects (settings fetch / conversation fetch) race, and the
  // conversation one must not restore a concrete saved model over the
  // routing sentinel when the user is in 'auto' mode — see the guard at
  // the restoreModelFromConv call site.
  const inferenceModeRef = useRef<ApiInferenceMode>("expert");
  const [showMetrics, setShowMetrics] = useState(false);
  // Per-user picker hide list. Rendered grayed with an eye toggle in
  // expert mode (auto mode has no picker at all). PATCH'd back to
  // /api/inference/settings when the user clicks the toggle.
  const [hiddenModels, setHiddenModels] = useState<string[]>([]);
  /** ComfyUI Imager enriched-prompt modal. When set, the chat composer
   *  (ChatLayout) opens the modal pre-filled with `prompt` (everything
   *  the user typed after `/comfyui`, may be empty). The modal calls
   *  /api/agents/comfyui/slash directly and pushes the resulting image
   *  into `messages` via `pushComfyuiResult`. */
  const [comfyuiPrompt, setComfyuiPrompt] = useState<{ prompt: string } | null>(
    null,
  );
  /** Push the image (or set of images) returned by the modal into the
   *  chat as a persisted assistant message. The bytes live on the
   *  ComfyUI compute host; we only persist the reference
   *  (filename + mime + bridge URL) so the message survives a refresh
   *  and renders the same image on reload via GET /v1/image/{filename}.
   *
   * Two messages get inserted:
   *  1. A `user` line containing `/comfyui` so the conversation reads
   *     naturally even before images load.
   *  2. An `assistant` line with the caption + attachments array. This
   *     is the line the renderer picks up via <ComfyuiAttachments>.
   *
   * If the server insert fails we fall back to local-only state (the
   * user still sees their image in this session) and surface a toast
   * — better than a silent regression to the old ephemeral behaviour.
   */
  const pushComfyuiResult = useCallback(
    async (r: {
      conversationId: string;
      template_slug: string;
      bridge_url: string;
      prompt_id: string | null;
      duration_s: number | null;
      images: Array<{ filename: string; mime: string }>;
    }) => {
      const userLineId = `local-comfyui-q-${Date.now()}`;
      const assistantLineId = `local-comfyui-a-${Date.now()}`;
      const duration = r.duration_s ? `${r.duration_s.toFixed(1)}s` : "?";
      const caption = r.images.length
        ? `*Generated ${r.images.length} image(s) in ${duration} · ` +
          `prompt_id: \`${r.prompt_id ?? "?"}\`*`
        : "_Generation finished but no image was returned._";
      const attachments: ComfyuiAttachment[] = r.images.map((img) => ({
        filename: img.filename,
        mime: img.mime,
        bridge_url: r.bridge_url,
        template_slug: r.template_slug,
      }));

      // Optimistic local insert so the user sees the image instantly.
      const now = new Date().toISOString();
      setMessages((prev) => [
        ...prev,
        {
          id: userLineId,
          role: "user",
          content: `/comfyui`,
          createdAt: now,
          streaming: false,
        },
        {
          id: assistantLineId,
          role: "assistant",
          content: caption,
          attachments: attachments.length > 0 ? attachments : undefined,
          createdAt: now,
          streaming: false,
        },
      ]);

      // Persist on the server so a refresh restores the same message.
      // Fire-and-forget on success — the local state already shows it.
      // On failure, log to console; a future toast will surface this.
      try {
        await Promise.all([
          api.appendMessage(r.conversationId, {
            role: "user",
            content: "/comfyui",
            createdAt: now,
          }),
          api.appendMessage(r.conversationId, {
            role: "assistant",
            content: caption,
            attachments: attachments.length > 0 ? attachments : undefined,
            createdAt: now,
          }),
        ]);
      } catch (e) {
        console.error("[comfyui] failed to persist image message", e);
      }
    },
    [],
  );
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

  // Fetch the LiteLLM model list + the user's default model on mount. If the
  // user hasn't picked a model, default to inferenceSettings.defaultModel,
  // else the first available LiteLLM model.
  useEffect(() => {
    let cancelled = false;
    // Parser add-on — cheap, optional. When unconfigured we keep the default
    // (disabled) so the composer falls back to the pdf.js / inline-text path.
    api
      .parserAddonInfo()
      .then((info) => {
        if (cancelled) return;
        setParserConfig({
          enabled: Boolean(info.enabled),
          pdfMode: info.pdfMode === "vision" ? "vision" : "text",
        });
      })
      .catch(() => {
        /* not configured — leave parserConfig disabled */
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
    ])
      .then(([{ models }, settings]) => {
        if (cancelled) return;
        setGlobalModels(models);
        setInferenceMode(settings.inferenceMode);
        inferenceModeRef.current = settings.inferenceMode;
        setShowMetrics(settings.showMetrics);
        setHiddenModels(settings.hiddenModels ?? []);

        // Choose a default model that respects the active mode.
        if (settings.inferenceMode === "auto") {
          // Auto mode: the chat always sends the routing sentinel and CoeOS
          // (the router engine) decides per message. There is no picker, so
          // any locally remembered choice is irrelevant.
          //
          // Deliberately NOT setModelAndPersist: state + localStorage only.
          // Writing the sentinel into `conversations.model` would erase
          // which concrete model each conversation actually used, and the
          // user gets that history back the moment they switch to expert.
          // localStorage still gets it so a reload starts on the sentinel
          // instead of a stale concrete id.
          setModel(AUTO_ROUTER_MODEL_ID);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(MODEL_LS_KEY, AUTO_ROUTER_MODEL_ID);
          }
        } else if (!model) {
          // Expert: pre-fill the picker, leave an existing choice alone.
          const fallback = settings.defaultModel ?? models[0]?.id ?? "";
          if (fallback) setModelAndPersist(fallback);
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
      setPendingAgentMode(null);
      loadedIdRef.current = null;
      // `sending` is owned by the v3 runtime now; reset the shell copy on
      // landing at "new chat" so nothing stale leaks through the compose.
      setSending(false);
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
      setError(null);
    }
    loadedIdRef.current = conversationId;

    api
      .getConversation(conversationId)
      .then(({ conversation, messages: msgs }) => {
        setConversation(conversation);
        // Restore the conv's saved model (if any). When absent, the
        // existing `model` state (= localStorage default) stays. The
        // ref binds the active model to this conv so the next picker
        // change PATCHes the right row.
        //
        // EXCEPT in 'auto' mode: conversations started in expert mode
        // carry a concrete model id, and restoring it here would silently
        // pin the turn to that model — the user would be in auto mode
        // with no picker and no routing, unable to see or change it.
        // The mode outranks the conversation's history, so we keep the
        // routing sentinel and only bind the conv id (so a later mode
        // switch back to expert still PATCHes the right row).
        if (conversation.model && inferenceModeRef.current !== "auto") {
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

        // v3 owns the live message surface (useChatV3's SSE replays the
        // thread and streams the running turn). This hook only adopts the
        // DB snapshot for the shell; base.messages is overridden downstream.
        const dbMessages = msgs.map(toUIMessage);
        setMessages((prev) =>
          prev.length > dbMessages.length ? prev : dbMessages,
        );
        setSending(false);
      })
      .catch((e) => setError(e.message));

    // sending intentionally excluded — we only want this effect on conv
    // change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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



  // The v1 send/stream path was removed with the v1 rail (2026-08-04).
  // These are inert placeholders: useChatV3 overrides messages + sending
  // and every action below with the v3 implementations. They exist only so
  // the base shell surface stays type-stable for the compose in useChatV3.
  const sendMessage = useCallback(
    async (_text: string, _attachments: Attachment[] = []) => {},
    [],
  );
  const cancel = useCallback(() => {}, []);
  const regenerate = useCallback(async (_assistantId: string) => {}, []);
  const editAndResend = useCallback(
    async (_messageId: string, _newText: string) => {},
    [],
  );
  const resendOnLocalModel = useCallback((_localModelId: string) => {}, []);

  const startNew = useCallback(() => {
    navigate("/");
  }, [navigate]);


  const toggleMemoryEnabled = useCallback(async () => {
    // Pre-conversation: no row to PATCH yet, just flip the pending flag.
    // The current value comes from the existing pending state, falling
    // back to the project default (true). Persisted at conv creation
    // in sendMessage.
    if (!conversation) {
      // No row to PATCH yet — flip the pending flag. Baseline is the
      // per-device default for a personal chat; project chats inherit the
      // project's memory setting, so we keep a neutral false baseline there.
      const baseline = project ? false : getMemoryDefaultNewConv();
      setPendingMemoryEnabled((prev) => !(prev ?? baseline));
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
  }, [conversation, project]);

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
   * where messages can be appended out-of-band rather than via
   * sendMessage(), so the local cache wouldn't otherwise know the
   * message store grew.
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
    showMetrics,
    hiddenModels,
    toggleModelHidden,
    inference,
    setInference: updateInference,
    activeModelCapabilities,
    sendMessage,
    regenerate,
    editAndResend,
    resendOnLocalModel,
    cancel,
    startNew,
    toggleMemoryEnabled,
    toggleAgentMode,
    reload,
    /** Parser add-on state — passed to the composer so document attachments
     *  route to the server-side Docling parser when enabled. */
    parserConfig,
    /** Effective memory toggle: persisted conv value when the conv exists,
     *  else the pre-conversation pending override, else the per-device
     *  default for a new personal chat (project chats fall back to false —
     *  the project setting governs server-side). */
    memoryEnabled:
      conversation?.memoryEnabled ??
      pendingMemoryEnabled ??
      (project ? false : getMemoryDefaultNewConv()),
    /** Effective agent-mode (tools) toggle: persisted conv value when the
     *  conv exists, else the pre-conversation pending override, else TRUE
     *  (default ON — CodeOS parity, 2026-08-03).
     *  Lets the TopBar tools button reflect a pre-first-message flip. (#28) */
    agentMode:
      conversation?.agentMode ?? pendingAgentMode ?? true,
    /** ComfyUI Imager enriched-prompt modal trigger. When this is set, the
     *  chat composer opens a modal with the form. Generation lands back in
     *  `messages` via `pushComfyuiResult`. */
    comfyuiPrompt,
    setComfyuiPrompt,
    pushComfyuiResult,
  };
}

function toUIMessage(m: ApiMessage): UIMessage {
  const stats = (m.stats as UIMessage["stats"]) ?? undefined;
  return {
    id: m.id,
    role: m.role,
    messageType: m.messageType ?? "chat",
    payload: m.payload ?? undefined,
    content: m.content,
    reasoning: m.reasoning ?? undefined,
    createdAt: m.createdAt,
    // Surface the model id at the message level too, so the StatsRow
    // can show it for DB-loaded messages where the live model state
    // isn't available anymore.
    model: stats?.model,
    stats,
    // ComfyUI image references loaded from the messages.attachments
    // JSONB column. Empty/null = text-only message.
    attachments:
      m.attachments && m.attachments.length > 0 ? m.attachments : undefined,
  };
}

// estimateCost helper removed — stats are now produced server-side
// in chat.ts when the inference-state buffer commits the assistant
// message. If we want the cost back as a display field, it should be
// computed in the persist callback and stored alongside other stats.
// `lookupCost` from model-pricing.ts is still available there.
void lookupCost;

export function inferenceToPayload(i: InferenceParams) {
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
