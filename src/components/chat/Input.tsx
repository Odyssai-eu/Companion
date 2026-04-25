import { useEffect, useState } from "react";
import { voiceInput, type VoiceInputState } from "~/lib/voice-input";

export default function Input({
  onSend,
  onCancel,
  sending,
  disabled,
  placeholder,
}: {
  onSend: (text: string) => void;
  onCancel: () => void;
  sending: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [voice, setVoice] = useState<VoiceInputState>({ status: "idle" });

  useEffect(() => {
    const unsub = voiceInput.subscribe(setVoice);
    return () => {
      unsub();
    };
  }, []);

  function startTalk() {
    if (voice.status === "listening") {
      voiceInput.stop();
      return;
    }
    voiceInput.start((text) => {
      if (text) onSend(text);
    });
  }

  const listening = voice.status === "listening";
  const interim = listening ? voice.interim : "";

  function submit() {
    if (!value.trim() || sending || disabled) return;
    onSend(value);
    setValue("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex flex-col items-center gap-2 px-8 pt-4 pb-6">
      <div className="flex w-full max-w-3xl items-end gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(10,10,10,0.04)]">
        <button
          type="button"
          aria-label="Attach"
          disabled={disabled}
          className="mb-1 flex-shrink-0 text-gray-400 hover:text-ink disabled:opacity-50"
        >
          <AttachIcon />
        </button>
        <textarea
          value={listening ? interim : value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || listening}
          rows={1}
          placeholder={
            listening
              ? "Listening… speak now, click Stop when done."
              : placeholder ?? "Ask your server anything..."
          }
          className="flex-1 resize-none bg-transparent text-[15px] leading-[22px] text-ink outline-none placeholder:text-gray-400 disabled:opacity-50"
          style={{ maxHeight: "200px" }}
        />
        <button
          type="button"
          onClick={startTalk}
          disabled={disabled || sending}
          title={listening ? "Stop listening" : "Talk (push-to-talk)"}
          className={`mb-0.5 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50 ${
            listening
              ? "border-cyan bg-[rgba(79,179,217,0.12)] text-cyan"
              : "border-gray-200 text-ink hover:bg-gray-50"
          }`}
        >
          <MicIcon />
          {listening ? "Stop" : "Talk"}
        </button>

        {sending ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Stop"
            className="mb-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-navy text-white transition-opacity hover:opacity-90"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            aria-label="Send"
            disabled={!value.trim() || disabled}
            className="mb-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-cyan text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <ArrowUpIcon />
          </button>
        )}
      </div>
      <p className="font-mono text-[11px] text-gray-400">
        Your data stays on your hardware. Press <kbd>⇧</kbd> + <kbd>⏎</kbd> for a newline.
      </p>
    </div>
  );
}

function AttachIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}
