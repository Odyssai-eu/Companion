/**
 * PCM recorder worklet — captures microphone audio, downsamples from the
 * AudioContext's native sample rate to 16 kHz mono, converts float32
 * samples to little-endian int16 PCM, and posts ArrayBuffer chunks back
 * to the main thread.
 *
 * Used by src/lib/gemini-live.ts for the Gemini Live API.
 *
 * Loaded via:
 *   await audioContext.audioWorklet.addModule('/audio-worklets/pcm-recorder.js');
 *   const node = new AudioWorkletNode(audioContext, 'pcm-recorder');
 *   node.port.onmessage = (e) => sendAudioToServer(e.data);
 */

const TARGET_RATE = 16000;
const CHUNK_MS = 100; // post one buffer ~10×/sec

class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputRate = sampleRate; // global var inside worklet — context rate
    this.ratio = this.inputRate / TARGET_RATE;
    // Buffer of float32 samples already downsampled to 16k. We post
    // every CHUNK_MS worth of samples.
    this.buffer = new Float32Array(0);
    this.chunkSamples = Math.floor((TARGET_RATE * CHUNK_MS) / 1000);
  }

  /**
   * Lightweight linear-interpolation downsampler. inputs[0][0] is the
   * first channel of the first input (we only consume mono). Returns the
   * resulting float32 chunk.
   */
  downsample(input) {
    const outLen = Math.floor(input.length / this.ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcIdx = i * this.ratio;
      const lo = Math.floor(srcIdx);
      const hi = Math.min(lo + 1, input.length - 1);
      const frac = srcIdx - lo;
      out[i] = input[lo] * (1 - frac) + input[hi] * frac;
    }
    return out;
  }

  /** Append `add` to `this.buffer` and return the new buffer. */
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
    const ds = this.downsample(input);
    this.buffer = this.appendToBuffer(ds);
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
