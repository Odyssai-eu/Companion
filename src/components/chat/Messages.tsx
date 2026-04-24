import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "~/hooks/useChat";

export default function Messages({
  messages,
  error,
}: {
  messages: UIMessage[];
  error: string | null;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0 && !error) {
    return (
      <div className="flex flex-1 items-center justify-center px-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <img
            src="/logo/icon-192.png"
            alt=""
            className="h-14 w-14 rounded-full opacity-70"
          />
          <p className="font-display text-[20px] font-light text-navy">
            What would you like to ask your cluster?
          </p>
          <p className="text-[13px] text-gray-400">
            Your conversations stay on your hardware.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-8 py-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-10">
        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 font-mono text-[12px] text-red-700">
            {error}
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <UserBubble key={m.id} content={m.content} />
          ) : (
            <AssistantMessage key={m.id} message={m} />
          ),
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl bg-[rgba(79,179,217,0.14)] px-5 py-4">
        <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-ink">
          {content}
        </p>
      </div>
    </div>
  );
}

function AssistantMessage({ message }: { message: UIMessage }) {
  const thinking = !message.content && (message.streaming || !!message.reasoning);
  return (
    <div className="flex gap-4">
      <img
        src="/logo/icon-192.png"
        alt="Bear"
        className="h-8 w-8 flex-shrink-0 rounded-full"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {message.reasoning && (
          <ReasoningBlock
            reasoning={message.reasoning}
            thinking={thinking}
          />
        )}
        <div className="flex flex-col gap-4 text-[15px] leading-relaxed text-ink">
          {message.content ? (
            message.content.split("\n\n").map((para, i) => (
              <p key={i} className="whitespace-pre-wrap">
                {para}
              </p>
            ))
          ) : (
            !message.reasoning && (
              <span className="inline-flex items-center gap-2 text-[14px] text-gray-400">
                <TypingDots />
              </span>
            )
          )}
          {message.streaming && message.content && (
            <span className="inline-block h-4 w-0.5 animate-pulse bg-cyan align-middle" />
          )}
        </div>
        {message.stats && !message.streaming && <StatsRow stats={message.stats} />}
        {!message.streaming && message.content && <ActionsRow />}
      </div>
    </div>
  );
}

function ReasoningBlock({
  reasoning,
  thinking,
}: {
  reasoning: string;
  thinking: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 font-mono text-[11px] tracking-[0.04em] text-gray-600 uppercase">
          {thinking ? (
            <>
              <TypingDots />
              <span>Thinking</span>
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-cyan" />
              <span>Thought</span>
            </>
          )}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-gray-200 px-4 py-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap text-gray-600">
          {reasoning}
        </div>
      )}
    </div>
  );
}

function TypingDots() {
  return (
    <span className="flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400 [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-gray-400" />
    </span>
  );
}

function StatsRow({ stats }: { stats: NonNullable<UIMessage["stats"]> }) {
  const items = [
    stats.ttft && ["TTFT", stats.ttft],
    stats.tokens !== undefined && ["Tokens", String(stats.tokens)],
    stats.speed && ["Speed", stats.speed],
    stats.cost && ["Cost", stats.cost],
  ].filter(Boolean) as [string, string][];

  if (items.length === 0) return null;

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
