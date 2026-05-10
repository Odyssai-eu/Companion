import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "~/hooks/useAuth";
import { api, type ApiConversation, type ApiProject } from "~/lib/api";
import { ChatIcon, ProjectIcon } from "../ProjectIcon";
import Wordmark from "../Wordmark";

type Props = {
  activeConversationId: string | null;
  /** Active project id. When set, the sidebar filters conversations to that
   *  project; when null, only orphan conversations (no project) are shown.
   *  This mirrors ExoScopy's behaviour. */
  activeProjectId: string | null;
  /** Conversation currently streaming a reply, if any. */
  streamingConversationId?: string | null;
  /** Mobile drawer open/closed. Desktop ignores this. */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
};

export default function Sidebar({
  activeConversationId,
  activeProjectId,
  streamingConversationId,
  mobileOpen = false,
  onMobileClose,
}: Props) {
  const [conversations, setConversations] = useState<ApiConversation[]>([]);
  const [projectsList, setProjectsList] = useState<ApiProject[]>([]);
  const [search, setSearch] = useState("");
  const navigate = useNavigate();

  const refresh = async () => {
    try {
      const [{ conversations }, { projects }] = await Promise.all([
        api.listConversations(),
        api.listProjects(),
      ]);
      setConversations(conversations);
      setProjectsList(projects);
    } catch {
      // ignore; empty lists are fine for the shell
    }
  };

  useEffect(() => {
    let cancelled = false;
    async function safeRefresh() {
      if (cancelled) return;
      await refresh();
    }
    safeRefresh();
    const i = setInterval(safeRefresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, [activeConversationId, activeProjectId]);

  // ExoScopy filter: a conversation belongs to either a project or to "All
  // Chats" (orphans). When the user is inside a project, only that project's
  // conversations show. Otherwise only orphans.
  const projectFiltered = activeProjectId
    ? conversations.filter((c) => c.projectId === activeProjectId)
    : conversations.filter((c) => !c.projectId);

  const filtered = search.trim()
    ? projectFiltered.filter((c) => {
        const q = search.trim().toLowerCase();
        return (
          c.title.toLowerCase().includes(q) ||
          (c.lastMessage ?? "").toLowerCase().includes(q)
        );
      })
    : projectFiltered;
  const groups = groupByBucket(filtered);

  async function startNewConversation() {
    // If we're inside a project, the new conversation must inherit the
    // projectId so it shows up in this filtered list (and stays out of the
    // root "All Chats"). Mirrors ExoScopy.
    if (!activeProjectId) {
      navigate("/");
      return;
    }
    try {
      const { conversation } = await api.createConversation({
        projectId: activeProjectId,
        title: "New chat",
      });
      await refresh();
      navigate(`/c/${conversation.id}`);
    } catch {
      // fall back to plain new chat
      navigate("/");
    }
  }

  async function startNewTalk() {
    // Talk conversations always get created server-side so the route
    // /c/<id> can switch into TalkLayout based on conv.kind=='talk'.
    try {
      const { conversation } = await api.createConversation({
        projectId: activeProjectId ?? undefined,
        title: "New talk",
        kind: "talk",
      });
      await refresh();
      navigate(`/c/${conversation.id}`);
    } catch {
      // ignore; user can retry
    }
  }

  async function startNewHermes() {
    // Hermes conversations route directly to the Hermes Agent gateway
    // (skipping LiteLLM), so we tag them server-side via kind='hermes'
    // and the chat route picks the right backend at send time.
    try {
      const { conversation } = await api.createConversation({
        projectId: activeProjectId ?? undefined,
        title: "New Hermes",
        kind: "hermes",
      });
      await refresh();
      navigate(`/c/${conversation.id}`);
    } catch {
      // ignore; user can retry
    }
  }

  return (
    <>
      {mobileOpen && (
        <div
          onClick={onMobileClose}
          className="fixed inset-0 z-30 bg-black/30 md:hidden"
        />
      )}
    <aside
      className={`fixed top-0 left-0 z-40 flex h-full w-[280px] flex-col border-r border-gray-200 bg-white transition-transform md:static md:translate-x-0 ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <header className="px-4 pt-4 pb-3">
        <Wordmark size="sm" />
      </header>

      <div className="px-3 pb-3">
        <SearchInput value={search} onChange={setSearch} />
      </div>

      <div className="flex flex-col gap-1.5 px-3 pb-4">
        {/* Three buttons in a 2 / 1 / 1 split: a wide Chat (the default
         *  most-used path), a square Talk that's just a mic, and a square
         *  Hermes that's just the agent logo. Square buttons keep the icons
         *  centred without label fighting. */}
        <div className="grid grid-cols-4 gap-1.5">
          <button
            type="button"
            onClick={startNewConversation}
            className="col-span-2 flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-[13px] font-medium text-ink transition-colors hover:bg-gray-50"
          >
            Chat
          </button>
          <button
            type="button"
            onClick={startNewTalk}
            aria-label="New talk"
            title="New talk"
            className="flex items-center justify-center rounded-lg bg-cyan px-2 py-2.5 text-white transition-opacity hover:opacity-90"
          >
            <MicIcon size={16} />
          </button>
          <button
            type="button"
            onClick={startNewHermes}
            aria-label="New Hermes"
            title="New Hermes"
            className="flex items-center justify-center rounded-lg border border-gray-200 bg-white px-2 py-2.5 transition-colors hover:bg-gray-50"
          >
            <img
              src="/logo/hermes-agent-logo.svg"
              alt=""
              className="h-4 w-4"
            />
          </button>
        </div>
        {activeProjectId && (
          <button
            type="button"
            onClick={() => navigate("/")}
            className="text-center text-[12px] text-gray-500 hover:text-ink"
          >
            ← All chats
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        <Section
          title="Projects"
          trailing={
            <Link
              to="/projects/new"
              aria-label="New project"
              className="flex h-5 w-5 items-center justify-center rounded text-gray-400 hover:bg-gray-100 hover:text-ink"
            >
              <PlusIcon />
            </Link>
          }
        >
          <button
            type="button"
            onClick={() => navigate("/")}
            className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left transition-colors ${
              !activeProjectId
                ? "bg-[rgba(79,179,217,0.12)] text-navy"
                : "text-ink hover:bg-gray-50"
            }`}
          >
            <span className="flex min-w-0 items-center gap-2">
              <ChatIcon size={14} className="flex-shrink-0 text-gray-500" />
              <span
                className={`truncate text-[13px] ${
                  !activeProjectId ? "font-medium" : "font-normal"
                }`}
              >
                All chats
              </span>
            </span>
            <span className="font-mono text-[11px] text-gray-400">
              {conversations.filter((c) => !c.projectId).length}
            </span>
          </button>
          {projectsList.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              conversationCount={
                conversations.filter((c) => c.projectId === p.id).length
              }
              active={p.id === activeProjectId}
            />
          ))}
          {projectsList.length === 0 && (
            <span className="px-2 py-1 text-[11px] text-gray-400">
              No projects yet.
            </span>
          )}
        </Section>

        {groups.map((g) => (
          <Section key={g.title} title={g.title}>
            {g.items.map((c) => (
              <ConversationRow
                key={c.id}
                conversation={c}
                active={c.id === activeConversationId}
                streaming={c.id === streamingConversationId}
                projects={projectsList}
                onRemove={(id) =>
                  setConversations((prev) => prev.filter((x) => x.id !== id))
                }
                onChange={refresh}
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
    </>
  );
}

function groupByBucket(convos: ApiConversation[]) {
  // Pinned first as their own bucket. Then by createdAt — renaming or
  // pinning doesn't shuffle a conversation between buckets.
  const pinned: ApiConversation[] = [];
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
    if (c.pinned) {
      pinned.push(c);
      continue;
    }
    const t = new Date(c.createdAt);
    if (t >= startOfToday) today.push(c);
    else if (t >= startOfYesterday) yesterday.push(c);
    else older.push(c);
  }
  return [
    { title: "Pinned", items: pinned },
    { title: "Today", items: today },
    { title: "Yesterday", items: yesterday },
    { title: "Older", items: older },
  ].filter((g) => g.items.length > 0);
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between px-2">
        <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
          {title}
        </span>
        {trailing}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function ProjectRow({
  project,
  conversationCount,
  active,
}: {
  project: ApiProject;
  conversationCount: number;
  active: boolean;
}) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left transition-colors ${
        active
          ? "bg-[rgba(79,179,217,0.12)] text-navy"
          : "text-ink hover:bg-gray-50"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <ProjectIcon
          name={project.icon}
          size={14}
          className="flex-shrink-0 text-gray-500"
        />
        <span
          className={`truncate text-[13px] ${active ? "font-medium" : "font-normal"}`}
        >
          {project.name}
        </span>
      </span>
      {conversationCount > 0 && (
        <span className="font-mono text-[11px] text-gray-400">
          {conversationCount}
        </span>
      )}
    </Link>
  );
}

function PlusIcon() {
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
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function MicIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
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

function ConversationRow({
  conversation,
  active,
  streaming,
  projects,
  onRemove,
  onChange,
}: {
  conversation: ApiConversation;
  active: boolean;
  streaming?: boolean;
  projects: ApiProject[];
  /** Called with the deleted conversation id immediately after a successful
   *  DELETE — removes it from the parent's state without waiting for a
   *  re-fetch (ExoScopy pattern). */
  onRemove: (id: string) => void;
  onChange: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conversation.title);
  const navigate = useNavigate();
  const time = relativeTime(conversation.createdAt);
  const preview = conversation.lastMessage?.trim();

  async function commitRename() {
    setRenaming(false);
    const trimmed = draftTitle.trim();
    if (!trimmed || trimmed === conversation.title) return;
    try {
      await api.renameConversation(conversation.id, trimmed);
      onChange();
    } catch {
      // ignore
    }
  }

  async function onTogglePin(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      await api.pinConversation(conversation.id, !conversation.pinned);
      onChange();
    } catch {
      // ignore
    }
  }

  async function onDelete(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete "${conversation.title}"?`)) return;
    try {
      await api.deleteConversation(conversation.id);
      // ExoScopy pattern: immediately remove from parent state without
      // waiting for a re-fetch. Avoids the race where onChange() → refresh()
      // fails silently (swallowed catch) and the item reappears.
      onRemove(conversation.id);
      if (active) navigate("/");
    } catch (err) {
      console.error("delete failed", err);
      alert(`Couldn't delete: ${(err as Error).message ?? err}`);
    }
  }

  async function onProjectChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value || null;
    try {
      await api.moveConversationToProject(conversation.id, next);
      onChange();
    } catch {
      // ignore
    }
  }

  return (
    <div
      onClick={(e) => {
        if (renaming) return;
        if ((e.target as HTMLElement).closest("button,select,a,input")) return;
        navigate(`/c/${conversation.id}`);
      }}
      className={`group flex flex-col gap-1 rounded-lg px-3 py-2 transition-colors ${
        active
          ? "bg-[rgba(79,179,217,0.12)] text-navy"
          : "text-ink hover:bg-gray-50"
      } cursor-pointer`}
    >
      <div className="flex items-start justify-between gap-2">
        {renaming ? (
          <input
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter")
                (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") {
                setDraftTitle(conversation.title);
                setRenaming(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="min-w-0 flex-1 rounded border border-cyan bg-white px-1 py-0 text-[13px] font-medium text-ink outline-none"
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              setDraftTitle(conversation.title);
              setRenaming(true);
            }}
            className={`flex min-w-0 flex-1 items-center gap-1 truncate text-[13px] ${
              active ? "font-medium" : "font-normal"
            }`}
          >
            {streaming && (
              <span
                className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"
                title="Streaming reply"
              />
            )}
            {conversation.kind === "talk" && (
              <span
                aria-label="Talk conversation"
                className="mr-1.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-cyan"
              >
                <MicIcon size={15} />
              </span>
            )}
            {conversation.kind === "hermes" && (
              <img
                src="/logo/hermes-agent-logo.svg"
                alt=""
                aria-label="Hermes conversation"
                className="mr-1.5 inline-block h-4 w-4 flex-shrink-0"
              />
            )}
            {conversation.pinned && (
              <span className="mr-0.5 text-[10px] text-amber-500">📌</span>
            )}
            {conversation.title ||
              (conversation.kind === "talk"
                ? "New talk"
                : conversation.kind === "hermes"
                  ? "New Hermes"
                  : "New conversation")}
          </span>
        )}
        <span className="flex-shrink-0 font-mono text-[11px] text-gray-400">
          {time}
        </span>
      </div>

      {preview && (
        <span className="truncate text-[12px] text-gray-400">{preview}</span>
      )}

      <div className="hidden flex-col gap-1 group-hover:flex">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onTogglePin}
              className={`text-[10px] ${
                conversation.pinned ? "text-amber-500" : "text-gray-400"
              } hover:text-amber-600`}
            >
              {conversation.pinned ? "Unpin" : "Pin"}
            </button>
            <a
              href={api.exportConversationUrl(conversation.id)}
              download
              onClick={(e) => e.stopPropagation()}
              className="text-[10px] text-cyan hover:text-navy"
            >
              ↓ MD
            </a>
            <a
              href={api.exportConversationJsonUrl(conversation.id)}
              download
              onClick={(e) => e.stopPropagation()}
              className="text-[10px] text-cyan hover:text-navy"
            >
              ↓ JSON
            </a>
          </div>
          <button
            type="button"
            onClick={onDelete}
            className="text-[10px] text-red-400 hover:text-red-600"
          >
            Delete
          </button>
        </div>
        {projects.length > 0 && (
          <select
            value={conversation.projectId ?? ""}
            onClick={(e) => e.stopPropagation()}
            onChange={onProjectChange}
            className="w-full cursor-pointer rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-600"
          >
            <option value="">No project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  return new Date(iso).toLocaleDateString();
}

function SearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 focus-within:border-cyan">
      <SearchIcon />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search conversations"
        className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-gray-400"
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="font-mono text-[12px] text-gray-400 hover:text-ink"
        >
          ✕
        </button>
      ) : (
        <kbd className="font-mono text-[10px] text-gray-400">⌘K</kbd>
      )}
    </div>
  );
}

function UserFooter() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const initial = (user?.name ?? user?.email ?? "?").trim().charAt(0).toUpperCase();
  const displayName = user?.name ?? user?.email?.split("@")[0] ?? "Guest";

  async function onLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="flex items-center justify-between gap-2 border-t border-gray-200 px-3 py-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-navy">
          <span className="font-mono text-xs font-medium text-white">
            {initial}
          </span>
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[13px] font-medium text-ink">
            {displayName}
          </span>
          <span className="flex items-center gap-1 font-mono text-[11px] text-gray-400">
            <SyncIcon />
            Pro · 3 devices
          </span>
        </div>
      </div>
      <div className="flex items-center gap-0.5">
        <Link
          to="/files"
          aria-label="Files"
          title="Files"
          className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-50 hover:text-ink"
        >
          <FolderIcon />
        </Link>
        <button
          type="button"
          onClick={onLogout}
          aria-label="Sign out"
          title="Sign out"
          className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-50 hover:text-ink"
        >
          <LogoutIcon />
        </button>
        <Link
          to="/settings/servers"
          aria-label="Settings"
          className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-50 hover:text-ink"
        >
          <SettingsIcon />
        </Link>
      </div>
    </div>
  );
}

function LogoutIcon() {
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
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
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

function FolderIcon() {
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
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
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
