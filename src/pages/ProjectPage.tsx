import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import Sidebar from "~/components/chat/Sidebar";
import { ProjectIcon } from "~/components/ProjectIcon";
import {
  api,
  type ApiConversation,
  type ApiProject,
  type ApiProjectCategory,
  type ApiProjectMemoryFile,
  type ApiProjectMemoryStats,
} from "~/lib/api";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = id === "new";
  const [project, setProject] = useState<ApiProject | null>(null);
  const [conversations, setConversations] = useState<ApiConversation[]>([]);
  const [categories, setCategories] = useState<ApiProjectCategory[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [category, setCategory] = useState("general");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [instructions, setInstructions] = useState("");
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [dedicatedMemoryEnabled, setDedicatedMemoryEnabled] = useState(false);
  const [globalMemoryReadOnly, setGlobalMemoryReadOnly] = useState(false);
  const [externalVaultPath, setExternalVaultPath] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .listProjectCategories()
      .then((r) => setCategories(r.categories))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (isNew) {
      setProject(null);
      setName("");
      setCategory("general");
      setSystemPrompt("");
      setInstructions("");
      setMemoryEnabled(true);
      setDedicatedMemoryEnabled(false);
      setGlobalMemoryReadOnly(false);
      setExternalVaultPath("");
      return;
    }
    if (!id) return;
    setError(null);
    Promise.all([api.getProject(id), api.listConversations()])
      .then(([p, c]) => {
        setProject(p.project);
        setName(p.project.name);
        setCategory(p.project.category);
        setSystemPrompt(p.project.systemPrompt ?? "");
        setInstructions(p.project.instructions ?? "");
        setMemoryEnabled(p.project.memoryEnabled ?? true);
        setDedicatedMemoryEnabled(p.project.dedicatedMemoryEnabled ?? false);
        setGlobalMemoryReadOnly(p.project.globalMemoryReadOnly ?? false);
        setExternalVaultPath(p.project.externalVaultPath ?? "");
        setConversations(c.conversations.filter((x) => x.projectId === id));
      })
      .catch((e) => setError((e as Error).message));
  }, [id, isNew]);

  function applyCategoryPreset(newCategory: string) {
    setCategory(newCategory);
    const preset = categories.find((c) => c.id === newCategory);
    if (preset && (!systemPrompt || isPresetContent(systemPrompt))) {
      setSystemPrompt(preset.systemPrompt);
    }
  }

  function isPresetContent(text: string): boolean {
    return categories.some((c) => c.systemPrompt === text);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      if (isNew) {
        const { project } = await api.createProject({
          name: name.trim(),
          category,
          systemPrompt,
          instructions,
          memoryEnabled,
          dedicatedMemoryEnabled,
          globalMemoryReadOnly,
          externalVaultPath: externalVaultPath.trim() || null,
        });
        navigate(`/projects/${project.id}`, { replace: true });
      } else if (id) {
        const { project } = await api.updateProject(id, {
          name: name.trim(),
          category,
          systemPrompt,
          instructions,
          memoryEnabled,
          dedicatedMemoryEnabled,
          globalMemoryReadOnly,
          externalVaultPath: externalVaultPath.trim() || null,
        });
        setProject(project);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function startNewChat() {
    if (!project) return;
    try {
      const { conversation } = await api.createConversation({
        projectId: project.id,
        title: "New conversation",
      });
      navigate(`/c/${conversation.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    if (!project) return;
    if (!confirm(`Delete project "${project.name}"?`)) return;
    try {
      await api.deleteProject(project.id);
      navigate("/", { replace: true });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-gray-50">
      <Sidebar
        activeConversationId={null}
        // While viewing a project, the sidebar lists *that* project's
        // conversations only.
        activeProjectId={isNew ? null : id ?? null}
      />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[820px] flex-col gap-10 px-14 py-16">
          <header className="flex items-start justify-between gap-6">
            <div className="flex flex-col gap-2">
              <Link
                to="/"
                className="flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-ink"
              >
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
                  <path d="M15 18l-6-6 6-6" />
                </svg>
                Back to chat
              </Link>
              <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
                Project
              </span>
              <h1 className="flex items-center gap-3 font-display text-[40px] leading-[48px] font-light text-navy">
                <ProjectIcon
                  name={categoryIcon(categories, category)}
                  size={32}
                  className="text-navy"
                />
                {isNew ? "New project." : `${project?.name ?? "…"}.`}
              </h1>
            </div>
            {!isNew && project && (
              <div className="flex flex-shrink-0 gap-2">
                <a
                  href={api.exportProjectUrl(project.id)}
                  download
                  className="flex h-9 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 text-[13px] font-medium text-ink hover:bg-gray-50"
                >
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
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export .md
                </a>
                <button
                  type="button"
                  onClick={startNewChat}
                  className="flex h-9 items-center gap-2 rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95"
                >
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
                  New chat in project
                </button>
              </div>
            )}
          </header>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 font-mono text-[12px] text-red-700">
              {error}
            </div>
          )}

          <form onSubmit={save} className="flex flex-col gap-5">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q3 strategy, thesis research, …"
                required
                className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
              />
            </Field>

            <Field label="Category">
              <div className="grid grid-cols-5 gap-2">
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => applyCategoryPreset(cat.id)}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-[12px] transition-colors ${
                      category === cat.id
                        ? "border-cyan bg-[rgba(79,179,217,0.08)] text-navy"
                        : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
                    }`}
                  >
                    <ProjectIcon
                      name={cat.icon}
                      size={22}
                      className={
                        category === cat.id ? "text-navy" : "text-gray-500"
                      }
                    />
                    <span className="font-medium">{cat.name}</span>
                  </button>
                ))}
              </div>
            </Field>

            <Field
              label="System prompt"
              hint="Sent as the first system message in every conversation in this project."
            >
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={6}
                className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[13px] leading-[20px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
              />
            </Field>

            <Field
              label="Instructions"
              hint="Private notes — for you, not sent to the engine."
            >
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                rows={3}
                placeholder="Anything you want to remember about how you're using this project."
                className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[13px] leading-[20px] text-ink outline-none placeholder:text-gray-400 focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
              />
            </Field>

            <Field label="Memory">
              <MemoryControls
                globalEnabled={memoryEnabled}
                globalReadOnly={globalMemoryReadOnly}
                projectEnabled={dedicatedMemoryEnabled}
                onGlobalChange={setMemoryEnabled}
                onGlobalReadOnlyChange={setGlobalMemoryReadOnly}
                onProjectChange={setDedicatedMemoryEnabled}
              />
            </Field>

            {!isNew && id && dedicatedMemoryEnabled && (
              <ProjectMemoryPanel
                projectId={id}
                externalVaultPath={externalVaultPath}
                onExternalVaultPathChange={setExternalVaultPath}
              />
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              {!isNew && (
                <button
                  type="button"
                  onClick={remove}
                  className="flex h-9 items-center rounded-lg border border-red-200 bg-white px-4 text-[13px] font-medium text-red-600 hover:bg-red-50"
                >
                  Delete project
                </button>
              )}
              <button
                type="submit"
                disabled={submitting || !name.trim()}
                className="ml-auto flex h-9 items-center rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
              >
                {submitting ? "Saving…" : isNew ? "Create project" : "Save changes"}
              </button>
            </div>
          </form>

          {!isNew && conversations.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="font-display text-[20px] font-light text-navy">
                Conversations
              </h2>
              <div className="flex flex-col gap-2">
                {conversations.map((c) => (
                  <Link
                    key={c.id}
                    to={`/c/${c.id}`}
                    className="flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-4 py-3 hover:border-cyan"
                  >
                    <span className="truncate text-[13px] text-ink">
                      {c.title}
                    </span>
                    <span className="font-mono text-[11px] text-gray-400">
                      {new Date(c.updatedAt).toLocaleDateString()}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-gray-400">{hint}</span>}
    </label>
  );
}

function categoryIcon(
  cats: ApiProjectCategory[],
  id: string,
): string {
  return cats.find((c) => c.id === id)?.icon ?? "📁";
}

/**
 * Two-toggle memory controls (Sophie's layout, 13 May 2026).
 *
 *   [ Global wiki ]   ( Read only )      [ Project wiki ]
 *
 * Read-only is a sub-toggle of Global, only meaningful when Global is on.
 * The three flags map straight to the DB columns (memoryEnabled,
 * globalMemoryReadOnly, dedicatedMemoryEnabled) — no encoding step.
 * The description below the row describes whichever combination is
 * currently active.
 */
function MemoryControls({
  globalEnabled,
  globalReadOnly,
  projectEnabled,
  onGlobalChange,
  onGlobalReadOnlyChange,
  onProjectChange,
}: {
  globalEnabled: boolean;
  globalReadOnly: boolean;
  projectEnabled: boolean;
  onGlobalChange: (v: boolean) => void;
  onGlobalReadOnlyChange: (v: boolean) => void;
  onProjectChange: (v: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-white px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div className="flex flex-col gap-2">
          <ToggleRow
            label="Global wiki"
            value={globalEnabled}
            onChange={onGlobalChange}
          />
          <ToggleRow
            label="Read only"
            value={globalReadOnly}
            onChange={onGlobalReadOnlyChange}
            small
            disabled={!globalEnabled}
          />
        </div>
        <ToggleRow
          label="Project wiki"
          value={projectEnabled}
          onChange={onProjectChange}
        />
      </div>
      <p className="border-t border-gray-100 pt-2 text-center text-[12px] text-gray-500">
        {memoryComboDescription(globalEnabled, globalReadOnly, projectEnabled)}
      </p>
    </div>
  );
}

function memoryComboDescription(
  global: boolean,
  readOnly: boolean,
  project: boolean,
): string {
  if (!global && !project) {
    return "Memory disabled — nothing is injected.";
  }
  if (global && !project) {
    return readOnly
      ? "Global wiki injected for context, but this project never writes back to it."
      : "Default — global wiki injected and updated by this project's chats.";
  }
  if (!global && project) {
    return "Project vault only — fully isolated from your global wiki.";
  }
  // both
  return readOnly
    ? "Combine the project vault with the wiki for context, but never write back to the wiki."
    : "Project vault injected. Global wiki injected and also updated by this project's chats.";
}

function ToggleRow({
  label,
  value,
  onChange,
  small,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  small?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className={`flex items-center gap-3 disabled:opacity-50 ${
        small ? "text-[12px]" : "text-[14px]"
      }`}
    >
      <span className="text-ink">{label}</span>
      <span
        className={`relative flex-shrink-0 rounded-full transition-colors ${
          small ? "h-4 w-8" : "h-6 w-11"
        } ${value && !disabled ? "bg-cyan" : "bg-gray-300"}`}
      >
        <span
          className={`absolute top-0.5 rounded-full bg-white shadow-sm transition-[left] ${
            small ? "h-3 w-3" : "h-5 w-5"
          } ${
            value
              ? small
                ? "left-[18px]"
                : "left-[22px]"
              : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

/**
 * Vault corpus panel — surfaces both ingestion paths and the file list.
 *
 * Two ways to feed the project memory:
 *   1. ZIP upload — files are COPIED into the DB, hierarchy preserved.
 *      Use when the source vault won't change much.
 *   2. Linked external path — absolute path on the gateway. The chat
 *      route reads it LIVE every turn. Use when you keep editing the
 *      vault on disk (Obsidian, etc.) and want changes to surface
 *      immediately. The path is a project field — managed via the
 *      parent form save, not a separate upload.
 *
 * Both can coexist; their files are merged at chat time (DB wins on
 * path conflict).
 *
 * Mounted only when memoryEnabled AND dedicatedMemoryEnabled are both
 * true — otherwise the project vault is ignored regardless.
 */
function ProjectMemoryPanel({
  projectId,
  externalVaultPath,
  onExternalVaultPathChange,
}: {
  projectId: string;
  externalVaultPath: string;
  onExternalVaultPathChange: (v: string) => void;
}) {
  const [files, setFiles] = useState<ApiProjectMemoryFile[] | null>(null);
  const [stats, setStats] = useState<ApiProjectMemoryStats | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<{
    imported: number;
    skipped: Array<{ path: string; reason: string }>;
  } | null>(null);

  async function refresh() {
    try {
      const r = await api.listProjectMemory(projectId);
      setFiles(r.files);
      setStats(r.stats);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function importZip(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.importProjectMemoryFromZip(projectId, file);
      setLastImport({ imported: r.imported.length, skipped: r.skipped });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeFile(path: string) {
    if (!confirm(`Remove ${path} from the project corpus?`)) return;
    try {
      await api.deleteProjectMemoryFile(projectId, path);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function wipeAll() {
    if (!confirm("Wipe the entire imported corpus? This can't be undone (the linked external path is untouched)."))
      return;
    try {
      await api.wipeProjectMemory(projectId);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-medium text-ink">Project vault</h3>
          <p className="text-[12px] text-gray-500">
            Imported files + linked external path are merged into the system
            prompt for every conversation in this project.
          </p>
        </div>
        {stats && (
          <span className="font-mono text-[11px] text-gray-500">
            {stats.fileCount} imported file{stats.fileCount === 1 ? "" : "s"} ·{" "}
            {(stats.bytesUsed / 1024).toFixed(1)} /{" "}
            {(stats.bytesQuota / 1024 / 1024).toFixed(0)} MB
          </span>
        )}
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 rounded-md border border-dashed border-gray-300 bg-gray-50 px-4 py-3 hover:bg-gray-100">
          <span className="text-[12px] font-medium text-ink">
            Import ZIP (copy into DB)
          </span>
          <span className="text-[11px] text-gray-500">
            .md / .txt / .json / .yaml inside the zip. Hierarchy preserved
            (sub-folders + index.md at root land at their original paths).
          </span>
          <input
            type="file"
            accept=".zip,application/zip"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importZip(f);
              e.target.value = "";
            }}
            className="text-[11px] file:mr-2 file:rounded file:border-0 file:bg-navy file:px-2 file:py-1 file:text-white"
          />
        </label>
        <div className="flex flex-col gap-1.5 rounded-md border border-dashed border-gray-300 bg-gray-50 px-4 py-3">
          <span className="text-[12px] font-medium text-ink">
            Linked external path (read live)
          </span>
          <span className="text-[11px] text-gray-500">
            Absolute path on the gateway host. Read on every chat turn —
            no copy, edits land immediately. Save the project to apply.
          </span>
          <input
            type="text"
            value={externalVaultPath}
            onChange={(e) => onExternalVaultPathChange(e.target.value)}
            placeholder="/Users/admin/vault"
            className="rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[11px]"
          />
        </div>
      </div>

      {lastImport && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
          Imported {lastImport.imported} file
          {lastImport.imported === 1 ? "" : "s"}
          {lastImport.skipped.length > 0 && (
            <>
              {" — "}
              {lastImport.skipped.length} skipped (
              {Array.from(
                new Set(lastImport.skipped.map((s) => s.reason)),
              ).join(", ")}
              )
            </>
          )}
          .
        </div>
      )}

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
          {err}
        </div>
      )}

      {files && files.length > 0 && (
        <div className="rounded-md border border-gray-200 bg-white">
          <table className="w-full text-[12px]">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-[0.06em] text-gray-500">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Path</th>
                <th className="px-3 py-1.5 text-right font-medium">Size</th>
                <th className="px-3 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.path} className="border-t border-gray-100">
                  <td className="px-3 py-1.5 font-mono">{f.path}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-500">
                    {(f.sizeBytes / 1024).toFixed(1)} KB
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      type="button"
                      onClick={() => removeFile(f.path)}
                      disabled={busy}
                      className="text-[11px] text-red-500 hover:text-red-700"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {files && files.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={wipeAll}
            disabled={busy}
            className="text-[11px] text-red-500 hover:text-red-700"
          >
            Wipe entire corpus
          </button>
        </div>
      )}
    </div>
  );
}
