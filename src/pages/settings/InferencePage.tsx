import { useEffect, useState } from "react";
import {
  api,
  type ApiGlobalModel,
  type ApiInferenceMode,
  type ApiInferenceSettings,
  type ApiNamedModels,
} from "~/lib/api";

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
  const [defaultModel, setDefaultModel] = useState("");
  const [timezone, setTimezone] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);
  const [inferenceMode, setInferenceMode] =
    useState<ApiInferenceMode>("expert");
  const [easyModel, setEasyModel] = useState("");
  const [namedModels, setNamedModels] = useState<ApiNamedModels>({});
  // Odyssai engine — capability contract source. Distinct from LiteLLM.
  const [engineUrl, setEngineUrl] = useState("");
  const [engineToken, setEngineToken] = useState("");
  const [engineTokenDirty, setEngineTokenDirty] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<
    Awaited<ReturnType<typeof api.probeInferenceEngine>> | null
  >(null);

  useEffect(() => {
    Promise.all([api.inferenceSettings(), api.listAllModels().catch(() => ({ models: [] }))])
      .then(([s, ms]) => {
        setSettings(s);
        setModels(ms.models);
        setLitellmUrl(s.litellmUrl ?? "");
        setDefaultModel(s.defaultModel ?? "");
        setTimezone(s.timezone);
        setInferenceMode(s.inferenceMode);
        setEasyModel(s.easyModel ?? "");
        setNamedModels(s.namedModels ?? {});
        setEngineUrl(s.engineUrl ?? "");
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const patch: Parameters<typeof api.updateInferenceSettings>[0] = {
        litellmUrl: litellmUrl.trim() || null,
        defaultModel: defaultModel.trim() || null,
        timezone,
        inferenceMode,
        easyModel: easyModel.trim() || null,
        namedModels: Object.values(namedModels).some((v) => v && v.length > 0)
          ? namedModels
          : null,
        engineUrl: engineUrl.trim() || null,
      };
      if (keyDirty) patch.litellmApiKey = apiKey.trim() || null;
      if (engineTokenDirty)
        patch.engineToken = engineToken.trim() || null;
      await api.updateInferenceSettings(patch);
      setSaved("Saved");
      setKeyDirty(false);
      setApiKey("");
      setEngineTokenDirty(false);
      setEngineToken("");
      const fresh = await api.inferenceSettings();
      setSettings(fresh);
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

  async function runProbe() {
    const url = engineUrl.trim();
    if (!url) return;
    setProbing(true);
    setProbeResult(null);
    try {
      const r = await api.probeInferenceEngine({
        url,
        token: engineTokenDirty ? engineToken.trim() || undefined : undefined,
      });
      setProbeResult(r);
    } catch (e) {
      setProbeResult({
        reachable: false,
        isOdyssai: false,
        authRequired: false,
        authProvided: false,
        modelsReachable: false,
        error: (e as Error).message,
      });
    } finally {
      setProbing(false);
    }
  }

  if (!settings) {
    return (
      <div className="font-mono text-[12px] text-gray-400">Loading…</div>
    );
  }

  const litellmAdminUrl =
    (litellmUrl || settings.envDefaultUrl).replace(/\/+$/, "") + "/ui";

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
          Companion talks to your models through a single LiteLLM proxy. Point
          it at your home cluster, your team's shared instance, or a hosted
          one. The admin curates the model list (locals, cloud providers,
          fallbacks) by editing the proxy's config — Companion just shows you
          what it offers.
        </p>
      </header>

      <Section title="LiteLLM connection">
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
            href={litellmAdminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50 hover:text-ink"
          >
            Open LiteLLM admin UI ↗
          </a>
          <button
            type="button"
            onClick={refreshModels}
            disabled={busy}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50 hover:text-ink disabled:opacity-50"
          >
            Refresh model list
          </button>
        </div>
      </Section>

      <Section title="Engine capabilities (optional)">
        <p className="text-[13px] text-gray-600">
          Direct URL to an Odyssai-compatible engine (e.g. Odysseus). When
          set, Companion polls the engine's capability contract instead of
          guessing per-model features (vision, tools, context length, loaded
          state). Inference still routes through LiteLLM above — this is
          purely for accurate capability info.
        </p>
        <Field label="Engine URL" hint="Empty disables the contract; we fall back to heuristics.">
          <input
            type="url"
            value={engineUrl}
            onChange={(e) => setEngineUrl(e.target.value)}
            placeholder="http://192.168.86.141:8000"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
          />
        </Field>
        <Field
          label="Admin token (optional)"
          hint="Only needed for /admin/* on the engine. Public /v1/* and the contract itself don't require auth."
        >
          <input
            type="password"
            value={engineTokenDirty ? engineToken : settings.hasEngineToken ? "•••••••• (saved)" : ""}
            onChange={(e) => {
              setEngineToken(e.target.value);
              setEngineTokenDirty(true);
            }}
            placeholder={settings.hasEngineToken ? "•••••••• (saved)" : "Bearer token"}
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={runProbe}
            disabled={probing || !engineUrl.trim()}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {probing ? "Probing…" : "Test"}
          </button>
          {probeResult && <ProbeBadge result={probeResult} />}
        </div>
        {settings.engineMeta && !probeResult && (
          <p className="font-mono text-[11px] text-gray-500">
            Saved engine:{" "}
            <strong>{String(settings.engineMeta.name ?? "—")}</strong>{" "}
            v{String(settings.engineMeta.version ?? "—")} · vendor{" "}
            {String(settings.engineMeta.vendor ?? "—")}
          </p>
        )}
      </Section>

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
                desc: "User picks among Conversation / Analyse / Engineer / Expert. Each maps to a LiteLLM alias you set below.",
              },
              {
                v: "expert" as const,
                title: "Expert — full LiteLLM list",
                desc: "User picks any model from the LiteLLM catalog. Power-user mode.",
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
        <p className="font-mono text-[11px] text-gray-400">
          {models.length} model{models.length === 1 ? "" : "s"} exposed by your
          LiteLLM proxy.
        </p>
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

/**
 * Renders the probe result as a single badge line. Three states:
 *   ✓ Odyssai detected — green, when vendor matches
 *   ⓘ Reachable, generic OpenAI-compat — cyan, /v1/models works but no contract
 *   ⨯ Unreachable — red, neither endpoint answered
 */
function ProbeBadge({
  result,
}: {
  result: NonNullable<
    Awaited<ReturnType<typeof api.probeInferenceEngine>>
  >;
}) {
  if (!result.reachable) {
    return (
      <span className="rounded-md bg-rose-100 px-2 py-1 font-mono text-[11px] text-rose-700">
        ⨯ Unreachable
        {result.error && <span className="ml-2 opacity-70">— {result.error}</span>}
      </span>
    );
  }
  if (result.isOdyssai) {
    return (
      <span className="rounded-md bg-emerald-100 px-2 py-1 font-mono text-[11px] text-emerald-800">
        ✓ Odyssai detected
        {result.meta?.version && (
          <span className="ml-2 opacity-80">v{result.meta.version}</span>
        )}
        {typeof result.modelsCount === "number" && (
          <span className="ml-2 opacity-80">· {result.modelsCount} models</span>
        )}
        {result.authRequired && !result.authProvided && (
          <span className="ml-2 text-amber-700">
            · admin token required for /admin/*
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="rounded-md bg-cyan/15 px-2 py-1 font-mono text-[11px] text-cyan">
      ⓘ Generic OpenAI-compatible endpoint
      {typeof result.modelsCount === "number" && (
        <span className="ml-2 opacity-80">· {result.modelsCount} models</span>
      )}
    </span>
  );
}
