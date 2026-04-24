/**
 * Lightweight TTS player. Fetches audio from our /api/tts/speak proxy
 * (Voxtral on ultra-96b) and plays it via HTMLAudioElement. Supports
 * play/stop and a subscriber list so buttons can reflect the speaking state.
 */

type Listener = (speaking: string | null) => void;

class TtsController {
  private audio: HTMLAudioElement | null = null;
  private current: string | null = null;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => fn(this.current));
  }

  isSpeaking(id?: string) {
    return id ? this.current === id : this.current !== null;
  }

  async speak(id: string, text: string, voice?: string) {
    this.stop();
    const clean = cleanText(text);
    if (!clean) return;

    let res: Response;
    try {
      res = await fetch("/api/tts/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean, voice }),
      });
    } catch {
      return;
    }
    if (!res.ok) return;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (this.current === id) {
        this.current = null;
        this.audio = null;
        this.notify();
      }
    };
    audio.onerror = audio.onended;
    this.audio = audio;
    this.current = id;
    this.notify();
    await audio.play().catch(() => {
      this.stop();
    });
  }

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

  stop() {
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    this.current = null;
    this.notify();
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
