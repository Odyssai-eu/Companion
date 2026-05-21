/**
 * Streaming TTS player. Reads HTTP chunked WAV from /api/tts/speak
 * (proxy → an OpenAI-compatible TTS endpoint, e.g. mlx-audio's
 * VibeVoice-Realtime), strips the 44-byte WAV header, parses Int16 PCM
 * samples at 24 kHz mono, and pipes them into the Web Audio API as
 * soon as enough samples are buffered.
 *
 * Why streaming rather than HTMLAudioElement + Blob:
 *   - VibeVoice TTFB is sub-millisecond — the UI can be audible before the
 *     full WAV is even half-generated.
 *   - The HTMLAudioElement path used to wait for the entire blob (~1.5s for
 *     two sentences). The streaming path starts playing within ~100ms.
 *
 * See `shared-memory/knowledge/concepts/vibevoice-realtime.md` for the full
 * upstream protocol description.
 */

type Listener = (state: TtsState) => void;

export type TtsState = {
  speakingId: string | null;
};

const SAMPLE_RATE = 24000;
const WAV_HEADER_BYTES = 44;
// Wait for this many bytes of PCM (≈ 50 ms of audio) before scheduling the
// first chunk; below that we underrun on slow networks.
const MIN_BUFFER_BYTES = SAMPLE_RATE * 2 * 0.05;

class TtsController {
  private audioContext: AudioContext | null = null;
  private currentId: string | null = null;
  private abort: AbortController | null = null;
  private nextStartTime = 0;
  private listeners = new Set<Listener>();
  private activeSources = new Set<AudioBufferSourceNode>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn({ speakingId: this.currentId });
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => fn({ speakingId: this.currentId }));
  }

  isSpeaking(id?: string) {
    return id ? this.currentId === id : this.currentId !== null;
  }

  private getCtx(): AudioContext {
    if (!this.audioContext) {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      this.audioContext = new Ctx({ sampleRate: SAMPLE_RATE });
    }
    if (this.audioContext.state === "suspended") {
      void this.audioContext.resume();
    }
    return this.audioContext;
  }

  async speak(id: string, text: string, voice?: string) {
    this.stop();
    const clean = cleanText(text);
    if (!clean) return;

    this.currentId = id;
    this.notify();
    this.abort = new AbortController();

    const ctx = this.getCtx();
    this.nextStartTime = ctx.currentTime;

    let res: Response;
    try {
      res = await fetch("/api/tts/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean, voice }),
        signal: this.abort.signal,
      });
    } catch {
      this.finish(id);
      return;
    }
    if (!res.ok || !res.body) {
      this.finish(id);
      return;
    }

    const reader = res.body.getReader();
    let pending = new Uint8Array(0);
    let headerStripped = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.currentId !== id) return; // stop()'d in the meantime

        const merged = new Uint8Array(pending.length + value.length);
        merged.set(pending);
        merged.set(value, pending.length);
        pending = merged;

        // Skip the 44-byte WAV header on the first useful chunk.
        if (!headerStripped) {
          if (pending.length < WAV_HEADER_BYTES) continue;
          pending = pending.slice(WAV_HEADER_BYTES);
          headerStripped = true;
        }

        // Need at least MIN_BUFFER_BYTES of PCM before firing the first chunk;
        // afterwards keep the threshold low so we feed gapless.
        if (pending.length < MIN_BUFFER_BYTES) continue;
        const usable = pending.length - (pending.length % 2);
        if (usable < 2) continue;

        this.scheduleChunk(pending.subarray(0, usable));
        pending = pending.slice(usable);
      }
      // Flush any tail samples
      if (pending.length >= 2) {
        const usable = pending.length - (pending.length % 2);
        this.scheduleChunk(pending.subarray(0, usable));
      }
    } catch {
      // aborted
    } finally {
      // Finish when the last scheduled buffer ends — gives the UI time to show
      // the speaking state for the actual audio duration.
      const remaining = Math.max(0, this.nextStartTime - ctx.currentTime);
      window.setTimeout(() => this.finish(id), remaining * 1000);
    }
  }

  private scheduleChunk(bytes: Uint8Array) {
    const ctx = this.getCtx();

    // Copy to a fresh ArrayBuffer so we can safely cast to Int16Array
    // (the source may be a subarray of a larger buffer).
    const copy = new ArrayBuffer(bytes.length);
    new Uint8Array(copy).set(bytes);
    const pcm16 = new Int16Array(copy);

    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

    const audioBuf = ctx.createBuffer(1, float32.length, SAMPLE_RATE);
    audioBuf.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = audioBuf;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime, this.nextStartTime);
    source.start(startAt);
    this.nextStartTime = startAt + audioBuf.duration;

    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
  }

  private finish(id: string) {
    if (this.currentId !== id) return;
    this.currentId = null;
    this.abort = null;
    this.notify();
  }

  stop() {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    this.activeSources.clear();
    this.currentId = null;
    this.notify();
  }

  /**
   * Save a fully-rendered WAV to disk (download). Uses a non-streaming fetch so
   * the file has a complete WAV header + size headers when the browser opens
   * the Save dialog.
   */
  async save(text: string, filename: string, voice?: string) {
    const clean = cleanText(text);
    if (!clean) return;
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: clean, voice, format: "wav" }),
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}

export const tts = new TtsController();

function cleanText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```[\s\S]*?```/g, " code block omitted ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\|[^\n]+\|/g, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .trim();
}
