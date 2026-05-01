import { useEffect, useState } from "react";
import { useAuth } from "~/hooks/useAuth";
import { api } from "~/lib/api";

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
    </div>
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

  useEffect(() => {
    api
      .getPersona()
      .then((r) => {
        setRows(r.persona);
        const d: Record<string, string> = {};
        for (const p of r.persona) d[p.slug] = p.body;
        setDrafts(d);
      })
      .catch((e) => setError((e as Error).message));
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
      <header className="flex flex-col gap-1">
        <h2 className="font-display text-[20px] font-light text-navy">
          Persona
        </h2>
        <p className="max-w-[640px] text-[13px] leading-[20px] text-gray-600">
          Five reserved articles in your memory wiki, hand-authored. They tell
          the model who you are, how you want to be talked to, and how the
          output should read. The wiki compiler skips these — only you write
          them. Edit here or via Obsidian.
        </p>
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
    </section>
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
