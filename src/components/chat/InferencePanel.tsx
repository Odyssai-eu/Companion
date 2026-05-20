import { useEffect, useState } from "react";
import type { InferenceParams } from "~/hooks/useChat";
import { api, type ApiInferencePreset } from "~/lib/api";

type Props = {
  params: InferenceParams;
  onChange: (next: Partial<InferenceParams>) => void;
  onClose: () => void;
};

export default function InferencePanel({ params, onChange, onClose }: Props) {
  return (
    <section className="border-b border-gray-200 bg-white px-6 py-5">
      <header className="mb-4 flex items-center justify-between">
        <span className="font-display text-[16px] font-light text-navy">
          Inference settings
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="text-lg text-gray-400 hover:text-ink"
        >
          ×
        </button>
      </header>

      <InferencePresetsRow params={params} onChange={onChange} />

      <div className="flex flex-col gap-6 md:flex-row">
        <Column title="Generation">
          <Slider
            label="Temperature"
            value={params.temperature}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => onChange({ temperature: v })}
          />
          <NumberField
            label="Max tokens"
            value={params.maxTokens}
            onChange={(v) => onChange({ maxTokens: v ?? 32768 })}
          />
          <Toggle
            label="Thinking"
            value={params.thinking}
            onChange={(v) => onChange({ thinking: v })}
          />
          {params.thinking && (
            <SelectField
              label="Reasoning effort"
              value={params.reasoningEffort}
              options={["none", "minimal", "low", "medium", "high", "xhigh"]}
              onChange={(v) =>
                onChange({
                  reasoningEffort: v as InferenceParams["reasoningEffort"],
                })
              }
            />
          )}
        </Column>

        <Divider />

        <Column title="Sampling">
          <Slider
            label="Top P"
            value={params.topP ?? 0}
            valueLabel={params.topP === null ? "—" : params.topP.toFixed(2)}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => onChange({ topP: v === 0 ? null : v })}
          />
          <NumberField
            label="Top K"
            value={params.topK}
            onChange={(v) => onChange({ topK: v })}
            placeholder="—"
          />
          <Slider
            label="Min P"
            value={params.minP ?? 0}
            valueLabel={params.minP === null ? "—" : params.minP.toFixed(2)}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(v) => onChange({ minP: v === 0 ? null : v })}
          />
        </Column>

        <Divider />

        <Column title="Penalties & seed">
          <Slider
            label="Rep. penalty"
            value={params.repPenalty ?? 1}
            valueLabel={
              params.repPenalty === null ? "—" : params.repPenalty.toFixed(2)
            }
            min={1}
            max={2}
            step={0.05}
            onChange={(v) => onChange({ repPenalty: v > 1 ? v : null })}
          />
          <NumberField
            label="Seed"
            value={params.seed}
            onChange={(v) => onChange({ seed: v })}
            placeholder="—"
          />
        </Column>
      </div>

      <SystemPromptSection params={params} onChange={onChange} />
    </section>
  );
}

function SystemPromptSection({
  params,
  onChange,
}: {
  params: InferenceParams;
  onChange: (next: Partial<InferenceParams>) => void;
}) {
  // Free-form, conversation-level system prompt. Named reusable
  // prompts moved to agent_skills (Settings → Skills); the chat panel
  // no longer save/loads named entries here.
  return (
    <div className="mt-5 border-t border-gray-100 pt-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
          System prompt
        </span>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-gray-400">
            {params.systemPromptEnabled ? "included" : "not included"}
          </span>
          <Toggle
            label=""
            value={params.systemPromptEnabled}
            onChange={(v) => onChange({ systemPromptEnabled: v })}
          />
        </div>
      </div>
      <textarea
        value={params.systemPrompt}
        onChange={(e) => onChange({ systemPrompt: e.target.value })}
        placeholder="You are a helpful assistant. Answer in concise markdown."
        rows={3}
        className="w-full resize-y rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-ink outline-none placeholder:text-gray-400 focus:border-cyan focus:shadow-[0_0_0_3px_rgba(79,179,217,0.12)]"
      />
    </div>
  );
}

/**
 * Saved inference presets — sampling-param bundles the user names and
 * reloads. Mirrors the System prompt section's UX (Load saved… dropdown,
 * Save current button, chip list with delete). Server-backed, scoped to
 * the current user.
 *
 * System prompt is deliberately NOT included in a preset — it lives at
 * the project / chat level and is saved separately.
 */
function InferencePresetsRow({
  params,
  onChange,
}: {
  params: InferenceParams;
  onChange: (next: Partial<InferenceParams>) => void;
}) {
  const [presets, setPresets] = useState<ApiInferencePreset[]>([]);

  async function reload() {
    try {
      const { presets } = await api.listInferencePresets();
      setPresets(presets);
    } catch {
      // ignore — empty list is fine
    }
  }
  useEffect(() => {
    reload();
  }, []);

  function applyPreset(p: ApiInferencePreset) {
    const patch: Partial<InferenceParams> = {};
    if (p.temperature != null) patch.temperature = p.temperature;
    if (p.maxTokens != null) patch.maxTokens = p.maxTokens;
    // Null on a preset means "leave default" (i.e. don't push to upstream),
    // mapped here to InferenceParams' nullable convention. We DO push null
    // explicitly so the previous value is cleared — applying a preset is a
    // full replacement of the sampling section, not a partial overlay.
    patch.topP = p.topP;
    patch.topK = p.topK;
    patch.minP = p.minP;
    patch.repPenalty = p.repetitionPenalty;
    patch.seed = p.seed;
    // Reasoning controls — restore only when the preset saved them.
    // A preset created before this field existed has `thinking === null`,
    // we leave the current value untouched in that case.
    if (p.thinking !== null) patch.thinking = p.thinking;
    if (p.reasoningEffort !== null) patch.reasoningEffort = p.reasoningEffort;
    onChange(patch);
  }

  async function saveCurrent() {
    const name = window.prompt("Name this preset:", "")?.trim();
    if (!name) return;
    try {
      await api.createInferencePreset({
        name,
        temperature: params.temperature,
        maxTokens: params.maxTokens,
        topP: params.topP,
        topK: params.topK,
        minP: params.minP,
        repetitionPenalty: params.repPenalty,
        seed: params.seed,
        thinking: params.thinking,
        reasoningEffort: params.reasoningEffort,
      });
      await reload();
    } catch (e) {
      alert(`Couldn't save: ${(e as Error).message}`);
    }
  }

  async function deletePreset(id: string, name: string) {
    if (!confirm(`Delete saved preset "${name}"?`)) return;
    try {
      await api.deleteInferencePreset(id);
      await reload();
    } catch (e) {
      alert(`Couldn't delete: ${(e as Error).message}`);
    }
  }

  return (
    <div className="mb-5 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
          Presets
        </span>
        <div className="flex items-center gap-3">
          <select
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              const p = presets.find((x) => x.id === e.target.value);
              if (p) applyPreset(p);
              e.target.value = "";
            }}
            className="rounded border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-600 hover:border-gray-300"
          >
            <option value="">Load saved…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={saveCurrent}
            className="text-[11px] text-cyan hover:text-navy"
          >
            Save current
          </button>
        </div>
      </div>
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <span
              key={p.id}
              className="group inline-flex items-center rounded-full border border-gray-200 bg-white text-[11px] text-gray-600 hover:border-cyan hover:text-navy"
            >
              <button
                type="button"
                onClick={() => applyPreset(p)}
                title={summarizePreset(p)}
                className="rounded-l-full pr-1 pl-2.5 py-0.5"
              >
                {p.name}
              </button>
              <button
                type="button"
                onClick={() => deletePreset(p.id, p.name)}
                aria-label={`Delete ${p.name}`}
                className="ml-0.5 rounded-r-full pr-2 pl-1 py-0.5 text-gray-300 hover:text-red-500"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function summarizePreset(p: ApiInferencePreset): string {
  const parts: string[] = [];
  if (p.temperature != null) parts.push(`temp ${p.temperature}`);
  if (p.topP != null) parts.push(`top_p ${p.topP}`);
  if (p.topK != null) parts.push(`top_k ${p.topK}`);
  if (p.minP != null) parts.push(`min_p ${p.minP}`);
  if (p.repetitionPenalty != null) parts.push(`rep ${p.repetitionPenalty}`);
  if (p.maxTokens != null) parts.push(`max ${p.maxTokens}`);
  if (p.seed != null) parts.push(`seed ${p.seed}`);
  if (p.thinking != null) parts.push(p.thinking ? "thinking" : "no-think");
  if (p.reasoningEffort != null) parts.push(`effort ${p.reasoningEffort}`);
  return parts.join(" · ") || "(empty preset — no params set)";
}

function Column({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col gap-3.5">
      <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
        {title}
      </span>
      {children}
    </div>
  );
}

function Divider() {
  return <div className="hidden w-px bg-gray-100 md:block" />;
}

function Slider({
  label,
  value,
  valueLabel,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  valueLabel?: string;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-gray-700">{label}</span>
        <span className="font-mono text-[12px] text-gray-900">
          {valueLabel ?? value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="h-1.5 w-full appearance-none rounded bg-gray-100 accent-cyan"
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number | null;
  placeholder?: string;
  onChange: (n: number | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-gray-700">{label}</span>
      <input
        type="number"
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          onChange(Number.isFinite(n) ? n : null);
        }}
        className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none placeholder:text-gray-400 focus:border-cyan"
      />
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-gray-700">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-cyan"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      {label && <span className="text-[12px] font-medium text-gray-700">{label}</span>}
      <button
        type="button"
        onClick={() => onChange(!value)}
        className={`flex h-5 w-9 items-center rounded-full px-0.5 transition-colors ${
          value ? "justify-end bg-navy" : "justify-start bg-gray-200"
        }`}
      >
        <div className="h-4 w-4 rounded-full bg-white shadow-sm" />
      </button>
    </div>
  );
}
