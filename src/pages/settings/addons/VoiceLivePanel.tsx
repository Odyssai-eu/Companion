import { useEffect, useState } from "react";
import { api } from "~/lib/api";
import { Field } from "./shared";

// ── Voice panel ────────────────────────────────────────────────────────────
// Local, OpenAI-compatible audio: the chat speaks replies (/v1/audio/speech)
// and transcribes the mic (/v1/audio/transcriptions) through the configured
// endpoint. No provider choice, no auth — just point it at your audio server.

export function VoiceLivePanel() {
  type Info = Awaited<ReturnType<typeof api.voiceLiveInfo>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Local edits
  const [ttsEndpoint, setTtsEndpoint] = useState("");
  const [asrEndpoint, setAsrEndpoint] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [voice, setVoice] = useState("");

  async function refresh() {
    try {
      const r = await api.voiceLiveInfo();
      setInfo(r);
      setTtsEndpoint(r.ttsEndpoint);
      setAsrEndpoint(r.asrEndpoint);
      setTtsModel(r.ttsModel);
      setVoice(r.voice);
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
        ttsEndpoint: ttsEndpoint.trim() || undefined,
        asrEndpoint: asrEndpoint.trim() || undefined,
        ttsModel: ttsModel.trim() || undefined,
        // Send the trimmed value verbatim (even ""), so clearing the field
        // actually clears the saved voice — `|| undefined` made it un-clearable
        // (backend skips undefined).
        voice: voice.trim(),
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[12px] text-gray-600">
        <span>
          <span className="text-gray-400">TTS</span>{" "}
          <code className="font-mono text-ink">{info.ttsEndpoint || "—"}</code>
        </span>
      </div>

      <Field
        label="TTS endpoint"
        hint="Base URL of an OpenAI-compatible TTS server (calls /v1/audio/speech)."
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
        hint="Describe the voice in natural language — e.g. « Une voix féminine française, douce et posée ». The same description always gives the same voice. Leave empty for the server's default voice."
      >
        <input
          type="text"
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          placeholder="(empty = server default)"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
      </Field>

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
          One voice function for the chat — TTS out + ASR in. Forwards to an
          OpenAI-compatible /v1/audio endpoint (the chat speaks replies and
          transcribes your mic).
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
