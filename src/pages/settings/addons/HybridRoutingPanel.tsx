import { useEffect, useMemo, useState } from "react";
import { api, type ApiGlobalModel } from "~/lib/api";
import ModelDropdown from "~/components/chat/ModelDropdown";
import { Field } from "./shared";

// ── Hybrid Routing panel (#40, scope A) ─────────────────────────────────────
// A Local/Hybrid toggle. In Hybrid mode the user picks ONE cloud model;
// auto-routed chat (model="auto") then goes to that cloud model instead of the
// local Auto Router. Local mode = current behaviour, unchanged.

/**
 * Is this a cloud model? Mirrors ModelDropdown's PoolBadge isCloud logic:
 * the engine proxies an external provider when backend === "http-proxy", but
 * Telemak nodes also use that backend while being local — so exclude them.
 * For non-odyssai aliases (no capability block) fall back to an id heuristic
 * (OpenRouter `or:` prefix, or the common cloud-family prefixes).
 */
function isCloudModel(m: ApiGlobalModel): boolean {
  const o = m.odyssai;
  if (o?.backend === "http-proxy" && o.kind !== "telemak") return true;
  if (!o) {
    const id = m.id.toLowerCase();
    return (
      id.startsWith("or:") ||
      id.startsWith("gpt-") ||
      id.startsWith("claude-") ||
      id.startsWith("gemini-")
    );
  }
  return false;
}

export function HybridRoutingPanel() {
  type Info = Awaited<ReturnType<typeof api.hybridRoutingInfo>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [models, setModels] = useState<ApiGlobalModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Local edits
  const [mode, setMode] = useState<"local" | "hybrid">("local");
  const [cloudModel, setCloudModel] = useState("");

  async function refresh() {
    try {
      const r = await api.hybridRoutingInfo();
      setInfo(r);
      setMode(r.mode);
      setCloudModel(r.cloudModel);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function refreshModels() {
    try {
      const r = await api.listAllModels();
      // Cloud models only; never the synthetic "auto" entry.
      setModels(r.models.filter((m) => m.id !== "auto" && isCloudModel(m)));
    } catch {
      // Non-fatal — the picker renders empty with the standard hint.
    }
  }

  useEffect(() => {
    refresh();
    refreshModels();
  }, []);

  const cloudModels = useMemo(() => models, [models]);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.hybridRoutingUpdateConfig({
        mode,
        cloudModel: cloudModel.trim(),
      });
      setSaved(true);
      await refresh();
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return <span className="font-mono text-[11px] text-gray-400">Loading…</span>;
  }

  return (
    <div className="flex flex-col gap-5">
      <Field
        label="Mode"
        hint="Local keeps auto-routing on the cluster. Hybrid sends auto-routed chat to one cloud model instead. Explicit model picks are always respected."
      >
        <div className="flex gap-2">
          {(["local", "hybrid"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md border px-4 py-2 text-[13px] font-medium transition-colors ${
                mode === m
                  ? "border-navy bg-navy text-white"
                  : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 hover:text-ink"
              }`}
            >
              {m === "local" ? "Local" : "Hybrid"}
            </button>
          ))}
        </div>
      </Field>

      {mode === "hybrid" && (
        <Field
          label="Cloud model"
          hint="Auto-routed chat goes here. Cloud models only (proxied through the engine)."
        >
          <ModelDropdown
            value={cloudModel}
            onChange={(id) => setCloudModel(id)}
            models={cloudModels}
            includeAuto={false}
            fullWidth
            placeholder="Pick a cloud model"
          />
        </Field>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "Saving…" : saved ? "✓ Saved" : "Save"}
        </button>
      </div>

      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How Hybrid Routing works
        </summary>
        <p className="mt-3 leading-relaxed">
          Hybrid Routing only intervenes when you send a message with the
          model set to <code className="font-mono text-ink">Auto</code>. In{" "}
          <strong>Hybrid</strong> mode that auto-routed traffic goes to the
          cloud model you pick here, instead of the local Auto Router. If you
          explicitly choose a specific model in the chat, that choice is always
          respected — Hybrid never overrides it. <strong>Local</strong> mode
          leaves everything on the cluster (the current behaviour).
        </p>
      </details>

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
          {err}
        </div>
      )}
    </div>
  );
}
