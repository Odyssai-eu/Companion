import { Hono } from "hono";

const ttsRoute = new Hono();

/**
 * Minimal TTS proxy. The user's Voxtral (or any OpenAI-compatible
 * /v1/audio/speech endpoint) is set via env `TTS_BASE_URL` — defaults to
 * http://192.168.86.42:8890 (Voxtral MLX on ultra-96b). Client POSTs text,
 * we forward and stream the WAV back.
 */

const TTS_BASE_URL =
  process.env.TTS_BASE_URL ?? "http://192.168.86.42:8890";

ttsRoute.get("/voices", async (c) => {
  // Voxtral / Kokoro both expose /v1/audio/voices
  try {
    const res = await fetch(`${TTS_BASE_URL}/v1/audio/voices`);
    if (!res.ok) return c.json({ voices: [] });
    const body = (await res.json()) as { voices?: { id?: string }[] };
    const voices = (body.voices ?? [])
      .map((v) => v.id)
      .filter((id): id is string => !!id);
    return c.json({ voices });
  } catch {
    return c.json({ voices: [] });
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
    model = "voxtral",
  } = body as {
    text?: string;
    voice?: string;
    format?: "wav" | "mp3";
    model?: string;
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
        input: text.slice(0, 6000),
        voice: voice ?? "default",
        model,
        response_format: format,
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

export default ttsRoute;
