import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import InferencePanel from "~/components/chat/InferencePanel";
import Input from "~/components/chat/Input";
import Messages from "~/components/chat/Messages";
import { AgentBubble } from "~/components/chat/AgentBubble";
import { PiPanel } from "~/components/chat/PiPanel";
// RepoBindingBar (Hermes-only) retired 2026-05-19.
import Sidebar from "~/components/chat/Sidebar";
import TopBar, { type ChatStyle } from "~/components/chat/TopBar";
import { STYLE_PRESETS, useChat } from "~/hooks/useChat";
import type { ApiGlobalModel } from "~/lib/api";
import { StreamManager } from "~/lib/stream-manager";
import { estimateMessageListTokens } from "~/lib/tokens";

/**
 * Filter the model list down to what the user can pick, given their
 * inference mode (Settings → Inference). Easy mode hides the picker
 * entirely (TopBar prop), so this returns a single-entry list as a
 * safety net. Advanced exposes 4 named slots only. Expert lets the
 * full LiteLLM list through.
 */
function visibleModelsForMode(
  all: ApiGlobalModel[],
  mode: "easy" | "advanced" | "expert",
  easyModel: string | null,
  namedModels: {
    conversation?: string;
    analyse?: string;
    engineer?: string;
    expert?: string;
  },
): ApiGlobalModel[] {
  if (mode === "expert") return all;
  if (mode === "easy") {
    if (!easyModel) return [];
    const m = all.find((x) => x.id === easyModel);
    return m ? [m] : [];
  }
  // advanced — keep order Conversation / Analyse / Engineer / Expert
  const order: Array<["conversation" | "analyse" | "engineer" | "expert", string]> = [
    ["conversation", "Conversation"],
    ["analyse", "Analyse"],
    ["engineer", "Engineer"],
    ["expert", "Expert"],
  ];
  const out: ApiGlobalModel[] = [];
  for (const [slot, label] of order) {
    const id = namedModels[slot];
    if (!id) continue;
    const m = all.find((x) => x.id === id);
    if (m) {
      // Override display name with the slot label so the picker reads cleanly.
      out.push({ ...m, name: label, tags: [...(m.tags ?? [])] });
    }
  }
  return out;
}
import { useGlobalShortcuts } from "~/hooks/useGlobalShortcuts";
import { useIsMobile } from "~/hooks/useIsMobile";
import { useVoiceMode } from "~/hooks/useVoiceMode";
import { api } from "~/lib/api";
import { voiceInput } from "~/lib/voice-input";
import VoiceLiveOverlay from "~/components/chat/VoiceLiveOverlay";

export default function ChatLayout() {
  const { id } = useParams<{ id?: string }>();
  const chat = useChat({ conversationId: id });
  const [style, setStyle] = useState<ChatStyle>("Normal");
  const [panelOpen, setPanelOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const voiceMode = useVoiceMode();
  const isMobile = useIsMobile();
  const [voiceLiveOpen, setVoiceLiveOpen] = useState(false);
  const [voiceLiveAvailable, setVoiceLiveAvailable] = useState(false);
  // #26 — the chat voice toggle branches on the selected provider: gemini opens
  // the full-duplex overlay, local/mistral do TTS auto-speak (via /api/tts).
  const [voiceProvider, setVoiceProvider] = useState<
    "local" | "gemini" | "mistral"
  >("local");
  useEffect(() => {
    api
      .voiceLiveInfo()
      .then((info) => {
        setVoiceProvider(info.provider);
        setVoiceLiveAvailable(info.enabled && info.hasApiKey);
      })
      .catch(() => setVoiceLiveAvailable(false));
  }, []);

  // Union of client-side StreamManager active ids + server-side
  // `/conversations/active` poll. Drives the per-row pulsing dot in the
  // sidebar so the user can see at a glance which threads are mid-stream
  // — including streams running in another tab on the same account.
  const [clientActive, setClientActive] = useState<string[]>([]);
  const [serverActive, setServerActive] = useState<string[]>([]);
  useEffect(() => {
    return StreamManager.onGlobal((ids) => setClientActive(ids));
  }, []);
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await api.listActiveInferences();
        if (alive) setServerActive(r.active);
      } catch {
        // ignore — UI just won't show server-side parallel dots
      }
    }
    void tick();
    const i = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(i);
    };
  }, []);
  const streamingIds = useMemo(
    () => new Set([...clientActive, ...serverActive]),
    [clientActive, serverActive],
  );

  // ExoScopy parity: collapse the drawer when the user picks a conversation,
  // and reset on viewport-crossing so desktop never inherits a stuck-open
  // drawer.
  useEffect(() => {
    if (!isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    if (isMobile && id) setMobileSidebarOpen(false);
  }, [id, isMobile]);

  // Rough context usage for the bar under the composer. Only the
  // conversation history contributes here — the draft being typed is
  // counted inside Input.tsx so this re-render fires only when messages
  // actually grow. Char-based estimate, see src/lib/tokens.ts.
  const priorTokens = useMemo(
    () => estimateMessageListTokens(chat.messages),
    [chat.messages],
  );

  useGlobalShortcuts({
    onNewChat: () => navigate("/"),
    onFocusSearch: () => {
      // Focus the sidebar search input by selector — simpler than threading
      // a ref through props.
      const el = document.querySelector<HTMLInputElement>(
        'aside input[placeholder="Search conversations"]',
      );
      el?.focus();
      el?.select();
    },
    onStop: () => {
      if (chat.sending) chat.cancel();
    },
    onToggleVoiceMode: () => {
      // #26 — gemini = full-duplex overlay; local/mistral = TTS auto-speak.
      if (voiceProvider === "gemini") {
        if (voiceLiveAvailable) setVoiceLiveOpen(true);
        return;
      }
      voiceMode.toggle();
    },
    onOpenSettings: () => navigate("/settings/inference"),
    onPushToTalkChange: (active) => {
      if (active) {
        voiceInput.start((text) => {
          if (text) chat.sendMessage(text, []);
        });
      } else {
        voiceInput.stop();
      }
    },
  });

  function onStyleChange(next: ChatStyle) {
    setStyle(next);
    // Creative / Normal / Code each have a preset; apply it.
    // Custom leaves the values alone — the user tweaks them directly.
    if (next !== "Custom" && STYLE_PRESETS[next]) {
      chat.setInference(STYLE_PRESETS[next]);
    }
    // Open the inference panel when the user lands on Custom so they can tune.
    if (next === "Custom") setPanelOpen(true);
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <Sidebar
        activeConversationId={id ?? null}
        // ExoScopy parity: when chatting inside a conversation that belongs
        // to a project, the sidebar narrows to that project's conversations.
        // When at the root chat (no projectId on the loaded conversation), we
        // show only orphans.
        activeProjectId={chat.conversation?.projectId ?? null}
        streamingIds={streamingIds}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
      />
      <main className="flex min-w-0 flex-1 flex-col bg-gray-50">
        <GuestBanner />
        <TopBar
          activeStyle={style}
          onStyleChange={onStyleChange}
          onTogglePanel={() => setPanelOpen((v) => !v)}
          panelOpen={panelOpen}
          onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
          conversationId={id ?? null}
          memoryEnabled={chat.memoryEnabled}
          onToggleMemory={chat.toggleMemoryEnabled}
          agentMode={chat.agentMode}
          onToggleAgentMode={chat.toggleAgentMode}
        />
        {panelOpen && !isMobile && (
          <InferencePanel
            params={chat.inference}
            onChange={(patch) => {
              chat.setInference(patch);
              setStyle("Custom");
            }}
            onClose={() => setPanelOpen(false)}
          />
        )}
        {panelOpen && isMobile && (
          <div
            className="fixed inset-0 z-40 flex items-end bg-black/40 md:hidden"
            onClick={() => setPanelOpen(false)}
          >
            <div
              className="max-h-[85vh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-center pt-2">
                <span className="h-1 w-10 rounded-full bg-gray-300" />
              </div>
              <InferencePanel
                params={chat.inference}
                onChange={(patch) => {
                  chat.setInference(patch);
                  setStyle("Custom");
                }}
                onClose={() => setPanelOpen(false)}
              />
            </div>
          </div>
        )}
        <Messages
          messages={chat.messages}
          error={chat.error}
          onRegenerate={chat.regenerate}
          onEdit={chat.editAndResend}
          showMetrics={chat.showMetrics}
        />
        {/* Agent sub-thread (/hermes etc.) — terminal-style inline panel
         *  pinned below the message list. Renders only when there's a
         *  transcript, a live stream, or an error to surface. */}
        {/* Pi runs as a full TUI in a ttyd iframe, not as a
         *  message-bubble agent. When the user is in /pi mode and
         *  the add-on URL is configured, render the terminal panel
         *  in place of the AgentBubble. */}
        {chat.activeAgent === "pi" && chat.piBridgeUrl ? (
          <PiPanel url={chat.piBridgeUrl} />
        ) : (
          <AgentBubble
            messages={chat.agentMessages}
            streaming={chat.agentStreaming}
            error={chat.agentError}
            onReset={chat.hermesReset}
            agentLabel="Hermes"
          />
        )}
        {/* Persistent agent-mode chip. Reminds the user that every
         *  message in the composer goes to the agent (not the LLM),
         *  and provides a one-click exit. */}
        {chat.activeAgent && (
          <div className="mx-auto my-2 flex w-full max-w-3xl items-center justify-between rounded-md border border-amber-700/60 bg-amber-950/40 px-3 py-1.5 font-mono text-[11px] text-amber-200">
            <span>
              ▶ <strong className="text-amber-100">{chat.activeAgent}</strong> mode — every message routes to the agent
            </span>
            <button
              type="button"
              onClick={() => chat.sendMessage("/exit", [])}
              className="text-[11px] text-amber-300 hover:text-amber-100"
              title="Exit agent mode and return to normal chat"
            >
              /exit
            </button>
          </div>
        )}
        {chat.conversation?.kind === "talk" ? (
          <TalkInput
            onOpenVoiceLive={() => setVoiceLiveOpen(true)}
            voiceLiveAvailable={voiceLiveAvailable}
          />
        ) : (
          <Input
            onSend={chat.sendMessage}
            onCancel={chat.cancel}
            sending={chat.sending}
            disabled={chat.activeAgent ? false : !chat.model}
            placeholder={
              chat.activeAgent
                ? `Talk to ${chat.activeAgent}… (/exit to leave)`
                : chat.model
                  ? "Ask anything…"
                  : "Pick a model first"
            }
            modelHasVision={chat.activeModelCapabilities.vision}
            model={chat.model}
            onModelChange={chat.setModel}
            models={visibleModelsForMode(
              chat.globalModels,
              chat.inferenceMode,
              chat.easyModel,
              chat.namedModels,
            )}
            hideModelPicker={chat.inferenceMode === "easy"}
            hiddenModels={chat.hiddenModels}
            inferenceMode={chat.inferenceMode}
            onToggleHidden={chat.toggleModelHidden}
            voiceLiveAvailable={voiceLiveAvailable}
            onOpenVoiceLive={() => setVoiceLiveOpen(true)}
            priorTokens={priorTokens}
          />
        )}
        {voiceLiveOpen && (
          <VoiceLiveOverlay
            onClose={() => setVoiceLiveOpen(false)}
            conversationId={chat.conversation?.id ?? null}
            onCommit={chat.reload}
          />
        )}
      </main>
    </div>
  );
}

/**
 * Talk-mode "input": no textarea, no model picker — a single big circular
 * mic button that re-opens the Voice Live overlay so the user can resume
 * (or start) the conversation. Fills the same vertical slot as the normal
 * Input so the layout doesn't shift when switching kinds.
 */
function TalkInput({
  onOpenVoiceLive,
  voiceLiveAvailable,
}: {
  onOpenVoiceLive: () => void;
  voiceLiveAvailable: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center justify-center border-t border-gray-200 bg-white px-4 py-6">
      <button
        type="button"
        onClick={onOpenVoiceLive}
        disabled={!voiceLiveAvailable}
        aria-label={voiceLiveAvailable ? "Resume talking" : "Voice Live not configured"}
        title={
          voiceLiveAvailable
            ? "Tap to resume talking"
            : "Enable Voice (Gemini Live) in Settings → Add-ons"
        }
        className={`flex h-20 w-20 items-center justify-center rounded-full text-white shadow-lg transition-all ${
          voiceLiveAvailable
            ? "bg-cyan hover:scale-105 hover:opacity-95 active:scale-95"
            : "cursor-not-allowed bg-gray-300"
        }`}
      >
        <BigMicIcon />
      </button>
    </div>
  );
}

function BigMicIcon() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

/**
 * Surfaces the guest token's remaining budget when the chat is opened via a
 * `/g/<token>` link. The banner is dismissible per page load. We poll
 * /api/guest/session lazily — only when the localStorage flag is set, to
 * avoid a 400 round-trip on every regular session.
 */
function GuestBanner() {
  const [snap, setSnap] = useState<{
    tokenBudget: number;
    tokensUsed: number;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    const hasGuest =
      typeof localStorage !== "undefined" &&
      !!localStorage.getItem("companion:guestToken");
    if (!hasGuest) return;
    api
      .guestSession()
      .then((s) => {
        if (alive) {
          setSnap({ tokenBudget: s.tokenBudget, tokensUsed: s.tokensUsed });
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!snap || dismissed) return null;
  const total = snap.tokenBudget === 0 ? "∞" : snap.tokenBudget.toLocaleString();
  return (
    <div className="flex items-center gap-3 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-[12px] text-amber-900">
      <span className="font-medium">Guest session</span>
      <span className="font-mono">
        {snap.tokensUsed.toLocaleString()} / {total} tokens used
      </span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="ml-auto text-amber-700 hover:text-amber-900"
      >
        ×
      </button>
    </div>
  );
}
