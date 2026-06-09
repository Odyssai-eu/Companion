import { Hono } from "hono";
import { resolveVoiceConfig } from "./addon-voice-live";

type Env = { Variables: { userId: string } };
const ttsRoute = new Hono<Env>();

/**
 * Minimal TTS proxy. The TTS endpoint (any OpenAI-compatible
 * /v1/audio/speech server) is set via env `TTS_BASE_URL`. Recommended
 * targets: mlx-audio (Blaizzy/mlx-audio) hosting VibeVoice-Realtime,
 * or any other OpenAI-compat TTS. Client POSTs text, we forward and
 * stream the WAV back.
 *
 * VibeVoice-Realtime is HTTP chunked-transfer streaming (no WebSocket
 * needed), TTFB sub-millisecond, audio gen ~6× realtime. The Voxtral
 * 4B-TTS model works as a French fallback (better French quality) —
 * clients can request it explicitly via `model:` in the body.
 */
// Bootstrap fallback only — the live endpoint/model/voice now come from the
// per-user Voice addon config (resolveVoiceConfig). See #26.
const TTS_BASE_URL = process.env.TTS_BASE_URL ?? "";

const VIBEVOICE_VOICES = [
  // English
  { id: "en-Emma_woman", lang: "en", gender: "f" },
  { id: "en-Grace_woman", lang: "en", gender: "f" },
  { id: "en-Carter_man", lang: "en", gender: "m" },
  { id: "en-Davis_man", lang: "en", gender: "m" },
  { id: "en-Frank_man", lang: "en", gender: "m" },
  { id: "en-Mike_man", lang: "en", gender: "m" },
  // French
  { id: "fr-Spk1_woman", lang: "fr", gender: "f" },
  { id: "fr-Spk0_man", lang: "fr", gender: "m" },
  // German
  { id: "de-Spk1_woman", lang: "de", gender: "f" },
  { id: "de-Spk0_man", lang: "de", gender: "m" },
  // Italian
  { id: "it-Spk0_woman", lang: "it", gender: "f" },
  { id: "it-Spk1_man", lang: "it", gender: "m" },
  // Spanish
  { id: "sp-Spk0_woman", lang: "sp", gender: "f" },
  { id: "sp-Spk1_man", lang: "sp", gender: "m" },
  // Portuguese
  { id: "pt-Spk0_woman", lang: "pt", gender: "f" },
  { id: "pt-Spk1_man", lang: "pt", gender: "m" },
  // Dutch
  { id: "nl-Spk1_woman", lang: "nl", gender: "f" },
  { id: "nl-Spk0_man", lang: "nl", gender: "m" },
  // Polish
  { id: "pl-Spk1_woman", lang: "pl", gender: "f" },
  { id: "pl-Spk0_man", lang: "pl", gender: "m" },
  // Japanese
  { id: "jp-Spk1_woman", lang: "jp", gender: "f" },
  { id: "jp-Spk0_man", lang: "jp", gender: "m" },
  // Korean
  { id: "kr-Spk0_woman", lang: "kr", gender: "f" },
  { id: "kr-Spk1_man", lang: "kr", gender: "m" },
  // Indian
  { id: "in-Samuel_man", lang: "in", gender: "m" },
];

ttsRoute.get("/voices", async (c) => {
  const vc = await resolveVoiceConfig(c.get("userId"));
  return c.json({
    model: vc.ttsModel,
    defaultVoice: vc.voice,
    voices: VIBEVOICE_VOICES,
  });
});

/**
 * Cheap healthcheck — returns whether the upstream is reachable and whether
 * VibeVoice-Realtime is among the loadable models. UI can use this to show a
 * green/grey dot and flip to a TTS-disabled state when the service is down.
 */
ttsRoute.get("/health", async (c) => {
  const vc = await resolveVoiceConfig(c.get("userId"));
  const base = vc.ttsEndpoint || TTS_BASE_URL;
  try {
    const res = await fetch(`${base}/v1/models`, {
      signal: AbortSignal.timeout(2000),
      ...(vc.apiKey ? { headers: { Authorization: `Bearer ${vc.apiKey}` } } : {}),
    });
    if (!res.ok) return c.json({ ok: false, reason: `upstream_${res.status}` });
    const data = (await res.json()) as { data?: { id?: string }[] };
    const hasVibeVoice = (data.data ?? []).some((m) =>
      m.id?.includes("VibeVoice-Realtime"),
    );
    return c.json({
      ok: true,
      upstream: base,
      defaultModel: vc.ttsModel,
      vibeVoiceLoaded: hasVibeVoice,
    });
  } catch (e) {
    return c.json({ ok: false, reason: "unreachable", detail: String(e) });
  }
});

ttsRoute.post("/speak", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_json" }, 400);
  }
  const {
    text,
    voice,
    format = "wav",
    model,
    speed,
  } = body as {
    text?: string;
    voice?: string;
    format?: "wav" | "mp3";
    model?: string;
    speed?: number;
  };
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return c.json({ error: "missing_text" }, 400);
  }

  // #26 — endpoint/model/voice come from the user's Voice addon config (env is
  // only the bootstrap default), so Voxtral / any OpenAI-compat server can be
  // wired from Settings instead of being frozen on TTS_BASE_URL.
  const vc = await resolveVoiceConfig(c.get("userId"));
  const base = vc.ttsEndpoint || TTS_BASE_URL;
  if (!base) return c.json({ error: "tts_not_configured" }, 400);
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(vc.apiKey ? { Authorization: `Bearer ${vc.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: model ?? vc.ttsModel,
        voice: voice ?? vc.voice,
        input: text.slice(0, 6000),
        response_format: format,
        stream: true,
        ...(speed !== undefined ? { speed } : {}),
      }),
    });
  } catch (err) {
    return c.json(
      { error: "tts_unreachable", detail: String(err) },
      502,
    );
  }

  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text().catch(() => "");
    return c.json(
      { error: "tts_error", status: upstream.status, body: body.slice(0, 200) },
      upstream.status as 400 | 500 | 502,
    );
  }

  c.header(
    "Content-Type",
    upstream.headers.get("content-type") ??
      (format === "mp3" ? "audio/mpeg" : "audio/wav"),
  );
  c.header("Cache-Control", "no-cache");
  return c.body(upstream.body);
});

/**
 * ASR proxy. Forwards a multipart upload to mlx-audio's /v1/audio/transcriptions.
 * The default model is VibeVoice-ASR; the upstream sometimes errors with
 * "no Stream(gpu, 1) in current thread" — we surface the upstream status as-is.
 */
ttsRoute.post("/transcribe", async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "invalid_form" }, 400);
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "missing_file" }, 400);
  const model =
    (form.get("model") as string | null) ??
    "mlx-community/VibeVoice-ASR-bf16";

  const upstreamForm = new FormData();
  upstreamForm.append("model", model);
  upstreamForm.append("file", file);
  if (form.get("language")) {
    upstreamForm.append("language", form.get("language") as string);
  }

  const vc = await resolveVoiceConfig(c.get("userId"));
  const base = vc.asrEndpoint || TTS_BASE_URL;
  if (!base) return c.json({ error: "asr_not_configured" }, 400);
  let upstream: Response;
  try {
    upstream = await fetch(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      headers: vc.apiKey ? { Authorization: `Bearer ${vc.apiKey}` } : undefined,
      body: upstreamForm,
    });
  } catch (err) {
    return c.json({ error: "asr_unreachable", detail: String(err) }, 502);
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    return c.json(
      { error: "asr_error", status: upstream.status, body: body.slice(0, 300) },
      upstream.status as 400 | 500 | 502,
    );
  }

  const text = await upstream.text();
  // mlx-audio returns plain text; OpenAI returns { text }
  try {
    const parsed = JSON.parse(text) as { text?: string };
    if (parsed?.text) return c.json({ text: parsed.text });
  } catch {
    // not JSON, fall through
  }
  return c.json({ text });
});

export default ttsRoute;
