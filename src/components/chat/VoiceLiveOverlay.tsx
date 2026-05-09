import { useEffect } from "react";
import { useGeminiLive } from "~/hooks/useGeminiLive";

/**
 * Full-bleed overlay for the Gemini Live voice mode. Auto-starts the
 * session on mount, releases everything on unmount. Shows the live
 * transcripts (user + assistant) and a single Stop button. Mute toggle
 * available while listening.
 *
 * Caller is responsible for guarding against the addon being disabled —
 * if /api/addons/voice-live/session 4xx's, we surface the error here.
 */
export default function VoiceLiveOverlay({
  onClose,
}: {
  onClose: () => void;
}) {
  const live = useGeminiLive();

  // Auto-start on mount.
  useEffect(() => {
    live.start();
    return () => {
      live.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-navy/95 text-white">
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
        <div className="flex items-center gap-3">
          <StateBadge state={live.state} />
          <div className="flex flex-col gap-0.5">
            <span className="font-sans text-[12px] tracking-[0.08em] uppercase opacity-70">
              Voice live
            </span>
            <span className="font-display text-[18px] font-light">
              Gemini Flash
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => live.setMuted(!live.muted)}
            className="rounded-md border border-white/30 bg-white/5 px-3 py-1.5 text-[13px] hover:bg-white/10"
          >
            {live.muted ? "Unmute" : "Mute"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-white px-4 py-1.5 text-[13px] font-medium text-navy hover:opacity-95"
          >
            Stop
          </button>
        </div>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-12 px-8">
        <Pulse state={live.state} />

        <div className="flex w-full max-w-[720px] flex-col gap-6">
          <Bubble
            label="You"
            text={live.transcript.inputText || live.transcript.lastInputFinal}
            partial={Boolean(live.transcript.inputText)}
          />
          <Bubble
            label="Assistant"
            text={
              live.transcript.outputText || live.transcript.lastOutputFinal
            }
            partial={Boolean(live.transcript.outputText)}
            highlight
          />
        </div>

        {live.error && (
          <div className="rounded-md border border-rose-300 bg-rose-500/20 px-4 py-3 font-mono text-[12px]">
            {live.error}
          </div>
        )}
      </div>

      <div className="border-t border-white/10 px-6 py-3 text-center text-[11px] opacity-60">
        Esc to stop · Audio routes directly to Google Gemini Live API
      </div>
    </div>
  );
}

function StateBadge({ state }: { state: ReturnType<typeof useGeminiLive>["state"] }) {
  const map: Record<typeof state, { label: string; cls: string; pulse: boolean }> = {
    idle: { label: "idle", cls: "bg-white/20", pulse: false },
    connecting: { label: "connecting", cls: "bg-amber-400 text-navy", pulse: true },
    listening: { label: "listening", cls: "bg-cyan text-navy", pulse: true },
    speaking: { label: "speaking", cls: "bg-emerald-400 text-navy", pulse: true },
    error: { label: "error", cls: "bg-rose-500", pulse: false },
  };
  const s = map[state];
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${s.cls}`}
    >
      {s.pulse && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      )}
      {s.label}
    </span>
  );
}

function Pulse({ state }: { state: ReturnType<typeof useGeminiLive>["state"] }) {
  const active = state === "listening" || state === "speaking";
  return (
    <div className="relative flex h-32 w-32 items-center justify-center">
      <span
        className={`absolute h-32 w-32 rounded-full ${
          active ? "animate-ping bg-cyan/30" : "bg-white/10"
        }`}
      />
      <span
        className={`absolute h-20 w-20 rounded-full ${
          state === "speaking"
            ? "bg-emerald-400/60"
            : state === "listening"
              ? "bg-cyan/60"
              : "bg-white/20"
        }`}
      />
      <span className="relative h-10 w-10 rounded-full bg-white" />
    </div>
  );
}

function Bubble({
  label,
  text,
  partial,
  highlight,
}: {
  label: string;
  text: string;
  partial: boolean;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] tracking-[0.08em] uppercase opacity-60">
        {label}
        {partial && <span className="ml-2 italic">…</span>}
      </span>
      <p
        className={`min-h-[28px] text-[16px] leading-[24px] ${
          highlight ? "font-medium" : ""
        } ${text ? "" : "opacity-30"}`}
      >
        {text || "(silence)"}
      </p>
    </div>
  );
}
