/**
 * Gemini Live session — bidirectional voice via the official @google/genai SDK.
 *
 * Why the SDK rather than hand-rolled WebSocket: the wire protocol has
 * subtle invariants (setup field shape, realtimeInput vs clientContent,
 * empty-object configs) that we kept getting wrong, breaking FR ASR.
 * The SDK encapsulates all of that — we only feed it correctly-formatted
 * 16 kHz PCM and consume the events it emits.
 *
 * Audio:
 *   in  — raw 16-bit PCM, 16 kHz, mono, little-endian, base64-encoded
 *   out — raw 16-bit PCM, 24 kHz, mono, little-endian, base64-encoded
 *
 * The capture worklet (public/audio-worklets/pcm-recorder.js) packages
 * mic samples into int16 LE chunks. The host AudioContext is created at
 * 16 kHz so the browser does the anti-aliased resample from 48 k device
 * rate — never DIY.
 */

import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from "@google/genai";
import { api } from "~/lib/api";

const PLAYBACK_RATE = 24000;

export type GeminiLiveState =
  | "idle"
  | "connecting"
  | "listening"
  | "speaking"
  | "error";

export type GeminiLiveEvent =
  | { type: "state"; state: GeminiLiveState; error?: string }
  | { type: "input_text"; text: string; final: boolean }
  | { type: "output_text"; text: string; final: boolean }
  | { type: "turn_complete" };

type Listener = (e: GeminiLiveEvent) => void;

export class GeminiLiveSession {
  private session: Session | null = null;
  private captureCtx: AudioContext | null = null;
  private playbackCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private listeners = new Set<Listener>();
  private state: GeminiLiveState = "idle";
  private playbackQueue: AudioBufferSourceNode[] = [];
  private nextPlaybackTime = 0;
  private muted = false;

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(e: GeminiLiveEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // ignore listener throw
      }
    }
  }

  private setState(state: GeminiLiveState, error?: string): void {
    this.state = state;
    this.emit({ type: "state", state, error });
  }

  getState(): GeminiLiveState {
    return this.state;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.mediaStream) {
      for (const t of this.mediaStream.getAudioTracks()) {
        t.enabled = !muted;
      }
    }
  }

  async start(opts?: { conversationId?: string | null }): Promise<void> {
    if (this.state !== "idle" && this.state !== "error") return;
    this.setState("connecting");
    try {
      const session = await api.voiceLiveSession(
        opts?.conversationId ? { conversationId: opts.conversationId } : undefined,
      );
      const sys =
        session.systemInstruction ||
        // Default in French — Sophie's primary language. Native-audio
        // models autodetect, but the system instruction biases the first
        // turn until the user has actually spoken.
        "Tu es l'assistant vocal de Sophie. Réponds toujours en français, naturel et concis, sauf si l'utilisateur passe explicitement à une autre langue.";

      const ai = new GoogleGenAI({ apiKey: session.apiKey });

      // Connect via SDK. Note the camelCase field names — the SDK maps
      // these to the underlying `setup` BidiGenerateContent message.
      const liveSession = await ai.live.connect({
        model: stripModelPrefix(session.model),
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: { parts: [{ text: sys }] },
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: session.voice },
            },
            // Output TTS language. Per the API ref, AudioTranscriptionConfig
            // itself has no fields — language for input transcription is
            // autodetected by the model.
            languageCode: "fr-FR",
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            // SDK is ready — capture starts after we've set state.
          },
          onmessage: (msg: LiveServerMessage) => {
            this.handleServerMessage(msg);
          },
          onerror: (err: ErrorEvent) => {
            this.setState("error", err.message || "live api error");
          },
          onclose: () => {
            if (this.state !== "idle") this.setState("idle");
            this.cleanup();
          },
        },
      });
      this.session = liveSession;

      await this.startCapture();
      this.setState("listening");
    } catch (err) {
      this.setState("error", (err as Error).message);
      this.cleanup();
      throw err;
    }
  }

  private async startCapture(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    // Capture context at 16 kHz — browser does proper anti-aliased
    // resampling from device rate. Linear-interp downsampling in the
    // worklet (a previous version) broke FR ASR via aliasing.
    const captureCtx = new AudioContext({ sampleRate: 16000 });
    this.captureCtx = captureCtx;
    console.log(
      "[gemini-live] capture context",
      "requested 16000, got",
      captureCtx.sampleRate,
    );
    await captureCtx.audioWorklet.addModule("/audio-worklets/pcm-recorder.js");
    const source = captureCtx.createMediaStreamSource(this.mediaStream);
    const node = new AudioWorkletNode(captureCtx, "pcm-recorder");
    this.workletNode = node;
    source.connect(node);
    // Silent path — worklet posts PCM via port.onmessage.
    let chunkLogged = false;
    node.port.onmessage = (e) => {
      const buf = e.data as ArrayBuffer;
      if (!chunkLogged) {
        // 100ms @ 16k mono int16 = 3200 bytes — sanity check.
        console.log(
          "[gemini-live] first audio chunk",
          "raw bytes",
          buf.byteLength,
        );
        chunkLogged = true;
      }
      this.sendAudioChunk(buf);
    };

    // Playback at 24 kHz native — server outputs PCM at 24k.
    this.playbackCtx = new AudioContext({ sampleRate: PLAYBACK_RATE });
    if (this.playbackCtx.state === "suspended") {
      try {
        await this.playbackCtx.resume();
      } catch {
        console.warn("[gemini-live] playback context could not resume");
      }
    }
    this.nextPlaybackTime = this.playbackCtx.currentTime;
  }

  private sendAudioChunk(pcm: ArrayBuffer): void {
    if (!this.session) return;
    if (this.muted) return;
    // Don't feed the assistant's own voice back to Gemini's VAD. Without
    // headphones, the mic picks up the speaker output, the server hears it
    // as user speech, marks the turn as interrupted, and flushes the
    // remaining audio in the middle of a sentence. We trade barge-in for
    // a flowing conversation; barge-in can come back later behind a
    // hold-to-talk gesture if needed.
    if (this.state === "speaking") return;
    const b64 = arrayBufferToBase64(pcm);
    this.session.sendRealtimeInput({
      audio: {
        data: b64,
        mimeType: "audio/pcm;rate=16000",
      },
    });
  }

  private handleServerMessage(msg: LiveServerMessage): void {
    const content = msg.serverContent;
    if (!content) return;

    if (content.interrupted) {
      this.flushPlaybackQueue();
      this.setState("listening");
    }

    // Multiple content parts can arrive in a single event — process all.
    const parts = content.modelTurn?.parts ?? [];
    for (const p of parts) {
      const data = p.inlineData?.data;
      const mime = p.inlineData?.mimeType ?? "";
      if (data && mime.startsWith("audio/")) {
        this.scheduleAudioChunk(data);
      }
    }

    const inputT = content.inputTranscription;
    if (inputT?.text) {
      this.emit({
        type: "input_text",
        text: inputT.text,
        final: Boolean(inputT.finished),
      });
    }
    const outputT = content.outputTranscription;
    if (outputT?.text) {
      this.emit({
        type: "output_text",
        text: outputT.text,
        final: Boolean(outputT.finished),
      });
    }

    if (content.turnComplete) {
      this.emit({ type: "turn_complete" });
    }
  }

  /**
   * Headroom added when we (re)start a playback chain. Without it, the
   * next chunk arriving even 5ms late re-resets to currentTime and
   * creates an audible gap. With it, network jitter up to PREBUFFER_S
   * is invisible.
   *
   * 120ms is the smallest value that consistently absorbs WS jitter on
   * residential wifi without adding noticeable latency to the response.
   */
  private static readonly PREBUFFER_S = 0.12;

  private scheduleAudioChunk(b64: string): void {
    const ctx = this.playbackCtx;
    if (!ctx) return;
    const pcm = base64ToInt16(b64);
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      float[i] = pcm[i] / 0x8000;
    }
    const buffer = ctx.createBuffer(1, float.length, PLAYBACK_RATE);
    buffer.getChannelData(0).set(float);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    // If we're still on the existing playback chain, append. Otherwise we
    // (re)start the chain with a small prebuffer so subsequent chunks
    // have time to arrive before their slot.
    let startAt: number;
    if (this.nextPlaybackTime > ctx.currentTime) {
      startAt = this.nextPlaybackTime;
    } else {
      startAt = ctx.currentTime + GeminiLiveSession.PREBUFFER_S;
    }
    src.start(startAt);
    this.nextPlaybackTime = startAt + buffer.duration;
    this.playbackQueue.push(src);
    if (this.state !== "speaking") this.setState("speaking");
    src.onended = () => {
      this.playbackQueue = this.playbackQueue.filter((s) => s !== src);
      if (this.playbackQueue.length === 0 && this.state === "speaking") {
        this.setState("listening");
      }
    };
  }

  private flushPlaybackQueue(): void {
    for (const s of this.playbackQueue) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        // already stopped
      }
    }
    this.playbackQueue = [];
    this.nextPlaybackTime = this.playbackCtx?.currentTime ?? 0;
  }

  async stop(): Promise<void> {
    this.cleanup();
    this.setState("idle");
  }

  private cleanup(): void {
    this.flushPlaybackQueue();
    if (this.session) {
      try {
        this.session.close();
      } catch {
        // ignore
      }
      this.session = null;
    }
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // ignore
      }
      this.workletNode = null;
    }
    if (this.captureCtx) {
      try {
        this.captureCtx.close();
      } catch {
        // ignore
      }
      this.captureCtx = null;
    }
    if (this.playbackCtx) {
      try {
        this.playbackCtx.close();
      } catch {
        // ignore
      }
      this.playbackCtx = null;
    }
    if (this.mediaStream) {
      for (const t of this.mediaStream.getTracks()) {
        try {
          t.stop();
        } catch {
          // ignore
        }
      }
      this.mediaStream = null;
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────

/** SDK accepts `gemini-3.1-flash-live-preview` (without "models/" prefix). */
function stripModelPrefix(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(
      ...(bytes.subarray(i, i + CHUNK) as unknown as number[]),
    );
  }
  return btoa(bin);
}

function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return new Int16Array(buf);
}
