import { useEffect, useState } from "react";
import { useA11yPrefs } from "~/hooks/useA11yPrefs";
import { useIsMobile } from "~/hooks/useIsMobile";
import { useVoiceMode } from "~/hooks/useVoiceMode";
import { api, type ApiInferenceStatus } from "~/lib/api";
import ToolsMenu from "./ToolsMenu";

export type ChatStyle = "Creative" | "Normal" | "Code" | "Custom";

type Props = {
  activeStyle: ChatStyle;
  onStyleChange: (style: ChatStyle) => void;
  onTogglePanel: () => void;
  panelOpen: boolean;
  onOpenMobileSidebar?: () => void;
  conversationId?: string | null;
  memoryEnabled?: boolean;
  onToggleMemory?: () => void;
  agentMode?: boolean;
  onToggleAgentMode?: () => void;
  /** Hide the memory toggle + 'remember now' chips entirely. Used for
   *  Hermes conversations where memory wiki injection is suppressed
   *  server-side (Hermes runs its own retrieval skills). */
  hideMemoryControls?: boolean;
};

export default function TopBar({
  activeStyle,
  onStyleChange,
  onTogglePanel,
  panelOpen,
  onOpenMobileSidebar,
  conversationId,
  memoryEnabled = true,
  onToggleMemory,
  agentMode = false,
  onToggleAgentMode,
  hideMemoryControls = false,
}: Props) {
  const voiceMode = useVoiceMode();
  const isMobile = useIsMobile();
  const a11y = useA11yPrefs();

  // Mobile gets a single thin row: hamburger + Creative/Normal/Code tabs +
  // voice. We drop the inference-settings sliders, Custom tab, and ToolsMenu —
  // those are admin/power-user surfaces, not consumer ones.
  if (isMobile) {
    return (
      <header className="flex items-center justify-between gap-2 border-b border-gray-200 bg-white px-3 py-2">
        <button
          type="button"
          onClick={onOpenMobileSidebar}
          aria-label="Open sidebar"
          className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-ink hover:bg-gray-50"
        >
          <HamburgerIcon />
        </button>
        <StyleTabs
          active={activeStyle}
          onChange={onStyleChange}
          tabs={["Creative", "Normal", "Code"]}
        />
        <div className="flex items-center gap-1.5">
          {!hideMemoryControls && (
            <>
              <AgentModeToggleButton
                enabled={agentMode}
                onToggle={onToggleAgentMode}
                disabled={!conversationId}
                compact
              />
              <MemoryToggleButton
                enabled={memoryEnabled}
                onToggle={onToggleMemory}
                disabled={!conversationId}
                compact
              />
              <RememberNowButton
                conversationId={memoryEnabled ? conversationId ?? null : null}
                compact
              />
            </>
          )}
          {a11y.voiceUiVisible && (
            <button
              type="button"
              onClick={voiceMode.toggle}
              aria-label="Voice mode"
              aria-pressed={voiceMode.enabled}
              className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full border transition-colors ${
                voiceMode.enabled
                  ? "border-cyan bg-cyan text-white"
                  : "border-gray-200 bg-white text-ink hover:bg-gray-50"
              }`}
            >
              <VoiceIcon />
            </button>
          )}
        </div>
      </header>
    );
  }

  return (
    <header className="flex flex-col border-b border-gray-200 bg-white">
      {/* Line 1 — Last seen + nothing else (model picker now lives in the composer) */}
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1.5 md:px-6">
        <div className="flex items-center gap-3" />
        <LastSeenBadge />
      </div>

      {/* Line 2 — style tabs / Tools + Voice icon */}
      <div className="flex items-center justify-between gap-3 px-6 pt-1 pb-3">
        <div className="flex items-center gap-3">
          <StyleTabs active={activeStyle} onChange={onStyleChange} />
          <button
            type="button"
            onClick={onTogglePanel}
            aria-label={
              panelOpen ? "Close inference settings" : "Open inference settings"
            }
            className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
              panelOpen
                ? "border-navy bg-navy text-white"
                : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-ink"
            }`}
            title="Inference settings"
          >
            <SlidersIcon />
          </button>
        </div>
        <div className="flex items-center gap-3">
          <ToolsMenu />
          {!hideMemoryControls && (
            <>
              <AgentModeToggleButton
                enabled={agentMode}
                onToggle={onToggleAgentMode}
                disabled={!conversationId}
              />
              <MemoryToggleButton
                enabled={memoryEnabled}
                onToggle={onToggleMemory}
                disabled={!conversationId}
              />
              <RememberNowButton
                conversationId={memoryEnabled ? conversationId ?? null : null}
              />
            </>
          )}
          {a11y.voiceUiVisible && (
            <button
              type="button"
              onClick={voiceMode.toggle}
              aria-label="Voice mode"
              aria-pressed={voiceMode.enabled}
              title={
                voiceMode.enabled
                  ? "Voice mode ON — answers spoken"
                  : "Voice mode OFF"
              }
              className={`flex h-8 w-8 items-center justify-center rounded-full border transition-colors ${
                voiceMode.enabled
                  ? "border-cyan bg-cyan text-white"
                  : "border-gray-200 bg-white text-ink hover:bg-gray-50"
              }`}
            >
              <VoiceIcon />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

/**
 * "Remember now" — forces the memory wiki to recompile from this conversation
 * and re-snapshots it for the rest of the conversation. Used when the user
 * has shared something important they want the model to remember in this
 * thread (and future ones). The compile is synchronous and can take 30-90s
 * depending on conversation length, so we show a clear loading state.
 */
function RememberNowButton({
  conversationId,
  compact = false,
}: {
  conversationId: string | null;
  compact?: boolean;
}) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">(
    "idle",
  );

  // Reset to idle when the user switches conversation.
  useEffect(() => {
    setState("idle");
  }, [conversationId]);

  // Auto-clear "done" / "error" after 3s so the icon goes back to neutral.
  useEffect(() => {
    if (state === "done" || state === "error") {
      const t = setTimeout(() => setState("idle"), 3000);
      return () => clearTimeout(t);
    }
  }, [state]);

  const disabled = !conversationId || state === "loading";
  const title = !conversationId
    ? "Start a conversation first"
    : state === "loading"
      ? "Consolidating memory…"
      : state === "done"
        ? "Memory updated"
        : state === "error"
          ? "Memory update failed — try again"
          : "Remember now — consolidate this conversation into your memory wiki";

  async function onClick() {
    if (!conversationId || state === "loading") return;
    setState("loading");
    try {
      const r = await api.refreshConversationMemory(conversationId);
      setState(r.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  const size = compact ? "h-11 w-11" : "h-8 w-8";
  const ringColor =
    state === "loading"
      ? "border-cyan text-cyan"
      : state === "done"
        ? "border-emerald-500 text-emerald-500"
        : state === "error"
          ? "border-red-400 text-red-500"
          : "border-gray-200 bg-white text-ink hover:bg-gray-50";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Remember now"
      title={title}
      className={`flex ${size} flex-shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${ringColor}`}
    >
      {state === "loading" ? <SmallSpinner /> : <BookmarkIcon />}
    </button>
  );
}

/**
 * Memory ON/OFF toggle. When OFF, the wiki is neither read nor injected
 * into this conversation's prompt, and "Remember now" is disabled. The
 * default for new conversations is inherited from their parent project
 * (Settings → Project → Memory toggle).
 */
function MemoryToggleButton({
  enabled,
  onToggle,
  disabled,
  compact = false,
}: {
  enabled: boolean;
  onToggle?: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const size = compact ? "h-11 w-11" : "h-8 w-8";
  const ringColor = enabled
    ? "border-cyan bg-white text-cyan hover:bg-cyan/5"
    : "border-gray-200 bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-600";
  const title = !disabled
    ? enabled
      ? "Memory ON — wiki is injected into this conversation's prompt. Click to disable."
      : "Memory OFF — wiki is not used in this conversation. Click to enable."
    : "Start a conversation to toggle memory";
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || !onToggle}
      aria-label={enabled ? "Disable memory" : "Enable memory"}
      aria-pressed={enabled}
      title={title}
      className={`flex ${size} flex-shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${ringColor}`}
    >
      <MemoryIcon strikethrough={!enabled} />
    </button>
  );
}

/**
 * AgentModeToggleButton: per-conversation switch to inject the tool
 * surface (fs_*, rag_search, web_*, MCP servers). When OFF (default),
 * Companion sends ZERO tool defs — the prompt stays small (~250 tok)
 * and the engine streams freely (no `shouldUseNonStream` forcing on
 * jaccl backends). User flips ON when they want agentic capability.
 */
function AgentModeToggleButton({
  enabled,
  onToggle,
  disabled,
  compact = false,
}: {
  enabled: boolean;
  onToggle?: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const size = compact ? "h-11 w-11" : "h-8 w-8";
  const ringColor = enabled
    ? "border-amber-500 bg-white text-amber-600 hover:bg-amber-50"
    : "border-gray-200 bg-gray-50 text-gray-400 hover:bg-gray-100 hover:text-gray-600";
  const title = !disabled
    ? enabled
      ? "Agent mode ON — fs / rag / web / MCP tools are exposed to the model. Heavier prompt, non-streaming on jaccl. Click to disable."
      : "Agent mode OFF — no tools injected, prompt stays small, engine streams freely. Click to enable."
    : "Start a conversation to toggle agent mode";
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || !onToggle}
      aria-label={enabled ? "Disable agent mode" : "Enable agent mode"}
      aria-pressed={enabled}
      title={title}
      className={`flex ${size} flex-shrink-0 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${ringColor}`}
    >
      <AgentIcon dim={!enabled} />
    </button>
  );
}

function AgentIcon({ dim = false }: { dim?: boolean }) {
  // A wrench-shaped glyph — same stroke language as the memory brain.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={dim ? { opacity: 1 } : undefined}
    >
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-2.4 2.6-2.6z" />
    </svg>
  );
}

function MemoryIcon({ strikethrough = false }: { strikethrough?: boolean }) {
  // A "brain" silhouette built from arcs — same stroke language as the
  // other inline SVGs (1.75 stroke, rounded caps).
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 1 5 3 3 0 0 0 4 4 3 3 0 0 0 3-3V3z" />
      <path d="M15 3a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-1 5 3 3 0 0 1-4 4 3 3 0 0 1-3-3V3z" />
      {strikethrough && <line x1="4" y1="20" x2="20" y2="4" />}
    </svg>
  );
}

function BookmarkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function SmallSpinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

/**
 * Discrete "Last seen" indicator — replaces the IndicAI gauge. Shows when the
 * user last sent a message anywhere on the platform. Refreshes every 60s.
 */
function LastSeenBadge() {
  const [status, setStatus] = useState<ApiInferenceStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.inferenceStatus().then(
        (s) => !cancelled && setStatus(s),
        () => undefined,
      );
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!status) return null;

  const label = status.lastInteractionAt
    ? formatAgo(new Date(status.lastInteractionAt))
    : "first time";

  return (
    <div
      className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1"
      title={
        status.lastInteractionAt
          ? `Last interaction at ${new Date(status.lastInteractionAt).toLocaleString()}`
          : "Welcome — no interactions yet"
      }
    >
      <span className="h-1.5 w-1.5 rounded-full bg-cyan" />
      <span className="font-mono text-[11px] text-gray-500">Last seen</span>
      <span className="text-[12px] font-medium text-navy">{label}</span>
    </div>
  );
}

function formatAgo(d: Date): string {
  const ms = Date.now() - d.getTime();
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function StyleTabs({
  active,
  onChange,
  tabs = ["Creative", "Normal", "Code", "Custom"],
}: {
  active: ChatStyle;
  onChange: (s: ChatStyle) => void;
  tabs?: ChatStyle[];
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-gray-200 bg-white p-0.5">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          onClick={() => onChange(tab)}
          className={`rounded-md px-3 py-1 text-[12px] transition-colors ${
            active === tab
              ? "bg-gray-50 font-medium text-ink"
              : "font-normal text-gray-400 hover:text-ink"
          }`}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

function SlidersIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function VoiceIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}
