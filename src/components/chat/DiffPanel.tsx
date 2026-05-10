/**
 * Side-drawer diff viewer for a Hermes-bound repo.
 *
 * Lists changed files (staged / modified / untracked / deleted) in a left
 * column. Selecting one fetches its unified diff via the bridge and
 * renders it in the right pane with classic green/red coloring per line.
 *
 * Read-only — no accept/reject here. Hermes itself owns the working tree;
 * the user staging/committing happens via the agent. This panel is just a
 * scope of "what has the agent changed so far".
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "~/lib/api";

type GitStatus = Awaited<ReturnType<typeof api.hermesBridgeGitStatus>>;

type FileEntry = {
  path: string;
  kind: "staged" | "modified" | "untracked" | "deleted";
};

export default function DiffPanel({
  repoPath,
  status,
  onClose,
}: {
  repoPath: string;
  status: GitStatus;
  onClose: () => void;
}) {
  const entries: FileEntry[] = useMemo(() => {
    const out: FileEntry[] = [];
    for (const p of status.staged) out.push({ path: p, kind: "staged" });
    for (const p of status.modified) {
      if (!out.some((e) => e.path === p)) out.push({ path: p, kind: "modified" });
    }
    for (const p of status.deleted) out.push({ path: p, kind: "deleted" });
    for (const p of status.untracked) out.push({ path: p, kind: "untracked" });
    return out;
  }, [status]);

  const [selected, setSelected] = useState<FileEntry | null>(entries[0] ?? null);
  const [diffText, setDiffText] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Esc to close — symmetric with VoiceLiveOverlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!selected) {
      setDiffText("");
      return;
    }
    if (selected.kind === "untracked") {
      // No diff against HEAD for untracked files — show a marker.
      setDiffText(`# Untracked file: ${selected.path}\n\n(Open the file directly to see its contents — not tracked yet.)`);
      setErr(null);
      return;
    }
    setLoading(true);
    setErr(null);
    api
      .hermesBridgeGitDiff(repoPath, {
        path: selected.path,
        staged: selected.kind === "staged",
      })
      .then(({ diff }) => setDiffText(diff || "# (empty diff)"))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [repoPath, selected]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/30"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[1100px] flex-col bg-white shadow-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-gray-200 px-5 py-3">
          <div className="flex items-center gap-3">
            <span className="font-display text-[18px] font-light text-navy">
              Changes
            </span>
            <code className="font-mono text-[12px] text-gray-500">{repoPath}</code>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-[13px] text-gray-500 hover:bg-gray-100 hover:text-ink"
          >
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-gray-50">
            {entries.length === 0 ? (
              <span className="px-4 py-3 text-[12px] text-gray-500">
                Working tree clean.
              </span>
            ) : (
              entries.map((e) => (
                <button
                  key={`${e.kind}:${e.path}`}
                  type="button"
                  onClick={() => setSelected(e)}
                  className={`flex items-center gap-2 border-b border-gray-100 px-3 py-2 text-left font-mono text-[11px] transition-colors ${
                    selected?.path === e.path && selected.kind === e.kind
                      ? "bg-white text-ink"
                      : "text-gray-700 hover:bg-white"
                  }`}
                >
                  <KindBadge kind={e.kind} />
                  <span className="truncate">{e.path}</span>
                </button>
              ))
            )}
          </nav>

          <section className="min-w-0 flex-1 overflow-y-auto bg-white">
            {loading && (
              <div className="px-6 py-4 font-mono text-[12px] text-gray-400">
                Loading diff…
              </div>
            )}
            {err && (
              <div className="m-4 rounded border border-rose-200 bg-rose-50 px-3 py-2 font-mono text-[11px] text-rose-700">
                {err}
              </div>
            )}
            {!loading && !err && diffText && (
              <DiffView text={diffText} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: FileEntry["kind"] }) {
  const map: Record<FileEntry["kind"], { label: string; cls: string }> = {
    staged: { label: "S", cls: "bg-emerald-100 text-emerald-700" },
    modified: { label: "M", cls: "bg-amber-100 text-amber-700" },
    untracked: { label: "?", cls: "bg-cyan/20 text-cyan" },
    deleted: { label: "D", cls: "bg-rose-100 text-rose-700" },
  };
  const m = map[kind];
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded text-[9px] font-bold ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

function DiffView({ text }: { text: string }) {
  // Classic patch coloring: green for +lines, red for -, ink for @@-headers,
  // gray for context. Each line is rendered as its own row so long files
  // don't break the layout.
  const lines = text.split("\n");
  return (
    <pre className="overflow-x-auto px-6 py-4 font-mono text-[11.5px] leading-[18px]">
      {lines.map((line, i) => {
        let cls = "text-gray-700";
        if (line.startsWith("+++") || line.startsWith("---")) cls = "text-ink font-medium";
        else if (line.startsWith("@@")) cls = "text-cyan font-medium";
        else if (line.startsWith("+")) cls = "bg-emerald-50 text-emerald-800";
        else if (line.startsWith("-")) cls = "bg-rose-50 text-rose-800";
        else if (line.startsWith("diff ")) cls = "text-ink font-medium mt-2";
        return (
          <div key={i} className={`whitespace-pre ${cls}`}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}
