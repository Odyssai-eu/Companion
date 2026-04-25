import { Hono } from "hono";

const ttsRoute = new Hono();

/**
 * Minimal TTS proxy. The user's Voxtral (or any OpenAI-compatible
 * /v1/audio/speech endpoint) is set via env `TTS_BASE_URL` — defaults to
 * http://192.168.86.42:8890 (Voxtral MLX on ultra-96b). Client POSTs text,
 * we forward and stream the WAV back.
 */

/**
 * TTS proxy. Targets the mlx-audio server (Blaizzy/mlx-audio) running on
 * ultra-96b:8892. Default model is Qwen3-TTS-12Hz-1.7B-CustomVoice; default
 * voice is `vivian`. The server speaks OpenAI-compat /v1/audio/speech with
 * a `stream: true` flag we always pass through for low latency.
 */
const TTS_BASE_URL =
  process.env.TTS_BASE_URL ?? "http://192.168.86.42:8892";
const TTS_DEFAULT_MODEL =
  process.env.TTS_DEFAULT_MODEL ??
  "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16";
const TTS_DEFAULT_VOICE = process.env.TTS_DEFAULT_VOICE ?? "vivian";

ttsRoute.get("/voices", async (_c) => {
  // mlx-audio doesn't expose a generic voices list; return what Qwen3-TTS
  // CustomVoice supports (the most-deployed model in our setup).
  return _c.json({
    model: TTS_DEFAULT_MODEL,
    voices: [
      "vivian",
      "serena",
      "uncle_fu",
      "ryan",
      "aiden",
      "ono_anna",
      "sohee",
      "eric",
      "dylan",
    ],
  });
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

  let upstream: Response;
  try {
    upstream = await fetch(`${TTS_BASE_URL}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model ?? TTS_DEFAULT_MODEL,
        voice: voice ?? TTS_DEFAULT_VOICE,
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

  let upstream: Response;
  try {
    upstream = await fetch(`${TTS_BASE_URL}/v1/audio/transcriptions`, {
      method: "POST",
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
