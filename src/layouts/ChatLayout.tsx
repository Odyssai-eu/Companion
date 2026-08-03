import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ComfyuiPromptModal,
  type ComfyuiResult,
} from "~/components/chat/ComfyuiPromptModal";
import InferencePanel from "~/components/chat/InferencePanel";
import Input from "~/components/chat/Input";
import Messages from "~/components/chat/Messages";
// RepoBindingBar (Hermes-only) retired 2026-05-19.
import Sidebar from "~/components/chat/Sidebar";
import TopBar, { type ChatStyle } from "~/components/chat/TopBar";
import { STYLE_PRESETS } from "~/hooks/useChat";
import { readV3Flag, setV3Flag, useChatV3 } from "~/hooks/useChatV3";
import type { ApiGlobalModel, ApiInferenceMode } from "~/lib/api";
import { StreamManager } from "~/lib/stream-manager";
import { estimateMessageListTokens } from "~/lib/tokens";

/**
 * Filter the model list down to what the user can pick, given their
 * inference mode (Settings → Inference).
 *
 *  - `auto`   — no picker at all. `Input` hides it via `hideModelPicker`;
 *               returning [] here is the belt to that suspenders, so a
 *               future surface that forgets the prop still can't offer a
 *               choice the mode says doesn't exist.
 *  - `expert` — the full catalog, unchanged.
 *
 * (0058 removed the `easy` and `advanced` branches along with the modes.)
 */
function visibleModelsForMode(
  all: ApiGlobalModel[],
  mode: ApiInferenceMode,
): ApiGlobalModel[] {
  return mode === "expert" ? all : [];
}
import { useGlobalShortcuts } from "~/hooks/useGlobalShortcuts";
import { useIsMobile } from "~/hooks/useIsMobile";
import { useRunEvents } from "~/hooks/useRunEvents";
import { useVoiceMode } from "~/hooks/useVoiceMode";
import { api } from "~/lib/api";
import { transcribeWav } from "~/lib/transcribe";
import { WavRecorder } from "~/lib/wav-recorder";

export default function ChatLayout() {
  const { id } = useParams<{ id?: string }>();
  const chat = useChatV3({ conversationId: id });
  const v3On = readV3Flag();
  const toggleV3 = () => {
    setV3Flag(!v3On);
    window.location.reload();
  };
  // v2.0 — live task narration (SSE run-events keyed on this conv).
  const taskLive = useRunEvents(id ?? null);
  const [style, setStyle] = useState<ChatStyle>("Normal");
  const [panelOpen, setPanelOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const voiceMode = useVoiceMode();
  const isMobile = useIsMobile();

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

  // ── Space-bar voice toggle (OUR ASR) ──────────────────────────────────────
  // A single Space press (outside any text field — guarded in
  // useGlobalShortcuts) toggles our WavRecorder. In a Talk conversation we
  // forward the toggle to the TalkInput's own recorder (one state machine, so
  // the keyboard and the big mic stay in sync). In a normal chat we run a
  // recorder here and inject the transcript into the composer instead of
  // sending. NOT the Web Speech API — capture + transcription are both ours.
  const talkControlRef = useRef<TalkControls | null>(null);
  // Signal bumped to push transcribed text into the composer (normal chat).
  const [composerInject, setComposerInject] = useState<{
    text: string;
    nonce: number;
  } | null>(null);
  // Standalone recorder + phase for the normal-chat spacebar path. A ref holds
  // the phase so the keydown handler reads the current value without resubscribing.
  const spaceRecorderRef = useRef<WavRecorder | null>(null);
  const spacePhaseRef = useRef<"idle" | "recording" | "transcribing">("idle");
  // Stable accessors so the toggle never closes over stale chat state.
  const isTalkRef = useRef(false);
  isTalkRef.current = chat.conversation?.kind === "talk";
  const voiceEnabledRef = useRef(false);
  voiceEnabledRef.current = voiceMode.enabled;
  const sendMessageRef = useRef(chat.sendMessage);
  sendMessageRef.current = chat.sendMessage;

  async function spacebarStart() {
    if (spacePhaseRef.current !== "idle") return;
    const rec = new WavRecorder();
    spaceRecorderRef.current = rec;
    try {
      await rec.start();
    } catch {
      spaceRecorderRef.current = null;
      spacePhaseRef.current = "idle";
      return;
    }
    spacePhaseRef.current = "recording";
  }

  async function spacebarStop() {
    if (spacePhaseRef.current !== "recording") return;
    const rec = spaceRecorderRef.current;
    spaceRecorderRef.current = null;
    spacePhaseRef.current = "transcribing";
    if (!rec) {
      spacePhaseRef.current = "idle";
      return;
    }
    try {
      const blob = await rec.stop();
      const text = await transcribeWav(blob);
      if (text) {
        // Normal chat: drop the transcript into the composer for review/edit,
        // rather than sending blind. (Talk-mode sends; this path inserts.)
        setComposerInject((prev) => ({
          text,
          nonce: (prev?.nonce ?? 0) + 1,
        }));
      }
    } catch {
      // Swallow — the composer just won't get new text. Talk-mode surfaces
      // its own errors in the big-mic UI; here there's no affordance to show.
    } finally {
      spacePhaseRef.current = "idle";
    }
  }

  // Release a half-open spacebar recording if the user navigates away.
  useEffect(() => {
    return () => spaceRecorderRef.current?.cancel();
  }, []);

  function onVoiceToggle() {
    // Talk conversation → drive the big-mic recorder (shared state machine).
    if (isTalkRef.current) {
      talkControlRef.current?.toggle();
      return;
    }
    // Normal chat → only when voice mode is on, run our recorder and insert.
    if (!voiceEnabledRef.current) return;
    if (spacePhaseRef.current === "idle") void spacebarStart();
    else if (spacePhaseRef.current === "recording") void spacebarStop();
  }

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
      voiceMode.toggle();
    },
    onOpenSettings: () => navigate("/settings/inference"),
    onVoiceToggle,
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
          chatV3={v3On}
          onToggleV3={toggleV3}
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
          localModels={chat.globalModels.filter((m) => m.origin === "local")}
          onSwitchLocal={chat.resendOnLocalModel}
          taskLive={taskLive}
        />
        {/* Hermes/Pi bridge panels removed 2026-08-03 (v2.0 γb2) —
         *  delegation renders as task cards inside <Messages>. */}
        {chat.conversation?.kind === "talk" ? (
          <TalkInput
            talkAvailable={voiceMode.enabled}
            onTranscript={(text) => chat.sendMessage(text, [])}
            controlRef={talkControlRef}
          />
        ) : (
          <Input
            onSend={chat.sendMessage}
            onCancel={chat.cancel}
            sending={chat.sending}
            injectText={composerInject ?? undefined}
            disabled={!chat.model}
            placeholder={chat.model ? "Ask anything…" : "Pick a model first"}
            modelHasVision={chat.activeModelCapabilities.vision}
            parserConfig={chat.parserConfig}
            model={chat.model}
            onModelChange={chat.setModel}
            models={visibleModelsForMode(chat.globalModels, chat.inferenceMode)}
            hideModelPicker={chat.inferenceMode === "auto"}
            hiddenModels={chat.hiddenModels}
            onToggleHidden={chat.toggleModelHidden}
            priorTokens={priorTokens}
          />
        )}
      </main>
      {chat.comfyuiPrompt && chat.conversation && (
        <ComfyuiPromptModal
          initial={chat.comfyuiPrompt}
          conversationId={chat.conversation.id}
          onClose={() => chat.setComfyuiPrompt(null)}
          onResult={(r: ComfyuiResult) => {
            chat.pushComfyuiResult({
              conversationId: chat.conversation!.id,
              template_slug: r.template,
              bridge_url: r.bridge_url,
              prompt_id: r.prompt_id,
              duration_s: r.duration_s,
              // Server returns base64 bytes inline so the modal can
              // render optimistically, but we only persist the
              // reference (filename + mime + bridge URL) — the bytes
              // stay on the compute host.
              images: r.images.map(({ filename, mime }) => ({ filename, mime })),
            });
            chat.setComfyuiPrompt(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Talk-mode "input": no textarea, no model picker — a single big circular
 * mic button. Enabled only when voice mode is on. TOGGLE to record: first
 * click starts the WavRecorder, second click stops → the WAV is transcribed
 * by OUR local ASR server via /api/tts/transcribe, and the resulting text is
 * sent as a normal user message through `onTranscript` (= chat.sendMessage).
 * The assistant's reply then auto-speaks only if the user opted into
 * `autoSpeakReplies` (a11y) — nothing to wire here for playback.
 *
 * The Space-bar shortcut also drives this same recorder from ChatLayout; this
 * component exposes its start/stop via the `controlRef` so a single Space
 * press toggles whichever phase we're in, matching the click toggle exactly.
 *
 * Fills the same vertical slot as the normal Input so the layout doesn't
 * shift when switching kinds.
 */
type TalkControls = { toggle: () => void };

function TalkInput({
  talkAvailable,
  onTranscript,
  controlRef,
}: {
  talkAvailable: boolean;
  onTranscript: (text: string) => void;
  /** ChatLayout hands a ref the Space-bar handler calls to toggle recording,
   *  so the keyboard path and the click path share one state machine. */
  controlRef?: React.MutableRefObject<TalkControls | null>;
}) {
  type Phase = "idle" | "recording" | "transcribing";
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<WavRecorder | null>(null);
  // Mirror of `phase` readable from the imperative toggle (avoids a stale
  // closure when ChatLayout calls through the ref).
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;

  // Release the mic if the component unmounts mid-recording (e.g. the user
  // navigates away while recording).
  useEffect(() => {
    return () => recorderRef.current?.cancel();
  }, []);

  async function startRecording() {
    if (!talkAvailable || phaseRef.current !== "idle") return;
    setError(null);
    const rec = new WavRecorder();
    recorderRef.current = rec;
    try {
      await rec.start();
    } catch (e) {
      recorderRef.current = null;
      setError((e as Error).message);
      setPhase("idle");
      return;
    }
    setPhase("recording");
  }

  async function stopRecording() {
    if (phaseRef.current !== "recording") return;
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) {
      setPhase("idle");
      return;
    }

    let blob: Blob;
    try {
      blob = await rec.stop();
    } catch {
      setPhase("idle");
      setError("Recording failed.");
      return;
    }
    if (blob.size <= 44) {
      // Header-only → no audio captured.
      setPhase("idle");
      return;
    }

    setPhase("transcribing");
    try {
      const text = await transcribeWav(blob);
      setPhase("idle");
      if (text) onTranscript(text);
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  }

  // First press records, second press stops+sends. Transcribing is busy → no-op.
  function toggle() {
    if (!talkAvailable) return;
    if (phaseRef.current === "idle") void startRecording();
    else if (phaseRef.current === "recording") void stopRecording();
  }

  // Expose the toggle to ChatLayout's Space-bar handler.
  useEffect(() => {
    if (!controlRef) return;
    controlRef.current = { toggle };
    return () => {
      controlRef.current = null;
    };
    // `toggle` closes over stable refs + setState only, so a one-time wire is
    // safe; re-running on every render would needlessly churn the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlRef, talkAvailable]);

  const busy = phase === "transcribing";
  const recording = phase === "recording";
  const label = !talkAvailable
    ? "Voice mode is off"
    : recording
      ? "Recording — click to send"
      : busy
        ? "Transcribing…"
        : "Click to talk";

  return (
    <div className="flex shrink-0 flex-col items-center justify-center gap-2 border-t border-gray-200 bg-white px-4 py-6">
      <button
        type="button"
        disabled={!talkAvailable || busy}
        aria-label={label}
        aria-pressed={recording}
        title={
          talkAvailable
            ? recording
              ? "Click to stop and send"
              : "Click to talk"
            : "Turn voice mode on to talk"
        }
        onClick={() => toggle()}
        className={`flex h-20 w-20 select-none items-center justify-center rounded-full text-white shadow-lg transition-all ${
          !talkAvailable
            ? "cursor-not-allowed bg-gray-300"
            : recording
              ? "scale-110 animate-pulse bg-red-500"
              : busy
                ? "cursor-wait bg-cyan/70"
                : "bg-cyan hover:scale-105 hover:opacity-95 active:scale-95"
        }`}
      >
        <BigMicIcon />
      </button>
      <span
        className={`text-[12px] ${
          error ? "text-red-600" : "text-gray-500"
        }`}
      >
        {error ?? label}
      </span>
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
