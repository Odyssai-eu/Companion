import { Link } from "react-router";
import { conversations, projects, type Conversation } from "~/data/mock";
import Wordmark from "../Wordmark";

export default function Sidebar() {
  const today = conversations.filter((c) => c.bucket === "today");
  const yesterday = conversations.filter((c) => c.bucket === "yesterday");

  return (
    <aside className="flex h-full w-[280px] flex-col border-r border-gray-200 bg-white">
      <header className="px-4 pt-4 pb-3">
        <Wordmark size="sm" />
      </header>

      <div className="px-3 pb-3">
        <SearchInput />
      </div>

      <div className="px-3 pb-4">
        <NewConversationButton />
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        <Section title="Projects" rightSlot={<AddButton />}>
          {projects.map((p) => (
            <ProjectRow key={p.id} name={p.name} count={p.count} />
          ))}
        </Section>

        <Section title="Today">
          {today.map((c) => (
            <ConversationRow
              key={c.id}
              conversation={c}
              active={c.id === "c1"}
            />
          ))}
        </Section>

        <Section title="Yesterday">
          {yesterday.map((c) => (
            <ConversationRow key={c.id} conversation={c} />
          ))}
        </Section>
      </nav>

      <UserFooter />
    </aside>
  );
}

function Section({
  title,
  rightSlot,
  children,
}: {
  title: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
          {title}
        </span>
        {rightSlot}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function ConversationRow({
  conversation,
  active = false,
}: {
  conversation: Conversation;
  active?: boolean;
}) {
  return (
    <button
      type="button"
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
        {conversation.engine}
        {conversation.time && (
          <>
            {" · "}
            {conversation.time}
          </>
        )}
      </span>
    </button>
  );
}

function ProjectRow({ name, count }: { name: string; count: number }) {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-gray-50"
    >
      <span className="flex min-w-0 items-center gap-2">
        <FolderIcon />
        <span className="truncate text-[13px] text-ink">{name}</span>
      </span>
      <span className="font-mono text-[11px] text-gray-400">{count}</span>
    </button>
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

function NewConversationButton() {
  return (
    <button
      type="button"
      className="flex w-full items-center justify-center gap-2 rounded-lg bg-navy px-3 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-95"
    >
      <PlusIcon />
      New conversation
    </button>
  );
}

function AddButton() {
  return (
    <button
      type="button"
      aria-label="New project"
      className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-ink"
    >
      <PlusIcon />
    </button>
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
          <span className="font-mono text-[11px] text-gray-400">
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

function FolderIcon() {
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
      className="flex-shrink-0 text-gray-400"
    >
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
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
