import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { copyToClipboard } from "~/lib/clipboard";
import Sidebar from "~/components/chat/Sidebar";
import { ProjectIcon } from "~/components/ProjectIcon";
import { ProjectStatusIcons } from "~/components/ProjectStatusIcons";
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
  const [externalVaultReadOnly, setExternalVaultReadOnly] = useState(true);
  const [sharingEnabled, setSharingEnabled] = useState(false);
  // Project settings panel — gates the system prompt + memory + vault
  // controls. Default closed so the project view stays focused on
  // chats; user opens it when they actually want to tune. Instructions
  // stays outside the panel (always visible per UX brief).
  const [settingsOpen, setSettingsOpen] = useState(false);
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
      setExternalVaultReadOnly(true);
      setSharingEnabled(false);
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
        setExternalVaultReadOnly(p.project.externalVaultReadOnly ?? true);
        setSharingEnabled(p.project.sharingEnabled ?? false);
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
          externalVaultReadOnly: externalVaultReadOnly,
          sharingEnabled: sharingEnabled,
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
          externalVaultReadOnly: externalVaultReadOnly,
          sharingEnabled: sharingEnabled,
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
          <header className="flex flex-col gap-3">
            {/* Top row: back link (left) + action buttons (right). The
             *  title block moved to its own row below so it can take
             *  the full container width — used to wrap to 2 lines when
             *  the buttons ate the right half. */}
            <div className="flex items-start justify-between gap-6">
              <Link
                to="/projects"
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
                Back to projects
              </Link>
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
                  onClick={() => setSettingsOpen((v) => !v)}
                  className={`flex h-9 items-center gap-2 rounded-lg border px-3.5 text-[13px] font-medium transition-colors ${
                    settingsOpen
                      ? "border-cyan bg-[rgba(79,179,217,0.08)] text-navy"
                      : "border-gray-200 bg-white text-ink hover:bg-gray-50"
                  }`}
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
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  Project settings
                </button>
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
            </div>

            {/* Status icons — appear below the action buttons,
             *  right-aligned. Reads as a quick "what's wired up here"
             *  glance: system-prompt set? global wiki on? read-only?
             *  project corpus on? Empty / off settings stay hidden. */}
            {!isNew && project && (
              <div className="flex justify-end">
                <ProjectStatusIcons
                  project={{
                    systemPrompt,
                    memoryEnabled,
                    globalMemoryReadOnly,
                    dedicatedMemoryEnabled,
                  }}
                />
              </div>
            )}

            {/* Title row — full container width so long names don't
             *  wrap awkwardly because of the buttons on the right. */}
            <div className="flex flex-col gap-2">
              <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
                Project
              </span>
              <h1 className="flex items-center gap-3 font-display text-[40px] leading-[48px] font-light text-navy">
                <ProjectIcon
                  name={categoryIcon(categories, category)}
                  size={32}
                  className="flex-shrink-0 text-navy"
                />
                <span className="truncate">
                  {isNew ? "New project." : `${project?.name ?? "…"}.`}
                </span>
              </h1>
            </div>
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

            {/* Project settings — System prompt + Memory + Vault gated
             *  behind a button on the header, so the default project
             *  view stays focused on conversations. Forced open during
             *  creation (isNew) so the user can configure before saving. */}
            {(settingsOpen || isNew) && (
              <div className="flex flex-col gap-5 rounded-xl border border-gray-200 bg-gray-50/50 p-5">
                <div className="flex items-center justify-between">
                  <h2 className="font-display text-[18px] font-light text-navy">
                    Project settings
                  </h2>
                  {!isNew && (
                    <button
                      type="button"
                      onClick={() => setSettingsOpen(false)}
                      aria-label="Close settings"
                      title="Close settings"
                      className="flex h-7 w-7 items-center justify-center rounded-md text-gray-500 hover:bg-white hover:text-ink"
                    >
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
                        <path d="M18 6L6 18M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>

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
                    externalVaultReadOnly={externalVaultReadOnly}
                    sharingEnabled={sharingEnabled}
                    onExternalVaultPathChange={setExternalVaultPath}
                    onExternalVaultReadOnlyChange={setExternalVaultReadOnly}
                    onSharingEnabledChange={setSharingEnabled}
                  />
                )}
              </div>
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
 * Two-toggle memory controls (UX brief, May 2026).
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
  externalVaultReadOnly,
  sharingEnabled,
  onExternalVaultPathChange,
  onExternalVaultReadOnlyChange,
  onSharingEnabledChange,
}: {
  projectId: string;
  externalVaultPath: string;
  externalVaultReadOnly: boolean;
  sharingEnabled: boolean;
  onExternalVaultPathChange: (v: string) => void;
  onExternalVaultReadOnlyChange: (v: boolean) => void;
  onSharingEnabledChange: (v: boolean) => void;
}) {
  // Cross-project share path. Copyable string that another project
  // pastes into its own Linked external path to read from this one's
  // DB corpus. tcai:// paths force read-only server-side regardless of
  // the consumer's toggle.
  const sharePath = `tcai://project/${projectId}`;
  // Consumer freely picks RO/RW regardless of path shape — the hub's
  // Sharing toggle is the only source-side gate. RW means the consumer
  // project's chats will (once auto-compile lands) write back into the
  // linked vault. Filesystem path with RW = write to disk. tcai:// path
  // with RW = write to the source project's DB corpus.
  const effectiveReadOnly = externalVaultReadOnly;
  const [copiedShare, setCopiedShare] = useState(false);
  async function copyShare() {
    const ok = await copyToClipboard(sharePath);
    if (!ok) return;
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 1500);
  }
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

      <div className="flex flex-col gap-2 rounded-md bg-gray-50 px-3 py-2 text-[11px]">
        <label className="flex items-center gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={sharingEnabled}
            onChange={(e) => onSharingEnabledChange(e.target.checked)}
          />
          <span className="font-medium">Sharing</span>
          <span className="text-gray-500">
            — let other projects link to this vault. Each consumer picks
            read-only or read-write on their side.
          </span>
        </label>
        {sharingEnabled ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-gray-500">Share path:</span>
            <code className="flex-1 min-w-0 truncate font-mono text-ink">
              {sharePath}
            </code>
            <button
              type="button"
              onClick={copyShare}
              className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-100"
            >
              {copiedShare ? "Copied!" : "Copy"}
            </button>
            <span className="basis-full text-[11px] text-gray-400">
              Paste into another project's Linked external path. Each
              consumer chooses read-only or read-write on their side.
            </span>
          </div>
        ) : (
          <span className="text-[11px] text-gray-400">
            Off — no other project can link to this vault. Turn on to
            expose a share path.
          </span>
        )}
      </div>

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
            Absolute filesystem path on the gateway host, OR another
            project's <code className="font-mono">tcai://</code> share
            path. Read every turn — no copy.
          </span>
          <input
            type="text"
            value={externalVaultPath}
            onChange={(e) => onExternalVaultPathChange(e.target.value)}
            placeholder="/path/to/vault   or   companion://project/…"
            className="rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[11px]"
          />
          <label className="flex items-center gap-2 pt-1 text-[11px] text-gray-600">
            <input
              type="checkbox"
              checked={effectiveReadOnly}
              disabled={!externalVaultPath.trim()}
              onChange={(e) => onExternalVaultReadOnlyChange(e.target.checked)}
            />
            <span>
              Read only
              {!effectiveReadOnly && externalVaultPath.trim() && (
                <span className="ml-1 text-amber-700">
                  — this project will write back to the linked vault
                </span>
              )}
            </span>
          </label>
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
