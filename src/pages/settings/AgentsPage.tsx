import { useEffect, useRef, useState } from "react";
import { api, type ApiAgent, type ApiAgentInput } from "~/lib/api";
import { useAuth } from "~/hooks/useAuth";

/**
 * Settings → Extensions → Agents (v2.0).
 *
 * The executors of the Cowork runtime: Nemo (primary) + subagents the
 * task tool can delegate to. Builtins are instance rows — editable
 * (admin), disableable, never deletable (re-seeded at boot). Users add
 * personal agents; admins add instance agents everyone inherits.
 */
export default function AgentsPage() {
  const { role } = useAuth();
  const isAdminish = role === "admin" || role === "organiser";
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiAgent | "new" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      const { agents } = await api.listAgents();
      setAgents(agents);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function onToggle(a: ApiAgent) {
    try {
      await api.updateAgent(a.id, { enabled: !a.enabled });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onDelete(a: ApiAgent) {
    if (!confirm(`Delete agent "${a.name}"?`)) return;
    try {
      await api.deleteAgent(a.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onImport(file: File) {
    try {
      await api.importAgentMd(await file.text());
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h2 className="font-display text-[28px] font-light text-navy">
            Agents
          </h2>
          <p className="mt-1 max-w-xl text-[13px] text-gray-600">
            The executors of the runtime — Nemo holds the conversation and
            delegates self-contained jobs to subagents via the task tool.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".md"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void onImport(f);
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-[13px] text-gray-700 hover:border-gray-400 hover:text-ink"
          >
            Import…
          </button>
          <button
            type="button"
            onClick={() => setEditing("new")}
            className="rounded-md bg-navy px-3 py-1.5 text-[13px] font-medium text-white hover:bg-ink"
          >
            New agent
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
        <table className="w-full text-[13px]">
          <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-medium tracking-[0.06em] text-gray-500 uppercase">
            <tr>
              <th className="px-4 py-2">Agent</th>
              <th className="px-4 py-2">Mode</th>
              <th className="px-4 py-2">Model</th>
              <th className="px-4 py-2">Tools</th>
              <th className="px-4 py-2">Source</th>
              <th className="px-4 py-2">On</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="border-t border-gray-100">
                <td className="px-4 py-2">
                  <span className="font-mono text-[12px] text-ink">
                    {a.name}
                  </span>
                  <p className="max-w-md truncate text-[12px] text-gray-500">
                    {a.description}
                  </p>
                </td>
                <td className="px-4 py-2 text-gray-600">{a.mode}</td>
                <td className="px-4 py-2 font-mono text-[11px] text-gray-600">
                  {a.model ?? "inherit"}
                </td>
                <td className="max-w-[180px] truncate px-4 py-2 font-mono text-[11px] text-gray-500">
                  {a.toolsAllow.join(", ") || "—"}
                </td>
                <td className="px-4 py-2 text-gray-500">{a.source}</td>
                <td className="px-4 py-2">
                  <button
                    type="button"
                    onClick={() => onToggle(a)}
                    disabled={a.source !== "user" && !isAdminish}
                    className={`h-5 w-9 rounded-full transition-colors disabled:opacity-40 ${
                      a.enabled ? "bg-cyan" : "bg-gray-300"
                    }`}
                    aria-label={a.enabled ? "Disable" : "Enable"}
                  >
                    <span
                      className={`block h-4 w-4 rounded-full bg-white transition-transform ${
                        a.enabled ? "translate-x-4" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                </td>
                <td className="px-4 py-2 text-right text-[12px] whitespace-nowrap">
                  <a
                    href={api.exportAgentUrl(a.id)}
                    download
                    className="mr-3 text-gray-500 hover:text-ink"
                  >
                    Export
                  </a>
                  <button
                    type="button"
                    onClick={() => setEditing(a)}
                    disabled={a.source !== "user" && !isAdminish}
                    className="mr-3 text-gray-500 hover:text-ink disabled:opacity-40"
                  >
                    Edit
                  </button>
                  {a.source !== "builtin" && (
                    <button
                      type="button"
                      onClick={() => onDelete(a)}
                      disabled={a.source !== "user" && !isAdminish}
                      className="text-red-500 hover:text-red-700 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <AgentModal
          initial={editing === "new" ? null : editing}
          canInstance={isAdminish}
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

function AgentModal({
  initial,
  canInstance,
  onClose,
  onSaved,
}: {
  initial: ApiAgent | null;
  canInstance: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<ApiAgentInput>(() => ({
    name: initial?.name ?? "",
    displayName: initial?.displayName ?? "",
    description: initial?.description ?? "",
    mode: initial?.mode ?? "subagent",
    systemPrompt: initial?.systemPrompt ?? "",
    model: initial?.model ?? "",
    toolsAllow: initial?.toolsAllow ?? [],
    maxSteps: initial?.maxSteps ?? 15,
    instance: initial ? initial.userId === null : false,
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSave() {
    setSaving(true);
    setErr(null);
    try {
      const payload: ApiAgentInput = {
        ...draft,
        model: draft.model?.toString().trim() || null,
      };
      if (initial) {
        // instance flag is fixed after creation
        const { instance: _ignored, ...rest } = payload;
        void _ignored;
        await api.updateAgent(initial.id, rest);
      } else {
        await api.createAgent(payload);
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
            {initial ? `Edit ${initial.name}` : "New agent"}
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-lg text-gray-400 hover:text-ink"
          >
            ×
          </button>
        </header>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Name (slug)">
            <input
              type="text"
              value={draft.name}
              disabled={!!initial}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="research-fr"
              className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-[13px] disabled:bg-gray-50"
            />
          </Field>
          <Field label="Display name">
            <input
              type="text"
              value={draft.displayName}
              onChange={(e) =>
                setDraft({ ...draft, displayName: e.target.value })
              }
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-[13px]"
            />
          </Field>
        </div>

        <Field label="Description (when to delegate — read by the model)">
          <textarea
            value={draft.description ?? ""}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
            rows={2}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-[13px]"
          />
        </Field>

        <Field label="System prompt">
          <textarea
            value={draft.systemPrompt}
            onChange={(e) =>
              setDraft({ ...draft, systemPrompt: e.target.value })
            }
            rows={12}
            className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-[12px]"
          />
        </Field>

        <div className="grid grid-cols-3 gap-4">
          <Field label="Model (empty = inherit)">
            <input
              type="text"
              value={draft.model ?? ""}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="tele-fast"
              className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-[12px]"
            />
          </Field>
          <Field label="Max steps">
            <input
              type="number"
              min={1}
              max={50}
              value={draft.maxSteps ?? 15}
              onChange={(e) =>
                setDraft({ ...draft, maxSteps: Number(e.target.value) || 15 })
              }
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-[13px]"
            />
          </Field>
          <Field label="Mode">
            <select
              value={draft.mode}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  mode: e.target.value as "primary" | "subagent",
                })
              }
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-[13px]"
            >
              <option value="subagent">subagent</option>
              <option value="primary">primary</option>
            </select>
          </Field>
        </div>

        <Field label="Allowed tools (comma-separated; exact name or trailing-star prefix, e.g. fs_*, mcp_qdrant_*)">
          <input
            type="text"
            value={(draft.toolsAllow ?? []).join(", ")}
            onChange={(e) =>
              setDraft({
                ...draft,
                toolsAllow: e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
              })
            }
            className="w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-[12px]"
          />
        </Field>

        {!initial && canInstance && (
          <label className="flex items-center gap-2 text-[13px] text-gray-700">
            <input
              type="checkbox"
              checked={draft.instance ?? false}
              onChange={(e) =>
                setDraft({ ...draft, instance: e.target.checked })
              }
            />
            Instance agent (inherited by every account)
          </label>
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
            disabled={
              saving ||
              !draft.name ||
              !draft.displayName ||
              !draft.systemPrompt.trim()
            }
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
