import type { InferenceParams } from "~/hooks/useChat";

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

      <div className="flex gap-6">
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

      <div className="mt-5 border-t border-gray-100 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
            System prompt
          </span>
          <div className="flex items-center gap-2">
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
    </section>
  );
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
  return <div className="w-px bg-gray-100" />;
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
