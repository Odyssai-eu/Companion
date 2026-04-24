import type { Message } from "~/data/mock";
import { messages } from "~/data/mock";

export default function Messages() {
  return (
    <div className="flex-1 overflow-y-auto px-8 py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        {messages.map((m) =>
          m.role === "user" ? (
            <UserBubble key={m.id} content={m.content} />
          ) : (
            <AssistantMessage key={m.id} message={m} />
          ),
        )}
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-[rgba(79,179,217,0.14)] px-5 py-4">
        <p className="text-[15px] leading-relaxed text-ink">{content}</p>
      </div>
    </div>
  );
}

function AssistantMessage({ message }: { message: Message }) {
  return (
    <div className="flex gap-4">
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[rgba(79,179,217,0.14)]">
        <span className="font-mono text-[11px] font-medium text-navy">[B]</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex flex-col gap-4 text-[15px] leading-relaxed text-ink">
          {message.content.split("\n\n").map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
        {message.stats && <StatsRow stats={message.stats} />}
        <ActionsRow />
      </div>
    </div>
  );
}

function StatsRow({ stats }: { stats: NonNullable<Message["stats"]> }) {
  const items = [
    ["TTFT", stats.ttft],
    ["Tokens", String(stats.tokens)],
    ["Speed", stats.speed],
    ["Ctx", stats.ctx],
    ["Cost", stats.cost],
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg border border-gray-200 bg-white px-5 py-3 font-mono text-[12px] text-gray-600">
      {items.map(([label, value]) => (
        <span key={label} className="flex items-center gap-2">
          <span className="text-gray-400">{label}</span>
          <span className="text-ink">{value}</span>
        </span>
      ))}
    </div>
  );
}

function ActionsRow() {
  const actions = [
    { label: "Copy", icon: <CopyIcon /> },
    { label: "Regenerate", icon: <RegenerateIcon /> },
    { label: "Speak", icon: <SpeakIcon /> },
    { label: "Save", icon: <SaveIcon /> },
  ];
  return (
    <div className="flex items-center gap-5 text-[12px] text-gray-400">
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          className="flex items-center gap-1.5 hover:text-ink"
        >
          {a.icon}
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  );
}

function CopyIcon() {
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
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function RegenerateIcon() {
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
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function SpeakIcon() {
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
      <path d="M11 5 6 9H2v6h4l5 4z" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}

function SaveIcon() {
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
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}
