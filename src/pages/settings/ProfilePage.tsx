import { useEffect, useRef, useState } from "react";
import { useAuth } from "~/hooks/useAuth";
import {
  api,
  type ApiUserMemoryFile,
  type ApiUserMemoryStats,
  type ApiUserMemorySettings,
} from "~/lib/api";
import {
  getMemoryDefaultNewConv,
  setMemoryDefaultNewConv,
} from "~/lib/memory-prefs";

export default function ProfilePage() {
  const { user, refresh } = useAuth();
  const [name, setName] = useState(user?.name ?? "");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  useEffect(() => {
    setName(user?.name ?? "");
  }, [user]);

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === user?.name) return;
    setSavingName(true);
    setNameError(null);
    try {
      await api.updateProfile({ name: name.trim() });
      await refresh();
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch (e) {
      setNameError((e as Error).message);
    } finally {
      setSavingName(false);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Account
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Profile.
        </h1>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="font-display text-[20px] font-light text-navy">
          Identity
        </h2>
        <form
          onSubmit={saveName}
          className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4"
        >
          <Field label="Email">
            <input
              value={user?.email ?? ""}
              disabled
              className="w-full cursor-not-allowed rounded-lg border border-gray-200 bg-gray-50 px-3.5 py-2.5 font-mono text-[13px] text-gray-600 outline-none"
            />
          </Field>
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
            />
          </Field>
          <div className="flex items-center justify-end gap-3">
            {nameError && (
              <span className="text-[12px] text-red-600">{nameError}</span>
            )}
            {nameSaved && (
              <span className="text-[12px] text-emerald-600">Saved ✓</span>
            )}
            <button
              type="submit"
              disabled={savingName || !name.trim() || name.trim() === user?.name}
              className="flex h-9 items-center rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-40"
            >
              {savingName ? "Saving…" : "Save name"}
            </button>
          </div>
        </form>
      </section>

      <ChangePasswordSection />
      <PersonaSection />
      <MemoryDefaultSection />
      <MemoryVaultSection />
    </div>
  );
}

// ─── Memory on new conversations (per-device) ────────────────────────────
// Whether a brand-new *personal* conversation starts with memory enabled.
// Stored in localStorage, so it is local to this browser/machine — Sophie
// can have it ON on her MacBook and OFF on the workstation. In a project,
// memory is managed by the project settings and this toggle is ignored.

function MemoryDefaultSection() {
  const [enabled, setEnabled] = useState<boolean>(() =>
    getMemoryDefaultNewConv(),
  );

  function toggle(next: boolean) {
    setEnabled(next);
    setMemoryDefaultNewConv(next);
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-[20px] font-light text-navy">
        Memory on new conversations
      </h2>
      <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggle(e.target.checked)}
            className="mt-1"
          />
          <span className="flex flex-col gap-1">
            <span className="text-[14px] font-medium text-ink">
              Enable memory on a new conversation
            </span>
            <span className="text-[12px] leading-[18px] text-gray-500">
              Applies to new personal chats. In a project, memory is managed by
              the project settings. This preference is local to this
              workstation — your other devices keep their own choice.
            </span>
          </span>
        </label>
      </div>
    </section>
  );
}

// ─── Global memory vault ─────────────────────────────────────────────────
// User-curated counterpart of the Karpathy auto-wiki. Sophie can seed
// her global memory with an existing Obsidian vault (ZIP) and/or point
// at a live filesystem path that gets read every turn. The auto-compile
// keeps running on top by default; flip "Use my vault only" off to make
// it the single source.

function MemoryVaultSection() {
  const [files, setFiles] = useState<ApiUserMemoryFile[] | null>(null);
  const [stats, setStats] = useState<ApiUserMemoryStats | null>(null);
  const [settings, setSettings] = useState<ApiUserMemorySettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<{
    imported: number;
    skipped: Array<{ path: string; reason: string }>;
  } | null>(null);
  // Local-edit buffer for the external path so typing doesn't fire a
  // PUT on every keystroke. Synced from `settings` and committed on
  // blur / explicit Save.
  const [pathDraft, setPathDraft] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

  async function refresh() {
    try {
      const r = await api.listUserMemory();
      setFiles(r.files);
      setStats(r.stats);
      setSettings(r.settings);
      setPathDraft(r.settings.externalVaultPath ?? "");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function importZip(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.importUserMemoryFromZip(file);
      setLastImport({ imported: r.imported.length, skipped: r.skipped });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commitSettings(patch: {
    externalVaultPath?: string | null;
    externalVaultReadOnly?: boolean;
    autoMemoryEnabled?: boolean;
    memoryMode?: "basic" | "advanced";
  }) {
    setSavingSettings(true);
    setErr(null);
    try {
      await api.updateUserMemorySettings(patch);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingSettings(false);
    }
  }

  async function removeFile(path: string) {
    if (!confirm(`Remove ${path} from your vault?`)) return;
    try {
      await api.deleteUserMemoryFile(path);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function wipeAll() {
    if (
      !confirm(
        "Wipe the entire imported vault? This can't be undone (the linked external path is untouched).",
      )
    )
      return;
    try {
      await api.wipeUserMemory();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-[20px] font-light text-navy">
        Global memory vault
      </h2>
      <p className="text-[13px] text-gray-500">
        Seed your global memory with an existing Obsidian vault, or point at
        a live filesystem path. Files load into every chat alongside the
        auto-compiled wiki. Switch off "Auto-compile memory" if you want
        your vault to be the single source.
      </p>

      <div className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[14px] font-medium text-ink">Vault corpus</h3>
            <p className="text-[12px] text-gray-500">
              Imported files + linked external path are merged into the
              system prompt of every conversation.
            </p>
          </div>
          {stats && (
            <span className="font-mono text-[11px] text-gray-500">
              {stats.fileCount} imported file{stats.fileCount === 1 ? "" : "s"}{" "}
              · {(stats.bytesUsed / 1024).toFixed(1)} /{" "}
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
              .md / .txt / .json / .yaml inside the zip. Hierarchy preserved.
              Files persist across container rebuilds.
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
              Absolute filesystem path on the gateway host. Read every turn —
              no copy. Useful for keeping an Obsidian vault locally and
              seeing edits surface immediately.
            </span>
            <input
              type="text"
              value={pathDraft}
              onChange={(e) => setPathDraft(e.target.value)}
              onBlur={() => {
                if ((settings?.externalVaultPath ?? "") !== pathDraft) {
                  void commitSettings({
                    externalVaultPath: pathDraft.trim() || null,
                  });
                }
              }}
              placeholder="/path/to/your/vault"
              className="rounded border border-gray-200 bg-white px-2 py-1 font-mono text-[11px]"
            />
            <label className="flex items-center gap-2 pt-1 text-[11px] text-gray-600">
              <input
                type="checkbox"
                checked={settings?.externalVaultReadOnly ?? true}
                disabled={!pathDraft.trim()}
                onChange={(e) =>
                  void commitSettings({ externalVaultReadOnly: e.target.checked })
                }
              />
              <span>Read only</span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 text-[12px]">
          <label className="flex items-center gap-2 text-ink">
            <input
              type="checkbox"
              checked={settings?.autoMemoryEnabled ?? true}
              onChange={(e) =>
                void commitSettings({ autoMemoryEnabled: e.target.checked })
              }
            />
            <span className="font-medium">Auto-compile memory</span>
            <span className="text-gray-500">
              — when off, only your imported vault is injected ; the Karpathy
              auto-wiki is bypassed.
            </span>
          </label>
          {savingSettings && (
            <span className="font-mono text-[10px] text-gray-400">saving…</span>
          )}
        </div>

        <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 text-[12px]">
          <label className="flex items-center gap-2 text-ink">
            <span className="font-medium">Memory mode</span>
            <select
              className="rounded border border-gray-300 bg-white px-2 py-1 text-[12px]"
              value={settings?.memoryMode ?? "advanced"}
              onChange={(e) =>
                void commitSettings({
                  memoryMode: e.target.value === "basic" ? "basic" : "advanced",
                })
              }
            >
              <option value="advanced">Advanced (RAG + 3 levels)</option>
              <option value="basic">Basic (Wiki LLM only)</option>
            </select>
            <span className="text-gray-500">
              — basic injects only the auto-compiled wiki + imported vault (no
              embeddings, no Qdrant) ; advanced adds semantic RAG across the
              personal / team / company tiers.
            </span>
          </label>
          {savingSettings && (
            <span className="font-mono text-[10px] text-gray-400">saving…</span>
          )}
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
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {err}
          </div>
        )}

        {files && files.length > 0 ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 text-[11px] text-gray-500">
              <span>Imported files</span>
              <button
                type="button"
                onClick={wipeAll}
                className="rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] text-red-600 hover:bg-red-50"
              >
                Wipe all
              </button>
            </div>
            <ul className="flex max-h-[280px] flex-col overflow-y-auto">
              {files.map((f) => (
                <li
                  key={f.path}
                  className="flex items-center justify-between border-b border-gray-50 px-3 py-1.5 text-[11px] last:border-0"
                >
                  <span className="font-mono truncate text-gray-700">
                    {f.path}
                  </span>
                  <span className="flex items-center gap-2 text-gray-400">
                    <span>{(f.sizeBytes / 1024).toFixed(1)} KB</span>
                    <button
                      type="button"
                      onClick={() => void removeFile(f.path)}
                      className="text-red-500 hover:text-red-700"
                      title={`Remove ${f.path}`}
                    >
                      ⌫
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          files !== null && (
            <div className="rounded-md bg-gray-50 px-3 py-2 text-[11px] text-gray-400">
              No imported files yet — drop a ZIP above to get started.
            </div>
          )
        )}
      </div>
    </section>
  );
}

/**
 * Persona — the 5 reserved profile/*.md memory articles.
 *
 * Each card shows the article body in an editable textarea. Saving writes
 * to /api/profile/:slug and flips edited_by_user=true server-side, which
 * tells the wiki compiler (Python service) to never overwrite this article.
 *
 * The 5 articles get auto-created on first GET, with placeholder templates,
 * so the user always sees 5 cards even if they've never edited anything.
 */
function PersonaSection() {
  type Row = {
    slug: string;
    title: string;
    body: string;
    editedByUser: boolean;
    updatedAt: string | null;
  };
  const [rows, setRows] = useState<Row[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [savedAt, setSavedAt] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [showImport, setShowImport] = useState(false);
  const [showInterview, setShowInterview] = useState(false);

  async function reloadPersona() {
    const r = await api.getPersona();
    setRows(r.persona);
    const d: Record<string, string> = {};
    for (const p of r.persona) d[p.slug] = p.body;
    setDrafts(d);
  }

  useEffect(() => {
    reloadPersona().catch((e) => setError((e as Error).message));
  }, []);

  async function save(slug: string) {
    if (saving.has(slug)) return;
    setSaving((s) => new Set(s).add(slug));
    setError(null);
    try {
      const body = drafts[slug] ?? "";
      const r = await api.updatePersona(slug, body);
      setRows((prev) =>
        prev
          ? prev.map((p) => (p.slug === slug ? { ...p, ...r.persona } : p))
          : prev,
      );
      setSavedAt((s) => ({ ...s, [slug]: Date.now() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(slug);
        return next;
      });
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-[20px] font-light text-navy">
            Persona
          </h2>
          <p className="max-w-[640px] text-[13px] leading-[20px] text-gray-600">
            Five reserved articles in your memory wiki, hand-authored. They
            tell the model who you are, how you want to be talked to, and how
            the output should read. The wiki compiler skips these — only you
            write them. Edit here or via Obsidian.
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setShowImport(true)}
            className="flex h-9 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
            title="Paste a persona dump from another LLM (ChatGPT memory, Claude project instructions, a bio…) and have Haiku extract the 5 fields."
          >
            Import from another LLM
          </button>
          <button
            type="button"
            onClick={() => setShowInterview(true)}
            className="flex h-9 items-center gap-2 rounded-lg bg-navy px-3.5 text-[13px] font-medium text-white hover:opacity-95"
            title="Start a short interview — the model asks questions, fills your persona articles as you answer."
          >
            Start interview
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 font-mono text-[12px] text-red-700">
          {error}
        </div>
      )}
      {!rows && !error && (
        <div className="rounded-xl border border-gray-200 bg-white py-6 text-center font-mono text-[11px] text-gray-400">
          Loading…
        </div>
      )}

      <div className="flex flex-col gap-3">
        {(rows ?? []).map((p) => {
          const isOpen = open[p.slug] ?? !p.editedByUser;
          const isSaving = saving.has(p.slug);
          const recentlySaved =
            savedAt[p.slug] && Date.now() - savedAt[p.slug] < 2500;
          const dirty = (drafts[p.slug] ?? "") !== p.body;
          return (
            <article
              key={p.slug}
              className="overflow-hidden rounded-xl border border-gray-200 bg-white"
            >
              <button
                type="button"
                onClick={() =>
                  setOpen((o) => ({ ...o, [p.slug]: !(o[p.slug] ?? !p.editedByUser) }))
                }
                className="flex w-full items-center justify-between gap-4 px-5 py-3 text-left hover:bg-gray-50"
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-[14px] font-medium text-ink">
                    {p.title}
                  </span>
                  <span className="font-mono text-[11px] text-gray-400">
                    profile/{p.slug}.md
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px]">
                  {p.editedByUser ? (
                    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700">
                      authored
                    </span>
                  ) : (
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-500">
                      empty
                    </span>
                  )}
                  <span className="text-gray-400">{isOpen ? "▾" : "▸"}</span>
                </div>
              </button>
              {isOpen && (
                <div className="flex flex-col gap-2 border-t border-gray-100 px-5 py-4">
                  <textarea
                    value={drafts[p.slug] ?? ""}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [p.slug]: e.target.value }))
                    }
                    rows={Math.min(
                      24,
                      Math.max(8, (drafts[p.slug] ?? "").split("\n").length + 1),
                    )}
                    spellCheck={false}
                    className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] leading-[18px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
                  />
                  <div className="flex items-center justify-end gap-3">
                    {recentlySaved && (
                      <span className="text-[12px] text-emerald-600">
                        Saved ✓
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => save(p.slug)}
                      disabled={isSaving || !dirty}
                      className="flex h-8 items-center rounded-lg bg-navy px-3.5 text-[12px] font-medium text-white hover:opacity-95 disabled:opacity-40"
                    >
                      {isSaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {showImport && (
        <ImportPersonaModal
          onClose={() => setShowImport(false)}
          onImported={async () => {
            setShowImport(false);
            await reloadPersona();
          }}
        />
      )}

      {showInterview && (
        <InterviewModal
          onClose={() => setShowInterview(false)}
          onPersonaUpdated={(p) => {
            setRows(p);
            const d: Record<string, string> = {};
            for (const x of p) d[x.slug] = x.body;
            setDrafts(d);
          }}
        />
      )}
    </section>
  );
}

/**
 * Conversational onboarding interview.
 *
 * The model (Haiku by default) asks ~8-15 short questions and writes
 * profile articles as it goes via the write_persona tool. The right
 * panel shows the persona snapshot updating live so the user sees
 * what's been captured.
 *
 * State lives in the modal — closing it doesn't persist the conversation.
 * Only the persona articles persist (those go straight to the DB via
 * the tool call). Re-opening starts a fresh interview that builds on
 * whatever's already in the persona articles.
 */
function InterviewModal({
  onClose,
  onPersonaUpdated,
}: {
  onClose: () => void;
  onPersonaUpdated: (
    persona: Array<{
      slug: string;
      title: string;
      body: string;
      editedByUser: boolean;
      updatedAt: string | null;
    }>,
  ) => void;
}) {
  type Turn = { role: "user" | "assistant"; content: string };
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentlyWritten, setRecentlyWritten] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<
    Array<{ slug: string; title: string; editedByUser: boolean }>
  >([]);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Kick off with an opening message from the model.
  useEffect(() => {
    void send("Bonjour, on commence l'interview pour configurer ma persona.", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [history, sending]);

  async function send(content: string, isOpening = false) {
    const trimmed = content.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    const next: Turn[] = [...history, { role: "user", content: trimmed }];
    if (!isOpening) setHistory(next);
    setInput("");
    try {
      const r = await api.onboardPersona(next);
      const assistantTurn: Turn = { role: "assistant", content: r.reply || "…" };
      setHistory((h) => (isOpening ? [assistantTurn] : [...h, assistantTurn]));
      setRecentlyWritten(r.written);
      setSnapshot(
        r.persona.map((p) => ({
          slug: p.slug,
          title: p.title,
          editedByUser: p.editedByUser,
        })),
      );
      onPersonaUpdated(r.persona);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[85vh] w-full max-w-[960px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl md:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left: chat */}
        <div className="flex flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
            <h3 className="font-display text-[18px] font-light text-navy">
              Persona interview
            </h3>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-ink"
            >
              ×
            </button>
          </header>
          <div
            ref={scrollRef}
            className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4"
          >
            {history.length === 0 && !error && (
              <div className="rounded-md bg-gray-50 px-4 py-6 text-center font-mono text-[11px] text-gray-400">
                Starting interview…
              </div>
            )}
            {history.map((t, i) => (
              <div
                key={i}
                className={`flex ${t.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2 text-[13px] leading-[20px] whitespace-pre-wrap ${
                    t.role === "user"
                      ? "bg-navy text-white"
                      : "bg-gray-100 text-ink"
                  }`}
                >
                  {t.content}
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex justify-start">
                <div className="max-w-[80%] rounded-2xl bg-gray-100 px-4 py-2 font-mono text-[11px] text-gray-400">
                  thinking…
                </div>
              </div>
            )}
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700">
                {error}
              </div>
            )}
          </div>
          <footer className="border-t border-gray-200 px-5 py-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="flex items-center gap-2"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your answer…"
                disabled={sending}
                autoFocus
                className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-40"
              >
                {sending ? "…" : "Send"}
              </button>
            </form>
          </footer>
        </div>

        {/* Right: persona snapshot */}
        <aside className="hidden w-[280px] flex-shrink-0 border-l border-gray-200 bg-gray-50 md:flex md:flex-col">
          <header className="border-b border-gray-200 px-4 py-3">
            <span className="text-[11px] font-medium tracking-[0.06em] text-gray-500 uppercase">
              Persona snapshot
            </span>
          </header>
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
            {snapshot.length === 0 ? (
              <span className="font-mono text-[11px] text-gray-400">
                No data captured yet.
              </span>
            ) : (
              snapshot.map((s) => {
                const just = recentlyWritten.includes(s.slug);
                return (
                  <div
                    key={s.slug}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 transition-colors ${
                      just
                        ? "border-cyan bg-cyan/10"
                        : s.editedByUser
                          ? "border-emerald-200 bg-white"
                          : "border-gray-200 bg-white"
                    }`}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[12px] font-medium text-ink">
                        {s.title}
                      </span>
                      <span className="font-mono text-[10px] text-gray-400">
                        profile/{s.slug}.md
                      </span>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] ${
                        just
                          ? "bg-cyan text-white"
                          : s.editedByUser
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-gray-100 text-gray-500"
                      }`}
                    >
                      {just ? "just saved" : s.editedByUser ? "authored" : "empty"}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/**
 * Paste-anything migration tool. The user dumps free-form text from
 * another LLM (ChatGPT memory export, Claude project instructions, a bio,
 * a CV, anything). Haiku extracts the 5 persona fields and writes them.
 *
 * Two-step flow: dryRun first, the user reviews what's about to be
 * written, then commits. Existing edits are NOT preserved on commit —
 * the import overwrites the slugs the model returned. Slugs the model
 * doesn't return are left untouched.
 */
function ImportPersonaModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Record<string, string> | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function runDry() {
    if (text.trim().length < 20) {
      setError("Paste at least a few sentences.");
      return;
    }
    setBusy(true);
    setError(null);
    setPreview(null);
    setNote(null);
    try {
      const r = await api.importPersona(text, { dryRun: true });
      setPreview(
        r.proposed && typeof r.proposed === "object"
          ? (r.proposed as Record<string, string>)
          : {},
      );
      if (r.note) setNote(r.note);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview || Object.keys(preview).length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.importPersona(text);
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const proposedKeys = preview ? Object.keys(preview) : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-[720px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <h3 className="font-display text-[18px] font-light text-navy">
            Import persona from another LLM
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-ink"
          >
            ×
          </button>
        </header>
        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          <p className="text-[13px] leading-[20px] text-gray-600">
            Paste anything: ChatGPT memory dump, Claude project custom
            instructions, a personal bio, a CV section, scattered notes.
            Haiku will read it and propose 5 articles. You'll see what's
            about to be written before it commits.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={10}
            placeholder="Paste here…"
            spellCheck={false}
            className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] leading-[18px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700">
              {error}
            </div>
          )}

          {preview && (
            <div className="flex flex-col gap-3">
              <span className="text-[12px] font-medium text-gray-700">
                Proposed{" "}
                <span className="text-gray-400">
                  ({proposedKeys.length}/5 fields)
                </span>
              </span>
              {proposedKeys.length === 0 ? (
                <span className="text-[12px] text-gray-500">
                  {note ?? "Nothing extracted from this input."}
                </span>
              ) : (
                proposedKeys.map((slug) => (
                  <details
                    key={slug}
                    className="rounded-md border border-gray-200 bg-gray-50 px-3 py-2"
                  >
                    <summary className="cursor-pointer text-[12px] font-medium text-ink">
                      profile/{slug}.md
                    </summary>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-[16px] text-gray-700">
                      {preview[slug]}
                    </pre>
                  </details>
                ))
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-gray-200 bg-white px-3.5 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          {!preview ? (
            <button
              type="button"
              onClick={runDry}
              disabled={busy || text.trim().length < 20}
              className="rounded-md bg-navy px-3.5 py-1.5 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-40"
            >
              {busy ? "Analysing…" : "Preview"}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setPreview(null)}
                disabled={busy}
                className="rounded-md border border-gray-200 bg-white px-3.5 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
              >
                Re-analyse
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={busy || proposedKeys.length === 0}
                className="rounded-md bg-navy px-3.5 py-1.5 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-40"
              >
                {busy
                  ? "Saving…"
                  : `Save ${proposedKeys.length} ${proposedKeys.length > 1 ? "articles" : "article"}`}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function ChangePasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setSaved(true);
      setCurrent("");
      setNext("");
      setConfirm("");
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("invalid_current_password")) {
        setError("Current password is wrong.");
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-[20px] font-light text-navy">
        Change password
      </h2>
      <form
        onSubmit={submit}
        className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4"
      >
        <Field label="Current password">
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
            className="w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-[14px] text-ink outline-none focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
          />
        </Field>
        <div className="flex items-center justify-end gap-3">
          {error && <span className="text-[12px] text-red-600">{error}</span>}
          {saved && <span className="text-[12px] text-emerald-600">Updated ✓</span>}
          <button
            type="submit"
            disabled={submitting}
            className="flex h-9 items-center rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Update password"}
          </button>
        </div>
      </form>
    </section>
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
