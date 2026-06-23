/**
 * Minimal WAV recorder for push-to-talk ASR.
 *
 * Why not MediaRecorder? Our ASR server (odyssai-voice, AVFoundation under the
 * hood) does NOT decode MediaRecorder's webm/opus container. So we capture raw
 * Float32 PCM via the Web Audio API and encode a real RIFF/WAV blob ourselves
 * (mono, 16-bit) at the AudioContext's native sample rate. The server resamples
 * to 16 kHz internally, so we only need to write the correct `sampleRate` into
 * the header — no client-side resampling required.
 *
 * ScriptProcessorNode is deprecated in favour of AudioWorklet, but it needs no
 * separate worklet module (which would complicate the Vite build + asset
 * serving on a plain-HTTP LAN deploy) and is perfectly adequate for short
 * hold-to-talk captures. Kept deliberately simple.
 */

export class WavRecorder {
  private audioContext: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 48000;
  private recording = false;

  /** True while a capture is active. */
  get isRecording() {
    return this.recording;
  }

  /**
   * Request the mic and begin capturing PCM. Throws on permission denial or
   * missing API so the caller can surface a friendly message. Safe to call
   * after a previous stop()/cancel().
   */
  async start(): Promise<void> {
    if (this.recording) return;
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      throw new Error("Microphone capture is not available in this browser.");
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = (e as { name?: string }).name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new Error(
          "Microphone access denied. Allow it in your browser to talk.",
        );
      }
      if (name === "NotFoundError") {
        throw new Error("No microphone found.");
      }
      throw new Error("Could not start the microphone.");
    }

    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // best effort — capture still works in most browsers
      }
    }

    const source = ctx.createMediaStreamSource(stream);
    // Buffer size 4096 ≈ 85 ms at 48 kHz — low overhead, well below any
    // perceptible latency for a hold-to-talk capture.
    const processor = ctx.createScriptProcessor(4096, 1, 1);

    this.chunks = [];
    this.sampleRate = ctx.sampleRate;

    processor.onaudioprocess = (ev: AudioProcessingEvent) => {
      if (!this.recording) return;
      const input = ev.inputBuffer.getChannelData(0);
      // Copy — the underlying buffer is reused by the audio thread.
      this.chunks.push(new Float32Array(input));
    };

    source.connect(processor);
    // ScriptProcessor only fires onaudioprocess while connected to a
    // destination. A zero-gain node would be cleaner, but connecting straight
    // to destination is fine: we capture the mic, which the browser doesn't
    // loop back, so there's no echo.
    processor.connect(ctx.destination);

    this.audioContext = ctx;
    this.stream = stream;
    this.source = source;
    this.processor = processor;
    this.recording = true;
  }

  /**
   * Stop capturing and return the recorded audio as a `audio/wav` Blob (mono,
   * 16-bit PCM, native sample rate). Releases the mic. Returns an empty WAV if
   * nothing was captured (caller should treat a tiny blob as "no speech").
   */
  async stop(): Promise<Blob> {
    if (!this.recording) {
      return encodeWav(new Float32Array(0), this.sampleRate);
    }
    this.recording = false;

    const sampleRate = this.sampleRate;
    const samples = flatten(this.chunks);
    this.teardown();
    return encodeWav(samples, sampleRate);
  }

  /** Abort the capture without producing a blob, releasing the mic. */
  cancel(): void {
    this.recording = false;
    this.chunks = [];
    this.teardown();
  }

  private teardown() {
    try {
      this.processor?.disconnect();
    } catch {
      /* noop */
    }
    try {
      this.source?.disconnect();
    } catch {
      /* noop */
    }
    if (this.processor) this.processor.onaudioprocess = null;
    for (const track of this.stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        /* noop */
      }
    }
    // Closing the context frees the audio hardware; ignore the returned promise.
    if (this.audioContext && this.audioContext.state !== "closed") {
      void this.audioContext.close().catch(() => undefined);
    }
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.audioContext = null;
    this.chunks = [];
  }
}

/** Concatenate the captured Float32 chunks into one contiguous buffer. */
function flatten(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Encode mono Float32 PCM as a 16-bit PCM WAV blob with a correct 44-byte RIFF
 * header (sizes computed from the sample count).
 */
function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true); // ChunkSize
  writeAscii(view, 8, "WAVE");
  // "fmt " sub-chunk
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // Subchunk1Size (PCM)
  view.setUint16(20, 1, true); // AudioFormat = PCM
  view.setUint16(22, 1, true); // NumChannels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true); // BitsPerSample
  // "data" sub-chunk
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // PCM samples: clamp float [-1,1] → int16.
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}
