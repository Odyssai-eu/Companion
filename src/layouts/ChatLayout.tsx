import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import InferencePanel from "~/components/chat/InferencePanel";
import Input from "~/components/chat/Input";
import Messages from "~/components/chat/Messages";
import Sidebar from "~/components/chat/Sidebar";
import TopBar, { type ChatStyle } from "~/components/chat/TopBar";
import { STYLE_PRESETS, useChat } from "~/hooks/useChat";
import type { ApiGlobalModel } from "~/lib/api";

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
  useEffect(() => {
    api
      .voiceLiveInfo()
      .then((info) => setVoiceLiveAvailable(info.enabled && info.hasApiKey))
      .catch(() => setVoiceLiveAvailable(false));
  }, []);

  // ExoScopy parity: collapse the drawer when the user picks a conversation,
  // and reset on viewport-crossing so desktop never inherits a stuck-open
  // drawer.
  useEffect(() => {
    if (!isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    if (isMobile && id) setMobileSidebarOpen(false);
  }, [id, isMobile]);

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
    onToggleVoiceMode: () => voiceMode.toggle(),
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
        streamingConversationId={chat.sending ? id ?? null : null}
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
          memoryEnabled={chat.conversation?.memoryEnabled ?? true}
          onToggleMemory={chat.toggleMemoryEnabled}
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
        />
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
            disabled={!chat.model}
            placeholder={
              chat.model ? "Ask anything…" : "Pick a model first"
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
            voiceLiveAvailable={voiceLiveAvailable}
            onOpenVoiceLive={() => setVoiceLiveOpen(true)}
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
      !!localStorage.getItem("thecompai:guestToken");
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
