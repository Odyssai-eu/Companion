import { useEffect, useState } from "react";
import {
  api,
  type ApiGlobalModel,
  type ApiInferenceMode,
  type ApiInferenceSettings,
  type ApiNamedModels,
} from "~/lib/api";
import { JoinOdyssaiModal } from "~/components/settings/JoinOdyssai";

const COMMON_TIMEZONES = [
  "Europe/Brussels",
  "Europe/Tallinn",
  "Europe/Paris",
  "Europe/London",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "UTC",
];

export default function InferencePage() {
  const [settings, setSettings] = useState<ApiInferenceSettings | null>(null);
  const [models, setModels] = useState<ApiGlobalModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Local edits
  const [litellmUrl, setLitellmUrl] = useState("");
  const [litellmDisabled, setLitellmDisabled] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const [debugVerbose, setDebugVerbose] = useState(false);
  const [defaultModel, setDefaultModel] = useState("");
  const [timezone, setTimezone] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);
  const [inferenceMode, setInferenceMode] =
    useState<ApiInferenceMode>("expert");
  const [easyModel, setEasyModel] = useState("");
  const [namedModels, setNamedModels] = useState<ApiNamedModels>({});

  // Join the Odyssai flow
  const [joinOpen, setJoinOpen] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [manualBusy, setManualBusy] = useState(false);

  async function reload() {
    const [s, ms] = await Promise.all([
      api.inferenceSettings(),
      api.listAllModels().catch(() => ({ models: [] })),
    ]);
    setSettings(s);
    setModels(ms.models);
    setLitellmUrl(s.litellmUrl ?? "");
    setLitellmDisabled(s.litellmDisabled);
    setShowMetrics(s.showMetrics);
    setDebugVerbose(s.debugVerbose);
    setDefaultModel(s.defaultModel ?? "");
    setTimezone(s.timezone);
    setInferenceMode(s.inferenceMode);
    setEasyModel(s.easyModel ?? "");
    setNamedModels(s.namedModels ?? {});
  }

  useEffect(() => {
    reload().catch((e) => setError((e as Error).message));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const patch: Parameters<typeof api.updateInferenceSettings>[0] = {
        litellmUrl: litellmUrl.trim() || null,
        litellmDisabled,
        showMetrics,
        debugVerbose,
        defaultModel: defaultModel.trim() || null,
        timezone,
        inferenceMode,
        easyModel: easyModel.trim() || null,
        namedModels: Object.values(namedModels).some((v) => v && v.length > 0)
          ? namedModels
          : null,
      };
      if (keyDirty) patch.litellmApiKey = apiKey.trim() || null;
      await api.updateInferenceSettings(patch);
      setSaved("Saved");
      setKeyDirty(false);
      setApiKey("");
      await reload();
      setTimeout(() => setSaved(null), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function refreshModels() {
    setBusy(true);
    try {
      const { models } = await api.listAllModels();
      setModels(models);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (
      !confirm(
        "Disconnect from Odysseus? Local models stop being available until you re-pair.",
      )
    )
      return;
    setBusy(true);
    try {
      await api.disconnectOdyssai();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reloadProvider() {
    setBusy(true);
    try {
      await api.reloadOdyssai();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function manualJoin() {
    const url = manualUrl.trim();
    if (!url) return;
    setManualBusy(true);
    setError(null);
    try {
      // Parse host:port out of the URL — the join endpoint takes them
      // discretely so the UX matches the scan path (which yields
      // {host, port}). Anything that fails URL parsing → 400 by zod.
      const parsed = new URL(url);
      const host = parsed.hostname;
      const port = parsed.port ? Number(parsed.port) : 8000;
      await api.joinOdyssai({ host, port });
      setManualUrl("");
      setManualToken("");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setManualBusy(false);
    }
  }

  if (!settings) {
    return (
      <div className="font-mono text-[12px] text-gray-400">Loading…</div>
    );
  }

  const paired = !!settings.engineUrl;
  const engineMeta = settings.engineMeta ?? {};

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Inference
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Inference.
        </h1>
        <p className="max-w-[640px] text-[15px] leading-[24px] text-gray-600">
          Companion talks to your models through a provider — either an
          Odysseus engine paired with "Join the Odyssai" (recommended), or a
          LiteLLM proxy (legacy / power users). Pick what you want, or
          combine both.
        </p>
      </header>

      {/* ── Provider: Odyssai gateway / pair ────────────────────────── */}
      <Section title="Provider">
        {paired ? (
          <PairedCard
            url={settings.engineUrl ?? ""}
            mode={settings.engineMode}
            meta={engineMeta}
            onReload={reloadProvider}
            onDisconnect={disconnect}
            busy={busy}
          />
        ) : (
          <NotPaired onJoin={() => setJoinOpen(true)} />
        )}
        <details className="flex flex-col gap-2 text-[12px] text-gray-500">
          <summary className="cursor-pointer text-[12px] text-gray-600 hover:text-ink">
            Manual engine URL (fallback)
          </summary>
          <p>
            If the LAN scan didn't find your engine (unusual subnet, port, or
            Cloudflare-tunnelled), enter the URL directly. Auth is handled
            via the engine's discovery gate just like a scan-based join.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="url"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
              placeholder="http://192.168.86.141:8000"
              className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
            <button
              type="button"
              onClick={manualJoin}
              disabled={manualBusy || !manualUrl.trim() || paired}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {manualBusy ? "Joining…" : "Join via URL"}
            </button>
          </div>
          {manualToken /* reserved for future admin-token flow */ && null}
        </details>
      </Section>

      {/* ── LiteLLM (optional rail) ─────────────────────────────────── */}
      <Section title="LiteLLM (optional)">
        <p className="text-[13px] text-gray-600">
          A standalone LiteLLM proxy stays useful for cascade fallback,
          budget tracking, or the Anthropic protocol bridge. In gateway
          mode (recommended) Odysseus already proxies cloud providers, so
          you can turn LiteLLM off and run the simpler chain.
        </p>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-[13px] hover:bg-gray-50">
          <input
            type="checkbox"
            checked={litellmDisabled}
            onChange={(e) => setLitellmDisabled(e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-ink">
              Disable LiteLLM
            </span>
            <span className="text-[12px] text-gray-500">
              When checked, Companion never calls LiteLLM. Requires a paired
              Odysseus engine — otherwise chat has no rail at all.
            </span>
          </div>
        </label>
        {!litellmDisabled && (
          <>
            <Field label="Proxy URL" hint={`Default: ${settings.envDefaultUrl}`}>
              <input
                type="url"
                value={litellmUrl}
                onChange={(e) => setLitellmUrl(e.target.value)}
                placeholder={settings.envDefaultUrl}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-cyan"
              />
            </Field>
            <Field
              label="API key (optional)"
              hint={
                settings.hasApiKey
                  ? "A key is set. Leave blank to keep it; clear to remove; type a new one to replace."
                  : "Only needed if your LiteLLM proxy enforces an API key."
              }
            >
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeyDirty(true);
                }}
                placeholder={settings.hasApiKey ? "•••• (set)" : "sk-…"}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-cyan"
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={
                  (litellmUrl || settings.envDefaultUrl).replace(/\/+$/, "") +
                  "/ui"
                }
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50 hover:text-ink"
              >
                Open LiteLLM admin UI ↗
              </a>
            </div>
          </>
        )}
      </Section>

      {/* ── Inference mode ──────────────────────────────────────────── */}
      <Section title="Inference mode">
        <p className="text-[13px] text-gray-600">
          How models are exposed in the chat picker. Pick what fits the user
          you're configuring.
        </p>
        <div className="flex flex-col gap-2">
          {(
            [
              {
                v: "easy" as const,
                title: "Easy — one model, no picker",
                desc: "User never sees a model picker. The single model below is used everywhere.",
              },
              {
                v: "advanced" as const,
                title: "Advanced — 4 named slots",
                desc: "User picks among Conversation / Analyse / Engineer / Expert. Each maps to a model alias you set below.",
              },
              {
                v: "expert" as const,
                title: "Expert — full list available",
                desc: "User picks any model in the provider's catalog. Power-user mode.",
              },
            ]
          ).map((opt) => (
            <label
              key={opt.v}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 text-[13px] transition-colors ${
                inferenceMode === opt.v
                  ? "border-cyan bg-[rgba(79,179,217,0.06)]"
                  : "border-gray-200 bg-white hover:bg-gray-50"
              }`}
            >
              <input
                type="radio"
                name="inferenceMode"
                value={opt.v}
                checked={inferenceMode === opt.v}
                onChange={() => setInferenceMode(opt.v)}
                className="mt-1"
              />
              <div className="flex flex-col gap-0.5">
                <span className="font-medium text-ink">{opt.title}</span>
                <span className="text-[12px] text-gray-500">{opt.desc}</span>
              </div>
            </label>
          ))}
        </div>

        {inferenceMode === "easy" && (
          <Field
            label="Easy mode model"
            hint="The single model the user sees as 'the assistant'."
          >
            <select
              value={easyModel}
              onChange={(e) => setEasyModel(e.target.value)}
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-cyan"
            >
              <option value="">(pick a model)</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        {inferenceMode === "advanced" && (
          <div className="flex flex-col gap-3">
            {(
              [
                ["conversation", "Conversation", "Casual chat, fast turns."],
                ["analyse", "Analyse", "Reading, summarising, comparing."],
                ["engineer", "Engineer", "Code, debugging, refactor."],
                ["expert", "Expert", "Heavy reasoning, deep dives."],
              ] as const
            ).map(([key, title, desc]) => (
              <Field key={key} label={title} hint={desc}>
                <select
                  value={namedModels[key] ?? ""}
                  onChange={(e) =>
                    setNamedModels((prev) => ({
                      ...prev,
                      [key]: e.target.value || undefined,
                    }))
                  }
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-cyan"
                >
                  <option value="">(pick a model)</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
          </div>
        )}
      </Section>

      <Section title="Default model">
        <p className="text-[13px] text-gray-600">
          The model that pre-fills the picker on a fresh chat in Expert mode.
          Ignored in Easy and Advanced modes (those have their own slots).
        </p>
        <select
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-cyan"
        >
          <option value="">(none — pick first available)</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-3">
          <p className="font-mono text-[11px] text-gray-400">
            {models.length} model{models.length === 1 ? "" : "s"} available.
          </p>
          <button
            type="button"
            onClick={refreshModels}
            disabled={busy}
            className="rounded-md border border-gray-200 bg-white px-2 py-1 text-[11px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            Refresh
          </button>
        </div>
      </Section>

      <Section title="Display">
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-[13px] hover:bg-gray-50">
          <input
            type="checkbox"
            checked={showMetrics}
            onChange={(e) => setShowMetrics(e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-ink">Show metrics</span>
            <span className="text-[12px] text-gray-500">
              Render the per-message stats box (TTFT, duration, prompt /
              completion tokens, tok/s) under each assistant reply. Off by
              default to keep the conversation visually clean.
            </span>
          </div>
        </label>
      </Section>

      <Section title="Debug">
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-gray-200 bg-white px-4 py-3 text-[13px] hover:bg-gray-50">
          <input
            type="checkbox"
            checked={debugVerbose}
            onChange={(e) => setDebugVerbose(e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-ink">Verbose request logging</span>
            <span className="text-[12px] text-gray-500">
              Log the exact upstream request body (tagged{" "}
              <code className="rounded bg-gray-100 px-1 text-[11px]">
                [chat:upstream]
              </code>
              ) before every <code>POST /v1/chat/completions</code>. Useful for
              diagnosing tool-call shape issues, model id resolution, or
              streaming weirdness. Off by default — produces a lot of output
              in <code>docker logs</code>.
            </span>
          </div>
        </label>
      </Section>

      <Section title="Timezone">
        <p className="text-[13px] text-gray-600">
          Used to format the date stamps Companion injects into every chat
          ({"["}YYYY-MM-DDTHH:MM:SS+ZZ:ZZ | Δ: …{"]"}) so the model knows what
          time it is in your world.
        </p>
        <select
          value={timezone}
          onChange={(e) => setTimezone(e.target.value)}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-cyan"
        >
          {COMMON_TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
          {!COMMON_TIMEZONES.includes(timezone) && (
            <option value={timezone}>{timezone}</option>
          )}
        </select>
      </Section>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 font-mono text-[12px] text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-lg bg-navy px-5 py-2 text-[14px] font-medium text-white hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {saved && (
          <span className="font-mono text-[12px] text-emerald-600">
            ✓ {saved}
          </span>
        )}
      </div>

      {joinOpen && (
        <JoinOdyssaiModal
          onClose={() => setJoinOpen(false)}
          onDone={() => {
            reload().catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}

function NotPaired({ onJoin }: { onJoin: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-gray-200 bg-white p-5">
      <span className="text-[13px] text-gray-600">
        No Odysseus engine paired. Click below — Companion scans your network
        for engines whose operator has opened the discovery gate.
      </span>
      <button
        type="button"
        onClick={onJoin}
        className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95"
      >
        Join the Odyssai
      </button>
    </div>
  );
}

function PairedCard({
  url,
  mode,
  meta,
  onReload,
  onDisconnect,
  busy,
}: {
  url: string;
  mode: "gateway" | "hybrid" | "legacy";
  meta: Record<string, unknown>;
  onReload: () => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const name = (meta.name as string) ?? "Odysseus";
  const version = (meta.version as string) ?? "?";
  const vendor = (meta.vendor as string) ?? "?";
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium text-ink">
            {name} @ {host}
          </span>
          <span className="font-mono text-[11px] text-gray-500">
            vendor {vendor} · v{version} · mode {mode}
          </span>
        </div>
        <span
          className={`rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
            mode === "gateway"
              ? "bg-emerald-100 text-emerald-800"
              : mode === "hybrid"
                ? "bg-amber-100 text-amber-800"
                : "bg-gray-100 text-gray-600"
          }`}
        >
          {mode}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onReload}
          disabled={busy}
          className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          Reload config
        </button>
        <button
          type="button"
          onClick={onDisconnect}
          disabled={busy}
          className="rounded-md border border-rose-200 bg-white px-3 py-1.5 text-[12px] text-rose-700 hover:bg-rose-50 disabled:opacity-50"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-display text-[22px] font-light text-navy">{title}</h2>
      {children}
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
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] tracking-[0.04em] text-gray-500 uppercase">
        {label}
      </span>
      {children}
      {hint && (
        <span className="font-mono text-[11px] text-gray-400">{hint}</span>
      )}
    </div>
  );
}
