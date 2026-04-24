type Style = "Creative" | "Normal" | "Code";

export default function TopBar() {
  const activeStyle: Style = "Normal";
  return (
    <header className="flex h-15 items-center justify-between border-b border-gray-200 bg-white px-6">
      <div className="flex items-center gap-3">
        <EngineBadge engine="exo" detail="4 nodes" />
        <ModelPicker model="gemma-4-31b-it-bf16" />
        <StyleTabs active={activeStyle} />
        <ToolsButton count={4} />
      </div>
      <div className="flex items-center gap-2">
        <IndicAIPill level={3} label="Practitioner" />
        <IconButton icon={<VoiceIcon />} label="Voice mode" />
        <IconButton icon={<SyncedIcon />} label="Synced" subtle />
      </div>
    </header>
  );
}

function EngineBadge({ engine, detail }: { engine: string; detail: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
      <span className="font-mono text-[12px] font-medium text-ink">
        {engine}
      </span>
      <span className="font-mono text-[11px] text-gray-400">· {detail}</span>
    </div>
  );
}

function ModelPicker({ model }: { model: string }) {
  return (
    <button
      type="button"
      className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-50"
    >
      <span className="font-mono text-[12px] text-ink">{model}</span>
      <EyeIcon />
      <ChevronDownIcon />
    </button>
  );
}

function StyleTabs({ active }: { active: Style }) {
  const tabs: Style[] = ["Creative", "Normal", "Code"];
  return (
    <div className="flex items-center gap-0.5 rounded-lg border border-gray-200 bg-white p-0.5">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
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

function ToolsButton({ count }: { count: number }) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-50"
    >
      <WrenchIcon />
      <span className="text-[12px] font-medium text-ink">Tools</span>
      <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[rgba(79,179,217,0.16)] px-1.5 font-mono text-[10px] font-medium text-navy">
        {count}
      </span>
    </button>
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

function IconButton({
  icon,
  label,
  subtle = false,
}: {
  icon: React.ReactNode;
  label: string;
  subtle?: boolean;
}) {
  return (
    <button
      type="button"
      className={`flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-[12px] ${
        subtle ? "text-gray-600" : "text-ink"
      } hover:bg-gray-50`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function EyeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-gray-400"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-gray-400"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function VoiceIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 12h2m4-7v14m4-10v6m4-8v10m4-6v2" />
    </svg>
  );
}

function SyncedIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 10h-1.26A8 8 0 1 0 9 20" />
      <path d="M13 16l4 4 4-4" />
    </svg>
  );
}
