import { useEffect, useState } from "react";
import { api } from "~/lib/api";
import { Field } from "./shared";

// ── Voice (Gemini Live) panel ─────────────────────────────────────────────

/** Full Gemini Live prebuilt voice catalog, paired with the official
 *  one-word style descriptor Google publishes alongside each name.
 *  Reproduced verbatim so the picker labels match the docs. */
const VOICES: Array<{ name: string; tone: string }> = [
  { name: "Zephyr", tone: "Bright" },
  { name: "Puck", tone: "Upbeat" },
  { name: "Charon", tone: "Informative" },
  { name: "Kore", tone: "Firm" },
  { name: "Fenrir", tone: "Excitable" },
  { name: "Leda", tone: "Youthful" },
  { name: "Orus", tone: "Firm" },
  { name: "Aoede", tone: "Breezy" },
  { name: "Callirrhoe", tone: "Easy-going" },
  { name: "Autonoe", tone: "Bright" },
  { name: "Enceladus", tone: "Breathy" },
  { name: "Iapetus", tone: "Clear" },
  { name: "Umbriel", tone: "Easy-going" },
  { name: "Algieba", tone: "Smooth" },
  { name: "Despina", tone: "Smooth" },
  { name: "Erinome", tone: "Clear" },
  { name: "Algenib", tone: "Gravelly" },
  { name: "Rasalgethi", tone: "Informative" },
  { name: "Laomedeia", tone: "Upbeat" },
  { name: "Achernar", tone: "Soft" },
  { name: "Alnilam", tone: "Firm" },
  { name: "Schedar", tone: "Even" },
  { name: "Gacrux", tone: "Mature" },
  { name: "Pulcherrima", tone: "Forward" },
  { name: "Achird", tone: "Friendly" },
  { name: "Zubenelgenubi", tone: "Casual" },
  { name: "Vindemiatrix", tone: "Gentle" },
  { name: "Sadachbia", tone: "Lively" },
  { name: "Sadaltager", tone: "Knowledgeable" },
  { name: "Sulafat", tone: "Warm" },
];

const PRESET_MALE = "Orus";
const PRESET_FEMALE = "Aoede";

/**
 * Three-way voice picker: Male preset (Orus), Female preset (Aoede), or
 * Custom with a dropdown of every Gemini Live voice. The mode is derived
 * from the saved value rather than stored separately — single source of
 * truth stays the `voice` string the backend sends to the Live API.
 */
function VoicePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const trimmed = value.trim();
  const mode: "male" | "female" | "custom" =
    trimmed === PRESET_MALE
      ? "male"
      : trimmed === PRESET_FEMALE
        ? "female"
        : "custom";

  function pick(next: "male" | "female" | "custom") {
    if (next === "male") onChange(PRESET_MALE);
    else if (next === "female") onChange(PRESET_FEMALE);
    else if (mode !== "custom") {
      // Switching to Custom — seed with the first non-preset voice if the
      // current value is one of the presets, so the dropdown isn't blank.
      const seed =
        VOICES.find((v) => v.name !== PRESET_MALE && v.name !== PRESET_FEMALE)
          ?.name ?? "Charon";
      onChange(seed);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <ModeButton
          active={mode === "male"}
          label="Male"
          sub={PRESET_MALE}
          onClick={() => pick("male")}
        />
        <ModeButton
          active={mode === "female"}
          label="Female"
          sub={PRESET_FEMALE}
          onClick={() => pick("female")}
        />
        <ModeButton
          active={mode === "custom"}
          label="Custom"
          sub={mode === "custom" ? trimmed || "—" : "Pick from list"}
          onClick={() => pick("custom")}
        />
      </div>
      {mode === "custom" && (
        <select
          value={trimmed}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        >
          {VOICES.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name} — {v.tone}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function ModeButton({
  active,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors ${
        active
          ? "border-cyan bg-[rgba(79,179,217,0.08)] text-ink"
          : "border-gray-200 bg-white text-ink hover:bg-gray-50"
      }`}
    >
      <span className="text-[13px] font-medium">{label}</span>
      <span className="font-mono text-[11px] text-gray-500">{sub}</span>
    </button>
  );
}

export function VoiceLivePanel() {
  type Info = Awaited<ReturnType<typeof api.voiceLiveInfo>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Local edits
  const [provider, setProvider] = useState<"local" | "gemini" | "mistral">(
    "local",
  );
  const [ttsEndpoint, setTtsEndpoint] = useState("");
  const [asrEndpoint, setAsrEndpoint] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [systemInstruction, setSystemInstruction] = useState("");
  const [showKey, setShowKey] = useState(false);

  async function refresh() {
    try {
      const r = await api.voiceLiveInfo();
      setInfo(r);
      setProvider(r.provider);
      setTtsEndpoint(r.ttsEndpoint);
      setAsrEndpoint(r.asrEndpoint);
      setTtsModel(r.ttsModel);
      setModel(r.model);
      setVoice(r.voice);
      setSystemInstruction(r.systemInstruction);
      setApiKey("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.voiceLiveUpdateConfig({
        provider,
        ttsEndpoint: ttsEndpoint.trim() || undefined,
        asrEndpoint: asrEndpoint.trim() || undefined,
        ttsModel: ttsModel.trim() || undefined,
        model: model.trim() || undefined,
        voice: voice.trim() || undefined,
        systemInstruction,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
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

  async function clearKey() {
    if (!confirm("Remove the Gemini API key? Voice mode will stop working.")) return;
    setBusy(true);
    try {
      await api.voiceLiveUpdateConfig({ apiKey: null });
      await refresh();
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[12px] text-gray-600">
        <span>
          <span className="text-gray-400">Provider</span>{" "}
          <code className="font-mono text-ink">{info.provider}</code>
        </span>
        {info.provider !== "gemini" && (
          <span>
            <span className="text-gray-400">TTS</span>{" "}
            <code className="font-mono text-ink">{info.ttsEndpoint || "—"}</code>
          </span>
        )}
        {info.provider !== "local" && (
          <span className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${info.hasApiKey ? "bg-emerald-500" : "bg-rose-500"}`}
            />
            <span className="font-mono text-ink">
              {info.hasApiKey ? "key set" : "no key"}
            </span>
          </span>
        )}
      </div>

      <Field
        label="Provider"
        hint="Where chat voice (TTS out + ASR in) is handled. local/mistral forward to an OpenAI-compatible /v1/audio endpoint; gemini is full-duplex Live over WebSocket."
      >
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-ink outline-none focus:border-cyan"
        >
          <option value="local">Local (OpenAI-compatible audio)</option>
          <option value="mistral">Mistral (Voxtral)</option>
          <option value="gemini">Gemini Live (full-duplex)</option>
        </select>
      </Field>

      {provider !== "gemini" && (
        <>
          <Field
            label="TTS endpoint"
            hint="Base URL of an OpenAI-compatible TTS server (calls /v1/audio/speech). For Voxtral, your Mistral-compatible base URL."
          >
            <input
              type="text"
              value={ttsEndpoint}
              onChange={(e) => setTtsEndpoint(e.target.value)}
              placeholder="http://192.168.1.50:8003"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
          <Field
            label="ASR endpoint"
            hint="Base URL for /v1/audio/transcriptions. Leave blank to reuse the TTS endpoint."
          >
            <input
              type="text"
              value={asrEndpoint}
              onChange={(e) => setAsrEndpoint(e.target.value)}
              placeholder="(same as TTS endpoint)"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
          <Field label="TTS model" hint="Model id the TTS server should use.">
            <input
              type="text"
              value={ttsModel}
              onChange={(e) => setTtsModel(e.target.value)}
              placeholder="mlx-community/VibeVoice-Realtime-0.5B-8bit"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
          <Field
            label="Voice"
            hint="Voice id your TTS server understands (e.g. en-Emma_woman, fr-Spk1_woman for VibeVoice)."
          >
            <input
              type="text"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              placeholder="en-Emma_woman"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
        </>
      )}

      {provider !== "local" && (
        <Field
          label="API key"
          hint={
            provider === "gemini"
              ? "Gemini API key (https://aistudio.google.com/apikey). Stored server-side; minted into a session payload at voice start."
              : "Bearer key for the Voxtral / Mistral endpoint. Stored server-side."
          }
        >
          <div className="flex items-center gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                info.hasApiKey
                  ? "•••• (set — paste a new one to replace)"
                  : provider === "gemini"
                    ? "AIza…"
                    : "key…"
              }
              className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600 hover:text-ink"
            >
              {showKey ? "Hide" : "Show"}
            </button>
            {info.hasApiKey && (
              <button
                type="button"
                onClick={clearKey}
                disabled={busy}
                className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600 hover:text-ink"
              >
                Revoke
              </button>
            )}
          </div>
        </Field>
      )}

      {provider === "gemini" && (
        <>
          <Field
            label="Model"
            hint="Gemini Live model id. Default: models/gemini-3.1-flash-live-preview (newest, best multilingual ASR)."
          >
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="models/gemini-3.1-flash-live-preview"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
          <Field label="Voice" hint="Pick a quick preset or browse the full list.">
            <VoicePicker value={voice} onChange={setVoice} />
          </Field>
          <Field
            label="System instruction"
            hint="Optional — shapes the assistant's persona for voice sessions."
          >
            <textarea
              value={systemInstruction}
              onChange={(e) => setSystemInstruction(e.target.value)}
              rows={3}
              className="w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
        </>
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
          How Voice works
        </summary>
        <p className="mt-3 leading-relaxed">
          One voice function for the chat — TTS out + ASR in.{" "}
          <b>local</b> and <b>mistral</b> forward to an OpenAI-compatible
          /v1/audio endpoint (the chat speaks replies and transcribes your mic).{" "}
          <b>gemini</b> opens a full-duplex Live WebSocket from the browser (PCM
          16 kHz in / 24 kHz out); the server only mints session credentials.
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
