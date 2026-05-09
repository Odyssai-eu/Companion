/**
 * Gemini Live API client — bidirectional voice over WebSocket.
 *
 * Flow:
 *   1. fetch session payload from /api/addons/voice-live/session
 *   2. open WSS to Google with `?key=<apiKey>`
 *   3. send setup message (model, voice, responseModalities)
 *   4. capture mic via AudioWorklet → PCM 16k mono int16 LE → base64 → WS
 *   5. on serverContent.modelTurn.parts[].inlineData.data → base64 →
 *      PCM 24k int16 → AudioBuffer → AudioContext playback queue
 *   6. on inputTranscription / outputTranscription → emit text events
 *
 * Audio reference (per the live-api spec):
 *   in:  PCM 16-bit, 16 kHz, mono, little-endian
 *   out: PCM 16-bit, 24 kHz, mono, little-endian
 *
 * v1 ships the credential plumbing + audio loop. Tool use / function
 * calling integration with TheCompAI's own tools is deferred — the
 * voice session is a separate channel from the chat tool loop for now.
 */

import { api } from "~/lib/api";

const PLAYBACK_RATE = 24000;

export type GeminiLiveState =
  | "idle"
  | "connecting"
  | "listening" // mic open, waiting / capturing user speech
  | "speaking" // assistant audio is being played back
  | "error";

export type GeminiLiveEvent =
  | { type: "state"; state: GeminiLiveState; error?: string }
  | { type: "input_text"; text: string; final: boolean }
  | { type: "output_text"; text: string; final: boolean }
  | { type: "turn_complete" };

type Listener = (e: GeminiLiveEvent) => void;

type ServerMessage = {
  setupComplete?: Record<string, unknown>;
  serverContent?: {
    modelTurn?: {
      parts?: Array<{
        text?: string;
        inlineData?: { mimeType?: string; data?: string };
      }>;
    };
    inputTranscription?: { text?: string; finished?: boolean };
    outputTranscription?: { text?: string; finished?: boolean };
    turnComplete?: boolean;
    interrupted?: boolean;
  };
};

export class GeminiLiveSession {
  private ws: WebSocket | null = null;
  private captureCtx: AudioContext | null = null;
  private playbackCtx: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private listeners = new Set<Listener>();
  private state: GeminiLiveState = "idle";
  // FIFO of scheduled playback chunks so we can stop/interrupt cleanly.
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

  /** Open mic + WebSocket + send setup message. Returns when setupComplete arrives. */
  async start(): Promise<void> {
    if (this.state !== "idle" && this.state !== "error") return;
    this.setState("connecting");
    try {
      // 1. Fetch session credentials from our backend
      const session = await api.voiceLiveSession();
      // 2. Open WS — Gemini accepts ?key=<API_KEY>
      const url = `${session.wsUrl}?key=${encodeURIComponent(session.apiKey)}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      // Wait for open
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener(
          "error",
          () => reject(new Error("websocket failed to open")),
          { once: true },
        );
      });

      // 3. Send setup message
      const sys =
        session.systemInstruction ||
        // Default in French — Sophie's primary language. The model will
        // still understand and reply in any language the user uses, but
        // the bias is set on first turn.
        "Tu es l'assistant vocal de Sophie. Réponds toujours en français, naturel et concis, sauf si l'utilisateur passe explicitement à une autre langue.";
      const setup = {
        setup: {
          model: session.model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: session.voice },
              },
              languageCode: "fr-FR",
            },
          },
          systemInstruction: { parts: [{ text: sys }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      };
      ws.send(JSON.stringify(setup));
      console.log("[gemini-live] setup sent", setup);

      // 4. Wire incoming server messages
      ws.addEventListener("message", (ev) => {
        this.handleServerMessage(ev.data);
      });
      ws.addEventListener("close", () => {
        if (this.state !== "idle") this.setState("idle");
        this.cleanup();
      });
      ws.addEventListener("error", () => {
        this.setState("error", "websocket error");
      });

      // 5. Set up audio capture
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

    // Capture context — uses native rate; the worklet downsamples to 16k.
    const captureCtx = new AudioContext();
    this.captureCtx = captureCtx;
    await captureCtx.audioWorklet.addModule(
      "/audio-worklets/pcm-recorder.js",
    );
    const source = captureCtx.createMediaStreamSource(this.mediaStream);
    const node = new AudioWorkletNode(captureCtx, "pcm-recorder");
    this.workletNode = node;
    source.connect(node);
    // We don't connect to destination — silent path. The worklet posts PCM
    // chunks via port.onmessage.
    node.port.onmessage = (e) => {
      const buf = e.data as ArrayBuffer;
      this.sendAudioChunk(buf);
    };

    // Playback context at 24 kHz so we can directly construct AudioBuffers
    // at the API's output rate without resampling. Chrome creates this in
    // a "suspended" state when the page hasn't had a recent user gesture —
    // resume() explicitly so the buffer sources actually play.
    this.playbackCtx = new AudioContext({ sampleRate: PLAYBACK_RATE });
    if (this.playbackCtx.state === "suspended") {
      try {
        await this.playbackCtx.resume();
      } catch {
        // surface as a state error; the rest of the session can still progress
        console.warn("[gemini-live] playback context could not resume");
      }
    }
    this.nextPlaybackTime = this.playbackCtx.currentTime;
  }

  private sendAudioChunk(pcm: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.muted) return;
    const b64 = arrayBufferToBase64(pcm);
    const msg = {
      realtimeInput: {
        audio: {
          mimeType: "audio/pcm;rate=16000",
          data: b64,
        },
      },
    };
    this.ws.send(JSON.stringify(msg));
  }

  private async handleServerMessage(raw: unknown): Promise<void> {
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof Blob) {
      text = await raw.text();
    } else if (raw instanceof ArrayBuffer) {
      text = new TextDecoder().decode(raw);
    } else {
      return;
    }

    let msg: ServerMessage;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    // Diagnostic — small enough to log full first turn. Strip the audio
    // payload so the console isn't flooded with megabytes of base64.
    const safe = JSON.parse(JSON.stringify(msg)) as ServerMessage;
    const parts0 = safe.serverContent?.modelTurn?.parts;
    if (parts0) {
      for (const p of parts0) {
        if (p.inlineData?.data) {
          p.inlineData.data = `[base64 ${p.inlineData.data.length} chars, mime=${p.inlineData.mimeType}]`;
        }
      }
    }
    console.log("[gemini-live] msg", safe);

    if (msg.serverContent?.interrupted) {
      this.flushPlaybackQueue();
      this.setState("listening");
    }

    const inputT = msg.serverContent?.inputTranscription;
    if (inputT?.text) {
      this.emit({
        type: "input_text",
        text: inputT.text,
        final: Boolean(inputT.finished),
      });
    }

    const outputT = msg.serverContent?.outputTranscription;
    if (outputT?.text) {
      this.emit({
        type: "output_text",
        text: outputT.text,
        final: Boolean(outputT.finished),
      });
    }

    const parts = msg.serverContent?.modelTurn?.parts ?? [];
    for (const p of parts) {
      const data = p.inlineData?.data;
      const mime = p.inlineData?.mimeType ?? "";
      // Be permissive — Gemini Live can label its PCM as "audio/pcm",
      // "audio/L16", or other audio/* variants. We only consume PCM 16-bit
      // mono LE at 24 kHz, but we accept any audio/* mime as that and let
      // the playback step decode best-effort.
      if (data && mime.startsWith("audio/")) {
        this.scheduleAudioChunk(data);
      }
    }

    if (msg.serverContent?.turnComplete) {
      this.emit({ type: "turn_complete" });
      // Once the queued audio finishes, we'll be back to listening.
      // The state transition to listening happens on `ended` of the last
      // queued source — see scheduleAudioChunk.
    }
  }

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
    const startAt = Math.max(this.nextPlaybackTime, ctx.currentTime);
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

  /** Stop everything, close the WS, release the mic. */
  async stop(): Promise<void> {
    this.cleanup();
    this.setState("idle");
  }

  private cleanup(): void {
    this.flushPlaybackQueue();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
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
