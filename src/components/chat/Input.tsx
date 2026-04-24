import { useState } from "react";

export default function Input({
  onSend,
  sending,
  disabled,
  placeholder,
}: {
  onSend: (text: string) => void;
  sending: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");

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
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={placeholder ?? "Ask your cluster anything..."}
          className="flex-1 resize-none bg-transparent text-[15px] leading-[22px] text-ink outline-none placeholder:text-gray-400 disabled:opacity-50"
          style={{ maxHeight: "200px" }}
        />
        <button
          type="button"
          className="mb-0.5 flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-gray-50 disabled:opacity-50"
          disabled={disabled}
        >
          <MicIcon />
          Talk
        </button>
        <button
          type="button"
          onClick={submit}
          aria-label="Send"
          disabled={!value.trim() || sending || disabled}
          className="mb-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-cyan text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {sending ? <SpinnerIcon /> : <ArrowUpIcon />}
        </button>
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

function SpinnerIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.22-8.56" />
    </svg>
  );
}
