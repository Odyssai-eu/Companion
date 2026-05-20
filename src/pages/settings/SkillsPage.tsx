import { useEffect, useRef, useState } from "react";
import {
  api,
  type ApiSkill,
  type ApiSkillInput,
  type ApiSkillSummary,
} from "~/lib/api";

/**
 * Settings → Extensions → Skills.
 *
 * Agent-callable skill packages in the agentskills.io format (SKILL.md
 * + scripts/references/assets/). The chat model reads them via the
 * always-on skill_* tools; this page is the user-facing CRUD.
 */
export default function SkillsPage() {
  const [skills, setSkills] = useState<ApiSkillSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiSkill | "new" | null>(null);

  async function refresh() {
    try {
      const { skills } = await api.listSkills();
      setSkills(skills);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onDelete(id: string) {
    if (!confirm("Delete this skill? This cannot be undone.")) return;
    setBusy(true);
    try {
      await api.deleteSkill(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onEdit(id: string) {
    try {
      const { skill } = await api.getSkill(id);
      setEditing(skill);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="font-display text-[28px] font-light text-navy">
            Skills
          </h2>
          <p className="mt-1 max-w-xl text-[13px] text-gray-600">
            Markdown instruction packages the chat agent loads on demand
            (agentskills.io format). Drop a SKILL.md or a .zip below to import,
            or create one from scratch.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ImportButton
            onImported={refresh}
            onError={setError}
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="rounded-md bg-navy px-3 py-1.5 text-[13px] font-medium text-white hover:bg-ink"
          >
            New skill
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}{" "}
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-2 text-red-500 underline"
          >
            dismiss
          </button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        {skills.length === 0 ? (
          <div className="px-4 py-8 text-center text-[13px] text-gray-500">
            No skills yet. Create one or drop a SKILL.md/.zip to import.
          </div>
        ) : (
          <table className="w-full text-[13px]">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-medium tracking-[0.06em] text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Description</th>
                <th className="px-4 py-2">Source</th>
                <th className="px-4 py-2">Files</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-mono text-[12px] text-ink">
                    {s.name}
                  </td>
                  <td className="max-w-md truncate px-4 py-2 text-gray-700">
                    {s.description ?? (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-500">{s.source}</td>
                  <td className="px-4 py-2 text-gray-500">
                    {s.fileCount > 0 ? s.fileCount : ""}
                  </td>
                  <td className="flex items-center justify-end gap-3 px-4 py-2 text-[12px]">
                    <a
                      href={api.exportSkillUrl(s.id)}
                      className="text-gray-500 hover:text-ink"
                      download
                    >
                      Export
                    </a>
                    <button
                      type="button"
                      onClick={() => onEdit(s.id)}
                      className="text-gray-500 hover:text-ink"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(s.id)}
                      className="text-red-500 hover:text-red-700"
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <EditModal
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function ImportButton({
  onImported,
  onError,
  disabled,
}: {
  onImported: () => void;
  onError: (msg: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);

  async function handle(file: File) {
    try {
      if (/\.zip$/i.test(file.name)) {
        await api.importSkillZip(file);
      } else {
        const text = await file.text();
        await api.importSkillMd(text);
      }
      onImported();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <>
      <input
        ref={ref}
        type="file"
        accept=".md,.zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handle(f);
        }}
      />
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={disabled}
        className="rounded-md border border-gray-300 px-3 py-1.5 text-[13px] text-gray-700 hover:border-gray-400 hover:text-ink disabled:opacity-50"
      >
        Import…
      </button>
    </>
  );
}

function EditModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ApiSkill | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ApiSkillInput>(() => ({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    body: initial?.body ?? "",
    tags: initial?.tags ?? [],
    license: initial?.license ?? "",
    compatibility: initial?.compatibility ?? "",
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSave() {
    setSaving(true);
    setErr(null);
    try {
      const payload: ApiSkillInput = {
        ...draft,
        description: draft.description?.toString().trim() || null,
        license: draft.license?.toString().trim() || null,
        compatibility: draft.compatibility?.toString().trim() || null,
      };
      if (initial) {
        await api.updateSkill(initial.id, payload);
      } else {
        await api.createSkill(payload);
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-y-auto rounded-lg bg-white p-6 shadow-xl">
        <header className="flex items-baseline justify-between">
          <h3 className="font-display text-[22px] font-light text-navy">
            {initial ? `Edit ${initial.name}` : "New skill"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-ink"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <Field label="Name (slug)">
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="code-review-strict"
            className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-[13px]"
            disabled={!!initial}
          />
          <p className="mt-1 text-[11px] text-gray-500">
            Lowercase a-z / 0-9 / hyphen, 1-64 chars. Cannot be changed later.
          </p>
        </Field>

        <Field label="Description (when to invoke)">
          <textarea
            value={draft.description ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
            rows={2}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-[13px]"
          />
        </Field>

        <Field label="Body (markdown instructions)">
          <textarea
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            rows={14}
            className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-[12px]"
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="License (optional)">
            <input
              type="text"
              value={draft.license ?? ""}
              onChange={(e) => setDraft({ ...draft, license: e.target.value })}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-[13px]"
            />
          </Field>
          <Field label="Compatibility (optional)">
            <input
              type="text"
              value={draft.compatibility ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, compatibility: e.target.value })
              }
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-[13px]"
            />
          </Field>
        </div>

        {initial && Object.keys(initial.files).length > 0 && (
          <Field label={`Supporting files (${Object.keys(initial.files).length})`}>
            <ul className="rounded border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-[12px] text-gray-700">
              {Object.keys(initial.files).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="mt-1 text-[11px] text-gray-500">
              Editing supporting files is not yet supported here — re-import a
              ZIP to update them.
            </p>
          </Field>
        )}

        {err && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
            {err}
          </div>
        )}

        <footer className="flex items-center justify-end gap-3 border-t border-gray-100 pt-3">
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] text-gray-500 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !draft.name || !draft.body.trim()}
            className="rounded-md bg-navy px-3 py-1.5 text-[13px] font-medium text-white hover:bg-ink disabled:opacity-50"
          >
            {saving ? "Saving…" : initial ? "Save" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium tracking-[0.06em] text-gray-500 uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}
