import { useEffect, useState } from "react";
import {
  api,
  type ApiGlobalModel,
  type ApiInferencePreset,
  type ApiInferencePresetInput,
} from "~/lib/api";

/**
 * Inference presets — UI for the named sampling-param bundles the
 * user saves and reloads.
 *
 * Apply flow: writes the preset's values into the chat-side
 * `thecompai:inference` localStorage entry and (optionally) the
 * `thecompai:model` entry when modelId is set, then dispatches the
 * "thecompai:inference-changed" event so any open useChat hook
 * re-reads its state without a full reload.
 *
 * System prompt is intentionally not part of a preset — it lives at
 * the project level or per-chat.
 */

const INFERENCE_KEY = "thecompai:inference";
const MODEL_KEY = "thecompai:model";

type EditDraft = {
  id?: string;
  name: string;
  modelId: string;
  temperature: string;
  topP: string;
  topK: string;
  minP: string;
  repetitionPenalty: string;
  maxTokens: string;
  seed: string;
  hfReferenceUrl: string;
  notes: string;
};

const EMPTY_DRAFT: EditDraft = {
  name: "",
  modelId: "",
  temperature: "",
  topP: "",
  topK: "",
  minP: "",
  repetitionPenalty: "",
  maxTokens: "",
  seed: "",
  hfReferenceUrl: "",
  notes: "",
};

export default function PresetsSection({
  models,
}: {
  models: ApiGlobalModel[];
}) {
  const [presets, setPresets] = useState<ApiInferencePreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  async function reload() {
    try {
      const { presets } = await api.listInferencePresets();
      setPresets(presets);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  function startNew() {
    setEditing({ ...EMPTY_DRAFT });
  }

  function startSaveCurrent() {
    // Pre-fill from the current chat-side inference state. Useful for
    // "I tuned these params, now save them as a named preset".
    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = window.localStorage.getItem(INFERENCE_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch {
      // ignore — use empty draft
    }
    setEditing({
      ...EMPTY_DRAFT,
      temperature: pickStr(parsed?.temperature),
      topP: pickStr(parsed?.topP),
      topK: pickStr(parsed?.topK),
      minP: pickStr(parsed?.minP),
      repetitionPenalty: pickStr(parsed?.repPenalty),
      maxTokens: pickStr(parsed?.maxTokens),
      seed: pickStr(parsed?.seed),
    });
  }

  function startEdit(p: ApiInferencePreset) {
    setEditing({
      id: p.id,
      name: p.name,
      modelId: p.modelId ?? "",
      temperature: pickStr(p.temperature),
      topP: pickStr(p.topP),
      topK: pickStr(p.topK),
      minP: pickStr(p.minP),
      repetitionPenalty: pickStr(p.repetitionPenalty),
      maxTokens: pickStr(p.maxTokens),
      seed: pickStr(p.seed),
      hfReferenceUrl: p.hfReferenceUrl ?? "",
      notes: p.notes ?? "",
    });
  }

  async function save() {
    if (!editing) return;
    if (!editing.name.trim()) {
      setError("Name is required.");
      return;
    }
    const body: ApiInferencePresetInput = {
      name: editing.name.trim(),
      modelId: editing.modelId.trim() || null,
      temperature: parseNum(editing.temperature),
      topP: parseNum(editing.topP),
      topK: parseInt2(editing.topK),
      minP: parseNum(editing.minP),
      repetitionPenalty: parseNum(editing.repetitionPenalty),
      maxTokens: parseInt2(editing.maxTokens),
      seed: parseInt2(editing.seed),
      hfReferenceUrl: editing.hfReferenceUrl.trim() || null,
      notes: editing.notes.trim() || null,
    };
    try {
      if (editing.id) {
        await api.updateInferencePreset(editing.id, body);
      } else {
        await api.createInferencePreset(body);
      }
      setEditing(null);
      setError(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this preset?")) return;
    try {
      await api.deleteInferencePreset(id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function apply(p: ApiInferencePreset) {
    // Merge into the existing chat-side state — leave thinking /
    // reasoning_effort / systemPrompt untouched (those are not part
    // of a preset by design).
    let current: Record<string, unknown> = {};
    try {
      const raw = window.localStorage.getItem(INFERENCE_KEY);
      if (raw) current = JSON.parse(raw);
    } catch {
      // ignore — start empty
    }
    const merged = {
      ...current,
      temperature: p.temperature ?? current.temperature ?? 0.7,
      maxTokens: p.maxTokens ?? current.maxTokens ?? 8192,
      topP: p.topP,
      topK: p.topK,
      minP: p.minP,
      repPenalty: p.repetitionPenalty,
      seed: p.seed,
    };
    window.localStorage.setItem(INFERENCE_KEY, JSON.stringify(merged));
    if (p.modelId) {
      window.localStorage.setItem(MODEL_KEY, p.modelId);
    }
    window.dispatchEvent(
      new CustomEvent("thecompai:inference-changed", {
        detail: { presetId: p.id, applied: merged, model: p.modelId },
      }),
    );
    setApplyMsg(`Applied "${p.name}"`);
    setTimeout(() => setApplyMsg(null), 1800);
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-[22px] font-light text-navy">
          Inference presets
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={startSaveCurrent}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50"
          >
            Save current
          </button>
          <button
            type="button"
            onClick={startNew}
            className="rounded-md bg-navy px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-95"
          >
            New preset
          </button>
        </div>
      </div>
      <p className="text-[13px] text-gray-600">
        Named bundles of sampling parameters (temperature, top_p, top_k,
        min_p, repetition penalty, max tokens, seed). Optionally bound to
        a specific model — applying then switches the picker too. System
        prompt is saved separately on the project.
      </p>

      {loading ? (
        <div className="font-mono text-[12px] text-gray-400">Loading…</div>
      ) : presets.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-200 bg-white px-4 py-6 text-center text-[13px] text-gray-500">
          No presets yet. Click <strong>New preset</strong> to create one, or{" "}
          <strong>Save current</strong> to snapshot your current params.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {presets.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              onApply={() => apply(p)}
              onEdit={() => startEdit(p)}
              onDelete={() => remove(p.id)}
            />
          ))}
        </div>
      )}

      {applyMsg && (
        <span className="font-mono text-[12px] text-emerald-600">
          ✓ {applyMsg}
        </span>
      )}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[12px] text-red-700">
          {error}
        </div>
      )}

      {editing && (
        <EditModal
          draft={editing}
          models={models}
          onChange={setEditing}
          onSave={save}
          onCancel={() => {
            setEditing(null);
            setError(null);
          }}
        />
      )}
    </section>
  );
}

function PresetCard({
  preset,
  onApply,
  onEdit,
  onDelete,
}: {
  preset: ApiInferencePreset;
  onApply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const summary: string[] = [];
  if (preset.temperature != null) summary.push(`temp ${preset.temperature}`);
  if (preset.topP != null) summary.push(`top_p ${preset.topP}`);
  if (preset.topK != null) summary.push(`top_k ${preset.topK}`);
  if (preset.minP != null) summary.push(`min_p ${preset.minP}`);
  if (preset.repetitionPenalty != null)
    summary.push(`rep ${preset.repetitionPenalty}`);
  if (preset.maxTokens != null) summary.push(`max ${preset.maxTokens}`);
  if (preset.seed != null) summary.push(`seed ${preset.seed}`);
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[14px] font-medium text-ink">
            {preset.name}
          </span>
          {preset.modelId && (
            <span className="truncate font-mono text-[11px] text-cyan">
              ⚙ {preset.modelId}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onApply}
            className="rounded-md bg-cyan px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded-md border border-rose-200 bg-white px-2.5 py-1 text-[11px] text-rose-700 hover:bg-rose-50"
          >
            Delete
          </button>
        </div>
      </div>
      {summary.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-gray-500">
          {summary.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      )}
      {preset.hfReferenceUrl && (
        <a
          href={preset.hfReferenceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate font-mono text-[11px] text-cyan hover:underline"
        >
          ↗ {preset.hfReferenceUrl}
        </a>
      )}
      {preset.notes && (
        <p className="whitespace-pre-wrap text-[12px] text-gray-600">
          {preset.notes}
        </p>
      )}
    </div>
  );
}

function EditModal({
  draft,
  models,
  onChange,
  onSave,
  onCancel,
}: {
  draft: EditDraft;
  models: ApiGlobalModel[];
  onChange: (next: EditDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  function set<K extends keyof EditDraft>(key: K, value: EditDraft[K]) {
    onChange({ ...draft, [key]: value });
  }
  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-ink/40 p-6"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[560px] flex-col gap-4 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-[20px] font-light text-navy">
          {draft.id ? "Edit preset" : "New preset"}
        </h3>

        <Field label="Name" required>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Qwen3.6 — recommended (HF)"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
          />
        </Field>

        <Field
          label="Bound model (optional)"
          hint="When set, Apply also switches the chat picker to this model."
        >
          <select
            value={draft.modelId}
            onChange={(e) => set("modelId", e.target.value)}
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] outline-none focus:border-cyan"
          >
            <option value="">(no binding — generic preset)</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            {draft.modelId &&
              !models.some((m) => m.id === draft.modelId) && (
                <option value={draft.modelId}>{draft.modelId}</option>
              )}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <NumField label="Temperature" v={draft.temperature} on={(v) => set("temperature", v)} step="0.05" />
          <NumField label="top_p" v={draft.topP} on={(v) => set("topP", v)} step="0.01" />
          <NumField label="top_k" v={draft.topK} on={(v) => set("topK", v)} step="1" />
          <NumField label="min_p" v={draft.minP} on={(v) => set("minP", v)} step="0.01" />
          <NumField
            label="Repetition penalty"
            v={draft.repetitionPenalty}
            on={(v) => set("repetitionPenalty", v)}
            step="0.05"
          />
          <NumField
            label="Max tokens"
            v={draft.maxTokens}
            on={(v) => set("maxTokens", v)}
            step="64"
          />
          <NumField label="Seed" v={draft.seed} on={(v) => set("seed", v)} step="1" />
        </div>

        <Field
          label="HF reference URL (optional)"
          hint="A link to where this preset comes from. Pure documentation."
        >
          <input
            type="url"
            value={draft.hfReferenceUrl}
            onChange={(e) => set("hfReferenceUrl", e.target.value)}
            placeholder="https://huggingface.co/…"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] outline-none focus:border-cyan"
          />
        </Field>

        <Field label="Notes (optional)">
          <textarea
            value={draft.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={3}
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
          />
        </Field>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-gray-200 bg-white px-4 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            className="rounded-md bg-navy px-4 py-1.5 text-[13px] font-medium text-white hover:opacity-95"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] tracking-[0.04em] text-gray-500 uppercase">
        {label}
        {required && <span className="ml-1 text-rose-500">*</span>}
      </span>
      {children}
      {hint && (
        <span className="font-mono text-[11px] text-gray-400">{hint}</span>
      )}
    </div>
  );
}

function NumField({
  label,
  v,
  on,
  step,
}: {
  label: string;
  v: string;
  on: (next: string) => void;
  step: string;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={v}
        onChange={(e) => on(e.target.value)}
        step={step}
        placeholder="(default)"
        className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] outline-none focus:border-cyan"
      />
    </Field>
  );
}

function pickStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return "";
}

function parseNum(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function parseInt2(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}
