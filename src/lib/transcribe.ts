/**
 * Thin client for OUR local ASR endpoint (/api/tts/transcribe → odyssai-voice
 * AVFoundation). Shared by the Talk big mic and the Space-bar shortcut so the
 * WAV→text plumbing lives in one place. Posts a `audio/wav` blob, returns the
 * trimmed transcript (or throws with a user-facing message).
 *
 * Replaces the Google Web Speech API path (voice-input.ts) for these two
 * surfaces — capture is OUR WavRecorder, transcription is OUR server.
 */
export async function transcribeWav(
  blob: Blob,
  language = "fr",
): Promise<string> {
  // Header-only (44-byte RIFF) → nothing was captured.
  if (blob.size <= 44) return "";

  let res: Response;
  try {
    res = await fetch(
      `/api/tts/transcribe?language=${encodeURIComponent(language)}`,
      {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        body: blob,
      },
    );
  } catch {
    throw new Error("Could not reach the transcription service.");
  }

  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      detail.error
        ? `Transcription failed (${detail.error}).`
        : `Transcription failed (${res.status}).`,
    );
  }

  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}
