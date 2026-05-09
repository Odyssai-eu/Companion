import { useEffect, useMemo, useRef, useState } from "react";
import Sidebar from "~/components/chat/Sidebar";
import { useWorkspaceFiles } from "~/hooks/useWorkspaceFiles";
import {
  api,
  type ApiWorkspaceFile,
} from "~/lib/api";
import { renderMarkdown } from "~/lib/markdown";

/**
 * FilesPage — workspace browser & lightweight editor.
 *
 * Layout (desktop): sidebar (chat nav) → tree column → viewer/editor pane.
 * The tree groups files by virtual folder (path prefix). Selecting a file
 * loads its content for read or edit. Markdown files render via the chat
 * markdown pipeline; other text mimes show in a plain textarea.
 */
export default function FilesPage() {
  const { entries, stats, loading, error, refresh } = useWorkspaceFiles();
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [mime, setMime] = useState<string>("text/plain");
  const [editing, setEditing] = useState<boolean>(false);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [contentErr, setContentErr] = useState<string | null>(null);

  // Auto-select first entry when listing arrives and nothing is picked yet.
  useEffect(() => {
    if (!selected && entries.length > 0) {
      setSelected(entries[0].path);
    }
  }, [entries, selected]);

  // Load content for the selected file.
  useEffect(() => {
    if (!selected) {
      setContent("");
      setMime("text/plain");
      return;
    }
    let cancelled = false;
    api
      .readFile(selected)
      .then((f) => {
        if (cancelled) return;
        setContent(f.content);
        setMime(f.mimeType);
        setDraft(f.content);
        setEditing(false);
        setContentErr(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setContent("");
        setContentErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const selectedEntry = entries.find((e) => e.path === selected);

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      await api.writeFile(selected, draft);
      setContent(draft);
      setEditing(false);
      refresh();
    } catch (e) {
      setContentErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function newFile() {
    const path = window.prompt(
      "New file path (e.g. 'notes/scratch.md'):",
      "notes/untitled.md",
    );
    if (!path) return;
    try {
      await api.writeFile(path.trim(), "");
      await refresh();
      setSelected(path.trim());
    } catch (e) {
      setContentErr((e as Error).message);
    }
  }

  async function deleteFile() {
    if (!selected) return;
    if (!window.confirm(`Delete ${selected}?`)) return;
    try {
      await api.deleteFile(selected);
      setSelected(null);
      setContent("");
      refresh();
    } catch (e) {
      setContentErr((e as Error).message);
    }
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-gray-50">
      <Sidebar activeConversationId={null} activeProjectId={null} />
      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-between gap-4 border-b border-gray-200 bg-white px-6 py-4">
          <div className="flex flex-col gap-0.5">
            <span className="font-sans text-[12px] tracking-[0.08em] text-cyan uppercase">
              Workspace
            </span>
            <h1 className="font-display text-[24px] leading-[28px] font-light text-navy">
              Files
            </h1>
          </div>
          <div className="flex items-center gap-3 text-[12px] text-gray-500">
            {stats && (
              <span className="font-mono">
                {stats.fileCount} file{stats.fileCount === 1 ? "" : "s"} ·{" "}
                {formatBytes(stats.bytesUsed)} / {formatBytes(stats.bytesQuota)}
              </span>
            )}
            <button
              type="button"
              onClick={newFile}
              className="flex h-8 items-center gap-1.5 rounded-md bg-navy px-3 text-[12px] font-medium text-white hover:opacity-95"
            >
              <PlusIcon /> New file
            </button>
          </div>
        </header>

        <div className="flex flex-1 overflow-hidden">
          <aside className="flex w-[280px] flex-shrink-0 flex-col overflow-y-auto border-r border-gray-200 bg-white">
            {loading && entries.length === 0 ? (
              <div className="px-4 py-6 text-[12px] text-gray-400">Loading…</div>
            ) : entries.length === 0 ? (
              <EmptyState />
            ) : (
              <FileTree
                tree={tree}
                selected={selected}
                onSelect={setSelected}
              />
            )}
            {error && (
              <div className="border-t border-gray-100 px-4 py-3 font-mono text-[11px] text-rose-600">
                {error}
              </div>
            )}
          </aside>

          <section className="flex flex-1 flex-col overflow-hidden">
            {!selected ? (
              <div className="flex flex-1 items-center justify-center px-8 text-center">
                <div className="flex flex-col items-center gap-2 text-gray-400">
                  <FileIcon />
                  <p className="text-[14px]">
                    Select a file from the tree, or ask the agent to create
                    one for you in the chat.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-gray-100 bg-white px-6 py-3">
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <code className="truncate font-mono text-[12px] text-ink">
                      {selected}
                    </code>
                    {selectedEntry && (
                      <span className="font-mono text-[11px] text-gray-400">
                        {formatBytes(selectedEntry.sizeBytes)} · {selectedEntry.mimeType}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {!editing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(content);
                            setEditing(true);
                          }}
                          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={deleteFile}
                          className="rounded-md border border-rose-200 bg-white px-3 py-1.5 text-[12px] text-rose-600 hover:bg-rose-50"
                        >
                          Delete
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setDraft(content);
                            setEditing(false);
                          }}
                          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={save}
                          disabled={saving || draft === content}
                          className="rounded-md bg-navy px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-95 disabled:opacity-50"
                        >
                          {saving ? "Saving…" : "Save"}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex-1 overflow-auto bg-white">
                  {contentErr ? (
                    <div className="m-6 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 font-mono text-[12px] text-rose-700">
                      {contentErr}
                    </div>
                  ) : editing ? (
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      className="h-full w-full resize-none border-0 bg-white px-6 py-5 font-mono text-[13px] leading-[20px] text-ink outline-none"
                    />
                  ) : mime === "text/markdown" || /\.md$/i.test(selected) ? (
                    <MarkdownView content={content} />
                  ) : (
                    <pre className="whitespace-pre-wrap break-words px-6 py-5 font-mono text-[13px] leading-[20px] text-ink">
                      {content}
                    </pre>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

// ── Tree ─────────────────────────────────────────────────────────────────

type TreeNode = {
  name: string;
  fullPath: string;
  isFile: boolean;
  children: TreeNode[];
  entry?: ApiWorkspaceFile;
};

function buildTree(entries: ApiWorkspaceFile[]): TreeNode {
  const root: TreeNode = {
    name: "",
    fullPath: "",
    isFile: false,
    children: [],
  };
  for (const e of entries) {
    const segs = e.path.split("/");
    let cursor = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const isLeaf = i === segs.length - 1;
      const fullPath = segs.slice(0, i + 1).join("/");
      let next = cursor.children.find((c) => c.name === seg);
      if (!next) {
        next = {
          name: seg,
          fullPath,
          isFile: isLeaf,
          children: [],
          entry: isLeaf ? e : undefined,
        };
        cursor.children.push(next);
      }
      cursor = next;
    }
  }
  // Sort: folders first, then files, both alpha
  function sort(node: TreeNode) {
    node.children.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    for (const c of node.children) sort(c);
  }
  sort(root);
  return root;
}

function FileTree({
  tree,
  selected,
  onSelect,
}: {
  tree: TreeNode;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5 px-2 py-3">
      {tree.children.map((child) => (
        <TreeRow
          key={child.fullPath}
          node={child}
          depth={0}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

function TreeRow({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  if (node.isFile) {
    const active = selected === node.fullPath;
    return (
      <li>
        <button
          type="button"
          onClick={() => onSelect(node.fullPath)}
          className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] transition-colors ${
            active
              ? "bg-[rgba(79,179,217,0.12)] text-navy"
              : "text-ink hover:bg-gray-50"
          }`}
          style={{ paddingLeft: `${8 + depth * 12}px` }}
        >
          <FileIcon />
          <span className="truncate font-mono text-[12px]">{node.name}</span>
        </button>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] text-gray-600 hover:bg-gray-50"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        <ChevronIcon open={open} />
        <FolderIcon />
        <span className="truncate font-mono text-[12px]">{node.name}</span>
      </button>
      {open && node.children.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {node.children.map((c) => (
            <TreeRow
              key={c.fullPath}
              node={c}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function MarkdownView({ content }: { content: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div
      ref={ref}
      className="md-body px-6 py-5"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <FolderIcon />
      <p className="text-[12px] text-gray-500">
        Your workspace is empty. The agent can create files here on your
        behalf.
      </p>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ── Icons (Lucide-flavoured, stroke 1.75, currentColor) ──────────────────

function FileIcon() {
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
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
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function ChevronIcon({ open }: { open: boolean }) {
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
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 120ms ease",
      }}
    >
      <polyline points="9 6 15 12 9 18" />
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
