/**
 * Inline repo-binding bar for kind='hermes' conversations.
 *
 * Lives between the TopBar and the message stream. Shows:
 * - the currently bound repo path (click-to-edit)
 * - live git status when the bridge is up (branch, ahead/behind, dirty count)
 * - a "Changes" button that opens the inline diff viewer
 *
 * Polls /api/hermes-bridge/git/status every 5s while a path is bound. If
 * the bridge is unreachable, the chip degrades silently to just the path.
 */

import { useEffect, useRef, useState } from "react";
import { api } from "~/lib/api";
import DiffPanel from "./DiffPanel";

type GitStatus = Awaited<ReturnType<typeof api.hermesBridgeGitStatus>>;

type Props = {
  conversationId: string;
  repoPath: string | null;
  onChange?: (next: string | null) => void;
};

export default function RepoBindingBar({
  conversationId,
  repoPath,
  onChange,
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(repoPath ?? "");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusErr, setStatusErr] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(repoPath ?? "");
  }, [repoPath]);

  useEffect(() => {
    if (editing) queueMicrotask(() => inputRef.current?.focus());
  }, [editing]);

  // Poll git status every 5s while a path is bound + the panel isn't being edited.
  useEffect(() => {
    if (!repoPath) {
      setStatus(null);
      setStatusErr(false);
      return;
    }
    let alive = true;
    async function tick() {
      try {
        const s = await api.hermesBridgeGitStatus(repoPath!);
        if (alive) {
          setStatus(s);
          setStatusErr(false);
        }
      } catch {
        if (alive) {
          setStatusErr(true);
          setStatus(null);
        }
      }
    }
    void tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [repoPath]);

  async function save() {
    if (busy) return;
    const next = draft.trim() || null;
    if (next === (repoPath ?? null)) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await api.setConversationRepoPath(conversationId, next);
      onChange?.(next);
    } catch {
      // ignore — existing value still in DB
    } finally {
      setBusy(false);
      setEditing(false);
    }
  }

  function cancel() {
    setDraft(repoPath ?? "");
    setEditing(false);
  }

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  }

  const dirtyCount = status
    ? status.staged.length +
      status.modified.length +
      status.untracked.length +
      status.deleted.length
    : 0;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-50 px-4 py-1.5 text-[12px]">
        <FolderIcon />
        <span className="text-gray-500">Repo</span>
        {editing ? (
          <>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              placeholder="/Users/admin/repos/my-project"
              disabled={busy}
              className="flex-1 rounded border border-gray-200 bg-white px-2 py-0.5 font-mono text-[11px] text-ink outline-none focus:border-cyan"
            />
            <button
              type="button"
              onClick={save}
              disabled={busy}
              className="rounded bg-navy px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-95 disabled:opacity-50"
            >
              {busy ? "…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="text-[11px] text-gray-500 hover:text-ink"
            >
              Cancel
            </button>
          </>
        ) : repoPath ? (
          <>
            <code className="font-mono text-ink">{repoPath}</code>
            {status && (
              <>
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 font-mono text-[10px] text-gray-600 ring-1 ring-gray-200">
                  <BranchIcon />
                  {status.branch}
                  {status.ahead > 0 && (
                    <span className="text-emerald-600">↑{status.ahead}</span>
                  )}
                  {status.behind > 0 && (
                    <span className="text-amber-600">↓{status.behind}</span>
                  )}
                </span>
                {dirtyCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setDiffOpen(true)}
                    className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[10px] text-amber-800 hover:bg-amber-200"
                    title="Open diff viewer"
                  >
                    {dirtyCount} change{dirtyCount > 1 ? "s" : ""}
                  </button>
                )}
              </>
            )}
            {statusErr && (
              <span
                className="ml-2 inline-flex rounded-full bg-rose-100 px-2 py-0.5 font-mono text-[10px] text-rose-700"
                title="Bridge unreachable — git status disabled"
              >
                bridge offline
              </span>
            )}
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ml-auto text-[11px] text-cyan hover:underline"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={async () => {
                setBusy(true);
                try {
                  await api.setConversationRepoPath(conversationId, null);
                  onChange?.(null);
                } finally {
                  setBusy(false);
                }
              }}
              className="text-[11px] text-gray-500 hover:text-rose-600"
            >
              Clear
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-cyan hover:underline"
          >
            Bind a repo…
          </button>
        )}
      </div>

      {diffOpen && repoPath && status && (
        <DiffPanel
          repoPath={repoPath}
          status={status}
          onClose={() => setDiffOpen(false)}
        />
      )}
    </>
  );
}

function FolderIcon() {
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
      className="text-gray-400"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function BranchIcon() {
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
    >
      <circle cx="6" cy="3" r="2" />
      <circle cx="6" cy="21" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 5v14M18 11v3a4 4 0 0 1-4 4H6" />
    </svg>
  );
}
