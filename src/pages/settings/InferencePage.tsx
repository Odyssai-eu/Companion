import { useEffect, useState } from "react";
import { api, type ApiGlobalModel, type ApiInferenceSettings } from "~/lib/api";

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

  useEffect(() => {
    Promise.all([api.inferenceSettings(), api.listAllModels().catch(() => ({ models: [] }))])
      .then(([s, ms]) => {
        setSettings(s);
        setModels(ms.models);
        setLitellmUrl(s.litellmUrl ?? "");
        setDefaultModel(s.defaultModel ?? "");
        setTimezone(s.timezone);
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
      };
      if (keyDirty) patch.litellmApiKey = apiKey.trim() || null;
      await api.updateInferenceSettings(patch);
      setSaved("Saved");
      setKeyDirty(false);
      setApiKey("");
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
          Thecomp.ai talks to your models through a single LiteLLM proxy. Point
          it at your home cluster, your team's shared instance, or a hosted
          one. The admin curates the model list (locals, cloud providers,
          fallbacks) by editing the proxy's config — Thecomp.ai just shows you
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

      <Section title="Default model">
        <p className="text-[13px] text-gray-600">
          The model that pre-fills the picker on a fresh chat. You can still
          switch per conversation from the composer.
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
          Used to format the date stamps Thecomp.ai injects into every chat
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
