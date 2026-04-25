/**
 * Push-to-talk voice input via the Web Speech API. Pure browser, zero server
 * cost. We use the continuous mode + interim results, then commit on stop.
 *
 * Fallback path (when SpeechRecognition is missing — e.g. Firefox): we'd call
 * /api/tts/transcribe with a recorded blob. Not implemented yet because the
 * MediaRecorder + ASR plumbing on the server side currently 500s. TODO.
 */

type Listener = (state: VoiceInputState) => void;

export type VoiceInputState =
  | { status: "idle" }
  | { status: "listening"; interim: string }
  | { status: "error"; message: string };

declare global {
  interface Window {
    SpeechRecognition?: typeof SpeechRecognition;
    webkitSpeechRecognition?: typeof SpeechRecognition;
  }
}

class VoiceInputController {
  private recognition: SpeechRecognition | null = null;
  private listeners = new Set<Listener>();
  private state: VoiceInputState = { status: "idle" };
  private finalText = "";
  private interimText = "";
  private onCommit: ((text: string) => void) | null = null;

  private get RecogClass() {
    if (typeof window === "undefined") return null;
    return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
  }

  isSupported() {
    return !!this.RecogClass;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    this.listeners.forEach((fn) => fn(this.state));
  }

  private setState(s: VoiceInputState) {
    this.state = s;
    this.notify();
  }

  start(onCommit: (text: string) => void, lang = "en-US") {
    const Recog = this.RecogClass;
    if (!Recog) {
      this.setState({
        status: "error",
        message:
          "Speech recognition isn't available in this browser. Try Chrome.",
      });
      return;
    }
    if (this.recognition) this.stop();

    this.onCommit = onCommit;
    this.finalText = "";
    this.interimText = "";

    const r = new Recog();
    r.continuous = true;
    r.interimResults = true;
    r.lang = lang;

    r.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      let appended = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) appended += transcript;
        else interim += transcript;
      }
      if (appended) this.finalText = (this.finalText + " " + appended).trim();
      this.interimText = interim;
      this.setState({
        status: "listening",
        interim: (this.finalText + " " + this.interimText).trim(),
      });
    };
    r.onerror = (e) => {
      this.setState({
        status: "error",
        message: (e as SpeechRecognitionErrorEvent).error,
      });
      this.recognition = null;
    };
    r.onend = () => {
      const text = (this.finalText + " " + this.interimText).trim();
      this.recognition = null;
      this.setState({ status: "idle" });
      if (text && this.onCommit) this.onCommit(text);
      this.onCommit = null;
    };

    this.recognition = r;
    try {
      r.start();
      this.setState({ status: "listening", interim: "" });
    } catch (e) {
      this.setState({ status: "error", message: (e as Error).message });
    }
  }

  stop() {
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // already stopped
      }
    }
  }
}

export const voiceInput = new VoiceInputController();
