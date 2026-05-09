/**
 * PCM recorder worklet — packages microphone float32 samples into 16-bit
 * little-endian PCM ArrayBuffers and posts them to the main thread.
 *
 * NO manual resampling. The host creates the AudioContext at 16 kHz, and
 * the browser handles resampling from the device rate (typically 48 kHz)
 * with a proper anti-aliasing low-pass filter. Earlier versions did naive
 * linear-interpolation downsampling here, which folded high frequencies
 * back into the audible band and made non-English ASR fail catastrophically
 * (Gemini Live transcribed "ceci est du français" as "it is sushi fancy").
 *
 * Used by src/lib/gemini-live.ts for the Gemini Live API.
 */

const CHUNK_MS = 100; // post one buffer ~10×/sec

class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate is a worklet global — equals the host AudioContext rate.
    // We expect the host to create the context at 16 kHz; we don't enforce
    // it here, just package whatever rate we get.
    this.chunkSamples = Math.floor((sampleRate * CHUNK_MS) / 1000);
    this.buffer = new Float32Array(0);
  }

  appendToBuffer(add) {
    const merged = new Float32Array(this.buffer.length + add.length);
    merged.set(this.buffer, 0);
    merged.set(add, this.buffer.length);
    return merged;
  }

  /** Convert float32 [-1, 1] samples to int16 little-endian ArrayBuffer. */
  floatToInt16LE(floats) {
    const buf = new ArrayBuffer(floats.length * 2);
    const view = new DataView(buf);
    for (let i = 0; i < floats.length; i++) {
      let s = Math.max(-1, Math.min(1, floats[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      view.setInt16(i * 2, s, true); // little-endian
    }
    return buf;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;
    this.buffer = this.appendToBuffer(input);
    while (this.buffer.length >= this.chunkSamples) {
      const chunk = this.buffer.slice(0, this.chunkSamples);
      this.buffer = this.buffer.slice(this.chunkSamples);
      const pcm = this.floatToInt16LE(chunk);
      this.port.postMessage(pcm, [pcm]);
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PcmRecorder);
