import { useEffect, useState } from "react";
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
};

export default function TopBar({
  activeStyle,
  onStyleChange,
  onTogglePanel,
  panelOpen,
  onOpenMobileSidebar,
}: Props) {
  const voiceMode = useVoiceMode();
  const isMobile = useIsMobile();

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
        </div>
      </div>
    </header>
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
