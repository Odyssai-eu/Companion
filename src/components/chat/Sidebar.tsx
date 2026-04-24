import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type ApiConversation } from "~/lib/api";
import Wordmark from "../Wordmark";

type Props = {
  activeConversationId: string | null;
};

export default function Sidebar({ activeConversationId }: Props) {
  const [conversations, setConversations] = useState<ApiConversation[]>([]);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const { conversations } = await api.listConversations();
        if (!cancelled) setConversations(conversations);
      } catch {
        // ignore; empty list is fine for the shell
      }
    }
    refresh();
    const i = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, [activeConversationId]);

  const groups = groupByBucket(conversations);

  return (
    <aside className="flex h-full w-[280px] flex-col border-r border-gray-200 bg-white">
      <header className="px-4 pt-4 pb-3">
        <Wordmark size="sm" />
      </header>

      <div className="px-3 pb-3">
        <SearchInput />
      </div>

      <div className="px-3 pb-4">
        <button
          type="button"
          onClick={() => navigate("/")}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-navy px-3 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-95"
        >
          <PlusIcon />
          New conversation
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {groups.map((g) => (
          <Section key={g.title} title={g.title}>
            {g.items.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={c.id === activeConversationId}
              />
            ))}
          </Section>
        ))}

        {conversations.length === 0 && (
          <div className="mt-2 rounded-md px-2 py-3 text-[12px] text-gray-400">
            No conversations yet. Start one below.
          </div>
        )}
      </nav>

      <UserFooter />
    </aside>
  );
}

function groupByBucket(convos: ApiConversation[]) {
  const today: ApiConversation[] = [];
  const yesterday: ApiConversation[] = [];
  const older: ApiConversation[] = [];
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  for (const c of convos) {
    const t = new Date(c.updatedAt);
    if (t >= startOfToday) today.push(c);
    else if (t >= startOfYesterday) yesterday.push(c);
    else older.push(c);
  }
  return [
    { title: "Today", items: today },
    { title: "Yesterday", items: yesterday },
    { title: "Older", items: older },
  ].filter((g) => g.items.length > 0);
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 px-2">
        <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
          {title}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
}: {
  conversation: ApiConversation;
  active: boolean;
}) {
  const time = new Date(conversation.updatedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <Link
      to={`/c/${conversation.id}`}
      className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left transition-colors ${
        active
          ? "bg-[rgba(79,179,217,0.12)] text-navy"
          : "text-ink hover:bg-gray-50"
      }`}
    >
      <span
        className={`truncate text-[13px] ${active ? "font-medium" : "font-normal"}`}
      >
        {conversation.title}
      </span>
      <span className="font-mono text-[11px] text-gray-400">
        {conversation.model ? `${conversation.model} · ${time}` : time}
      </span>
    </Link>
  );
}

function SearchInput() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2">
      <SearchIcon />
      <input
        type="text"
        placeholder="Search"
        className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-gray-400"
      />
      <kbd className="font-mono text-[10px] text-gray-400">⌘K</kbd>
    </div>
  );
}

function UserFooter() {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-gray-200 px-3 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-navy">
          <span className="font-mono text-xs font-medium text-white">S</span>
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-ink">
            Sophie
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-gray-400">
            <SyncIcon />
            Pro · 3 devices
          </span>
        </div>
      </div>
      <Link
        to="/settings/servers"
        aria-label="Settings"
        className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-50 hover:text-ink"
      >
        <SettingsIcon />
      </Link>
    </div>
  );
}

function SyncIcon() {
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
      aria-label="Synced across devices"
    >
      <path d="M18 10h-1.26A8 8 0 1 0 9 20" />
      <path d="M13 16l4 4 4-4" />
    </svg>
  );
}

function SearchIcon() {
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
      className="text-gray-400"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function PlusIcon() {
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
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
