import type { ApiServer } from "~/lib/api";
import ModelPicker from "./ModelPicker";
import ToolsMenu from "./ToolsMenu";

export type ChatStyle = "Creative" | "Normal" | "Code" | "Custom";

type Props = {
  activeServer: ApiServer | null;
  model: string | null;
  onModelChange: (model: string) => void;
  activeStyle: ChatStyle;
  onStyleChange: (style: ChatStyle) => void;
  onTogglePanel: () => void;
  panelOpen: boolean;
};

export default function TopBar({
  activeServer,
  model,
  onModelChange,
  activeStyle,
  onStyleChange,
  onTogglePanel,
  panelOpen,
}: Props) {
  return (
    <header className="flex flex-col border-b border-gray-200 bg-white">
      {/* Line 1 — server + model / IndicAI */}
      <div className="flex items-center justify-between gap-3 px-6 pt-3 pb-1.5">
        <div className="flex items-center gap-3">
          {activeServer ? (
            <EngineBadge
              engine={activeServer.name}
              detail={engineKindLabel(activeServer.engineKind)}
            />
          ) : (
            <EngineBadge engine="No server" detail="Add one in Settings" />
          )}
          <ModelPicker
            serverId={activeServer?.id ?? null}
            model={model}
            onChange={onModelChange}
          />
        </div>
        <IndicAIPill level={3} label="Practitioner" />
      </div>

      {/* Line 2 — style tabs + Tools / Voice icon */}
      <div className="flex items-center justify-between gap-3 px-6 pt-1 pb-3">
        <div className="flex items-center gap-3">
          <StyleTabs active={activeStyle} onChange={onStyleChange} />
          <button
            type="button"
            onClick={onTogglePanel}
            aria-label={panelOpen ? "Close inference settings" : "Open inference settings"}
            className={`flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${
              panelOpen
                ? "border-navy bg-navy text-white"
                : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50 hover:text-ink"
            }`}
            title="Inference settings"
          >
            <SlidersIcon />
          </button>
          <ToolsMenu />
        </div>
        <button
          type="button"
          aria-label="Voice mode"
          title="Voice mode"
          className="flex h-8 w-8 items-center justify-center rounded-full border border-gray-200 bg-white text-ink transition-colors hover:bg-gray-50"
        >
          <VoiceIcon />
        </button>
      </div>
    </header>
  );
}

function engineKindLabel(kind: "openai-compat" | "anthropic") {
  return kind === "anthropic" ? "Anthropic" : "OpenAI-compat";
}

function EngineBadge({ engine, detail }: { engine: string; detail: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      <span className="max-w-[180px] truncate font-mono text-[12px] font-medium text-ink">
        {engine}
      </span>
      <span className="font-mono text-[11px] text-gray-400">· {detail}</span>
    </div>
  );
}

function StyleTabs({
  active,
  onChange,
}: {
  active: ChatStyle;
  onChange: (s: ChatStyle) => void;
}) {
  const tabs: ChatStyle[] = ["Creative", "Normal", "Code", "Custom"];
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

function IndicAIPill({ level, label }: { level: number; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1">
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <span
            key={i}
            className={`h-2.5 w-1 rounded-sm ${
              i <= level ? "bg-cyan" : "bg-gray-200"
            }`}
          />
        ))}
      </div>
      <span className="font-mono text-[11px] text-gray-600">IndicAI</span>
      <span className="text-[12px] font-medium text-navy">{label}</span>
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
