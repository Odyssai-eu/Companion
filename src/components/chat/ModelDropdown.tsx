import { useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "~/hooks/useIsMobile";
import { AUTO_ROUTER_MODEL_ID, type ApiGlobalModel } from "~/lib/api";
import { formatBytes } from "~/lib/file-attach";
import { formatTokenCount } from "~/lib/tokens";

/**
 * Turn a raw model path into a human label for the picker.
 *
 * The engine publishes the real model identity in `alias_for` (e.g.
 * "mlx-community/Step-3.7-Flash-8bit") — the cluster alias the client
 * dials ("kolos", "default") is just a routing handle, not something a
 * user should read. So we strip the org prefix and the trailing quant
 * token to get the model's actual name: "Step-3.7-Flash". The quant
 * still shows in the row's subtitle, so dropping it here isn't lossy.
 */
function prettyModelName(raw?: string | null): string | null {
  if (!raw) return null;
  let s = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  // trailing quant: -8bit, -MLX-9bit, -4-bit, _8bit, … (optional MLX infix)
  s = s.replace(/[-_](?:MLX[-_])?\d+(?:[._]\d+)?-?bit$/i, "");
  s = s.replace(/[-_]MLX$/i, "");
  return s.trim() || raw;
}

/**
 * The label shown as the primary line of a picker row (and on the
 * trigger). Prefer the real model name from the capability contract;
 * fall back to the server-given name, then the raw id. The synthetic
 * "Auto" entry and cloud aliases (no `odyssai`) fall straight through
 * to `name`.
 */
function modelDisplayName(m: ApiGlobalModel): string {
  return prettyModelName(m.odyssai?.alias_for) ?? m.name ?? m.id;
}

/**
 * The model picker used in the chat composer AND in the Auto Router
 * add-on settings. Renders a dropdown list grouped by tag, with rich
 * per-row metadata (cluster label, family, quant, status badges) when
 * the engine speaks the Odyssai capability contract.
 *
 * The "Auto" synthetic entry is inserted by default — the chat picker
 * needs it as the first option. Surfaces that don't (Auto Router
 * buckets — Auto IS the router) pass `includeAuto={false}`.
 *
 * Hide / unhide is a chat-mode concern. Surfaces that don't need it leave
 * `hiddenModels` empty and omit `onToggleHidden`.
 *
 * (Pre-0058 this component also took an `inferenceMode` prop, because
 * 'easy' mode stripped hidden ids from the list entirely. 'easy' is gone
 * and its successor 'auto' renders no picker at all, so the picker no
 * longer has a mode-dependent behaviour and the prop was dropped.)
 */
export type ModelDropdownProps = {
  value: string;
  onChange: (id: string) => void;
  models: ApiGlobalModel[];
  /** Models the user hid from the picker. They render grayed out with an
   *  eye toggle so they can be un-hidden in context. */
  hiddenModels?: string[];
  /** Render the eye-toggle next to each row (chat-mode admin). */
  onToggleHidden?: (id: string) => void;
  /** When true (default), the synthetic "auto" entry is inserted at
   *  the top under the "Smart" group. Pass false on surfaces where
   *  Auto would be circular (the Auto Router buckets themselves). */
  includeAuto?: boolean;
  /** Optional label override for the trigger button. Defaults to the
   *  selected model's display name. */
  triggerLabel?: string;
  /** Optional placeholder shown on the trigger when value is empty. */
  placeholder?: string;
  /** Render with full-width trigger (for settings page bucket cards)
   *  rather than the chat composer's auto-width pill. */
  fullWidth?: boolean;
};

export default function ModelDropdown({
  value,
  onChange,
  models,
  hiddenModels = [],
  onToggleHidden,
  includeAuto = true,
  triggerLabel,
  placeholder = "Pick a model",
  fullWidth = false,
}: ModelDropdownProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // Hidden ids stay in the list, rendered grayed, with the eye toggle so
  // they can be un-hidden inline.
  const hiddenSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);

  // The "Auto" synthetic entry — picks chat / deep / code automatically
  // via the semantic-router add-on. Always rendered first when included.
  // If the add-on isn't ready, the server says so on the first send and
  // answers with the router's fallback model (see chat.ts).
  const AUTO_MODEL: ApiGlobalModel = useMemo(
    () => ({
      id: AUTO_ROUTER_MODEL_ID,
      name: "Auto — pick best model per message",
      tags: ["Smart"],
      capabilities: { vision: false, tools: false },
    }),
    [],
  );

  // Group by tag (first tag wins). Untagged → "Other". Auto, when
  // included, always sits at the top of the list in its own "Smart"
  // group. Group keys are surfaced as the heading (uppercased via
  // CSS class) — telemak / argo / cloud become TELEMAK / ARGO / CLOUD.
  const groups = useMemo(() => {
    const out = new Map<string, ApiGlobalModel[]>();
    if (includeAuto) out.set("Smart", [AUTO_MODEL]);
    for (const m of models) {
      // dedupe if the backend ever lists the routing sentinel itself
      if (m.id === AUTO_ROUTER_MODEL_ID) continue;
      const tag = m.tags[0] ?? "Models";
      const list = out.get(tag) ?? [];
      list.push(m);
      out.set(tag, list);
    }
    return Array.from(out.entries());
  }, [models, AUTO_MODEL, includeAuto]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const current =
    value === AUTO_ROUTER_MODEL_ID && includeAuto
      ? AUTO_MODEL
      : models.find((m) => m.id === value);
  const label =
    triggerLabel ??
    (value === AUTO_ROUTER_MODEL_ID && includeAuto
      ? "Auto"
      : current
        ? modelDisplayName(current)
        : value || placeholder);

  return (
    <div ref={wrapperRef} className={`relative ${fullWidth ? "w-full" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 font-mono text-[11px] text-gray-700 hover:bg-gray-50 hover:text-ink ${
          fullWidth ? "w-full justify-between" : ""
        }`}
      >
        <span className={`truncate ${fullWidth ? "" : "max-w-[260px]"}`}>
          {label}
        </span>
        <ChevronIcon />
      </button>
      {open && (
        <div
          className={`absolute bottom-full z-30 mb-2 max-h-[400px] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg ${
            fullWidth
              ? "left-0 right-0 w-auto"
              : isMobile
                ? // Mobile: trigger sits on the left of the row (justify-between
                  // with a single child), so anchor the panel to the trigger's
                  // left edge and let it extend right, clamped to viewport.
                  "left-0 w-[min(380px,calc(100vw-1.5rem))]"
                : "right-0 w-[380px]"
          }`}
        >
          {models.length === 0 && (
            <div className="px-3 py-4 text-center font-mono text-[11px] text-gray-400">
              No models — pair an engine in Settings → Inference, or check that
              the paired engine has a model loaded.
            </div>
          )}
          {groups.map(([group, list]) => (
            <div key={group}>
              <div className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 font-mono text-[10px] tracking-[0.05em] text-gray-500 uppercase">
                {group}
              </div>
              {list.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  selected={m.id === value}
                  hidden={hiddenSet.has(m.id)}
                  showHideToggle={!!onToggleHidden}
                  onToggleHidden={
                    onToggleHidden ? () => onToggleHidden(m.id) : undefined
                  }
                  onPick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One row in the ModelDropdown. Renders the alias on the first line,
 * a compact metadata line below (family · quantization · ctx), plus
 * status badges (loaded / loading / cold) when the Odyssai capability
 * contract is available. Hover tooltip carries the long-form details
 * (size, backend, nodes, tps, cold-start ETA) so the picker stays
 * scannable without losing the depth a power user wants.
 *
 * When `m.odyssai` is absent (cloud aliases, no engine configured),
 * we fall back to just the alias + vision chip — same as before.
 */
function ModelRow({
  model,
  selected,
  hidden = false,
  showHideToggle = false,
  onToggleHidden,
  onPick,
}: {
  model: ApiGlobalModel;
  selected: boolean;
  /** True when this model is in the user's hide list. Renders grayed
   *  out so the user remembers it exists. Clicking the row still picks
   *  it (we don't lock the selection — only easy mode filters). */
  hidden?: boolean;
  /** When true, render the eye-toggle next to the row's right-side
   *  badges so the user can hide/un-hide inline. */
  showHideToggle?: boolean;
  onToggleHidden?: () => void;
  onPick: () => void;
}) {
  const o = model.odyssai;
  const subtitle = o
    ? [
        o.family ?? null,
        o.quantization ?? null,
        o.context_length ? `ctx ${formatTokenCount(o.context_length)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const tooltip = o ? buildOdyssaiTooltip(o) : undefined;
  return (
    <div
      className={`group/row flex w-full items-start gap-2 px-3 py-2 text-[13px] ${
        selected ? "bg-cyan/10 text-navy" : "text-ink hover:bg-gray-50"
      } ${hidden ? "opacity-45" : ""}`}
    >
      <button
        type="button"
        onClick={onPick}
        title={tooltip}
        className="flex flex-1 min-w-0 flex-col gap-1 text-left"
      >
        {/* Name on its own full-width line — never squeezed by the badges
            (the cause of the unreadable "MI:Min…" / "or:deepse…" truncation).
            Long ids wrap instead of clipping so the model is always legible. */}
        <span className="break-words font-mono leading-snug">
          {modelDisplayName(model)}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {subtitle && (
            <span className="font-mono text-[10px] text-gray-500">
              {subtitle}
            </span>
          )}
          {o && <PoolBadge caps={o} />}
          {o && <LoadStateBadge caps={o} />}
          {model.capabilities.vision && (
            <span
              title="Vision-capable"
              className="rounded-full bg-cyan/15 px-1.5 py-0.5 text-[10px] text-cyan-700"
            >
              👁
            </span>
          )}
          {model.capabilities.tools && (
            <span
              title="Tool / function calling"
              className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700"
            >
              ⚒
            </span>
          )}
        </span>
      </button>
      {showHideToggle && onToggleHidden && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleHidden();
          }}
          title={hidden ? "Show in picker" : "Hide from picker"}
          className="shrink-0 self-center rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 hover:text-ink group-hover/row:opacity-100"
        >
          {/* eye-slash if hidden, eye if visible */}
          <span aria-hidden className="text-[14px] leading-none">
            {hidden ? "🙈" : "👁"}
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * Small state pill on the right of each row. Three visual states:
 *   🟢 loaded  — green, model is warm and ready
 *   🟡 loading — amber pulse, hot-loading (4-8 min for big MoEs)
 *   ⚪ cold    — neutral, exists in the catalog but not in RAM
 *   (none)     — no capability info (cloud or non-Odyssai engine)
 */
function LoadStateBadge({
  caps,
}: {
  caps: NonNullable<ApiGlobalModel["odyssai"]>;
}) {
  if (caps.loading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] text-amber-800">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        loading
      </span>
    );
  }
  if (caps.loaded) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        loaded
      </span>
    );
  }
  if (caps.admin_loadable) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600">
        <span className="h-1.5 w-1.5 rounded-full bg-gray-300" />
        cold
      </span>
    );
  }
  return null;
}

/**
 * Cloud vs local origin pill. Driven by `caps.backend`: `http-proxy`
 * means the engine is proxying an external cloud provider (OpenRouter,
 * Anthropic…), anything else is a local pool (jaccl, mlx, …). The
 * brand convention is ☁ for cloud, ⚙ for local.
 *
 * When `cluster_label` is set (OdyssAI-X >= 1.7.10), it takes
 * precedence over the raw pool id — the picker shows "Argo" /
 * "TeleCoder" instead of "main" / "telemak-code-next".
 */
function PoolBadge({
  caps,
}: {
  caps: NonNullable<ApiGlobalModel["odyssai"]>;
}) {
  if (!caps.pool && !caps.backend && !caps.cluster_label) return null;
  const isCloud = caps.backend === "http-proxy" && caps.kind !== "telemak";
  const isTelemak = caps.kind === "telemak";
  // Pastille = the runtime identity, not the cluster's arbitrary nickname.
  // Telemak nodes all read "Telemak" (the model name carries the row);
  // local/distributed pools show the operator label ("Argo"); cloud shows
  // the provider bucket. The cluster's own name (e.g. "Kolos") would just
  // duplicate noise next to the model name now on the primary line.
  const label = isTelemak
    ? "Telemak"
    : caps.cluster_label ?? caps.pool ?? (isCloud ? "cloud" : "local");
  return (
    <span
      title={
        isCloud
          ? `Cloud pool — proxied through the engine (${caps.backend})`
          : isTelemak
            ? `Telemak — single-node Swift runtime`
            : `Local pool — ${caps.backend ?? "engine-native"}`
      }
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
        isCloud
          ? "bg-slate-100 text-slate-700"
          : "bg-cyan/15 text-cyan-700"
      }`}
    >
      <span>{isCloud ? "☁" : "⚙"}</span>
      <span>{label}</span>
    </span>
  );
}

/**
 * Multi-line tooltip text shown on hover. Native `title` attribute —
 * no fancy popover, just plain text. Lines that have no value are
 * skipped so cloud models don't show "size: null" gibberish.
 */
function buildOdyssaiTooltip(
  caps: NonNullable<ApiGlobalModel["odyssai"]>,
): string {
  const lines: string[] = [];
  if (caps.alias_for) lines.push(`Alias of: ${caps.alias_for}`);
  if (caps.cluster_label) lines.push(`Cluster: ${caps.cluster_label}`);
  else if (caps.pool) lines.push(`Pool: ${caps.pool}`);
  if (caps.backend && caps.nodes) {
    lines.push(
      `Backend: ${caps.backend} · ${caps.nodes} node${caps.nodes === 1 ? "" : "s"}`,
    );
  } else if (caps.backend) {
    lines.push(`Backend: ${caps.backend}`);
  }
  if (caps.context_length) {
    lines.push(`Context: ${caps.context_length.toLocaleString()} tokens`);
  }
  if (caps.quantization) lines.push(`Quantization: ${caps.quantization}`);
  if (caps.size_bytes) lines.push(`Size: ${formatBytes(caps.size_bytes)}`);
  if (caps.estimated_tps) {
    lines.push(`Speed: ~${caps.estimated_tps.toFixed(1)} tok/s`);
  }
  if (!caps.loaded && caps.estimated_load_s) {
    lines.push(`Cold-start ETA: ~${Math.round(caps.estimated_load_s)}s`);
  }
  if (caps.kv_cache_q8) lines.push("KV cache: 8-bit");
  return lines.join("\n");
}

function ChevronIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
