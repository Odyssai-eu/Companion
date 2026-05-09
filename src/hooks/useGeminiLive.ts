/**
 * useGeminiLive — React wrapper around the Gemini Live session.
 *
 * State machine: idle → connecting → listening ↔ speaking; error from
 * any state. start() opens the mic + WS; stop() releases everything.
 *
 * The hook exposes the latest live transcripts (input from user, output
 * from assistant). Both are "buffered" on partial frames and committed
 * on `final: true`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { GeminiLiveSession, type GeminiLiveState } from "~/lib/gemini-live";

export type GeminiLiveTranscript = {
  /** What the user is currently saying (may be partial). */
  inputText: string;
  /** Last finalised user utterance — useful for echo into the conversation. */
  lastInputFinal: string;
  /** What the assistant is currently saying (may be partial). */
  outputText: string;
  lastOutputFinal: string;
};

export function useGeminiLive() {
  const sessionRef = useRef<GeminiLiveSession | null>(null);
  const [state, setState] = useState<GeminiLiveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [transcript, setTranscript] = useState<GeminiLiveTranscript>({
    inputText: "",
    lastInputFinal: "",
    outputText: "",
    lastOutputFinal: "",
  });

  // Per-turn accumulators: when we get a final, we reset the partial.
  const inPartialRef = useRef("");
  const outPartialRef = useRef("");

  useEffect(() => {
    return () => {
      if (sessionRef.current) {
        sessionRef.current.stop().catch(() => undefined);
        sessionRef.current = null;
      }
    };
  }, []);

  const start = useCallback(async (opts?: { conversationId?: string | null }) => {
    if (sessionRef.current) return;
    const s = new GeminiLiveSession();
    sessionRef.current = s;
    setError(null);
    inPartialRef.current = "";
    outPartialRef.current = "";

    s.on((e) => {
      if (e.type === "state") {
        setState(e.state);
        if (e.error) setError(e.error);
      } else if (e.type === "input_text") {
        if (e.final) {
          const finalText = (inPartialRef.current + e.text).trim();
          inPartialRef.current = "";
          setTranscript((prev) => ({
            ...prev,
            inputText: "",
            lastInputFinal: finalText,
          }));
        } else {
          inPartialRef.current += e.text;
          setTranscript((prev) => ({ ...prev, inputText: inPartialRef.current }));
        }
      } else if (e.type === "output_text") {
        if (e.final) {
          const finalText = (outPartialRef.current + e.text).trim();
          outPartialRef.current = "";
          setTranscript((prev) => ({
            ...prev,
            outputText: "",
            lastOutputFinal: finalText,
          }));
        } else {
          outPartialRef.current += e.text;
          setTranscript((prev) => ({ ...prev, outputText: outPartialRef.current }));
        }
      } else if (e.type === "turn_complete") {
        // Commit any leftover partials as final.
        if (inPartialRef.current) {
          const text = inPartialRef.current.trim();
          inPartialRef.current = "";
          setTranscript((prev) => ({
            ...prev,
            inputText: "",
            lastInputFinal: text || prev.lastInputFinal,
          }));
        }
        if (outPartialRef.current) {
          const text = outPartialRef.current.trim();
          outPartialRef.current = "";
          setTranscript((prev) => ({
            ...prev,
            outputText: "",
            lastOutputFinal: text || prev.lastOutputFinal,
          }));
        }
      }
    });

    try {
      await s.start(opts);
    } catch (err) {
      setError((err as Error).message);
      sessionRef.current = null;
    }
  }, []);

  const stop = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    sessionRef.current = null;
    await s.stop().catch(() => undefined);
    setMutedState(false);
  }, []);

  const setMuted = useCallback((m: boolean) => {
    sessionRef.current?.setMuted(m);
    setMutedState(m);
  }, []);

  return {
    state,
    error,
    muted,
    transcript,
    start,
    stop,
    setMuted,
    isActive: state !== "idle" && state !== "error",
  };
}
