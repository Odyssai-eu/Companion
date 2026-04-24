import { useState } from "react";

export default function Input() {
  const [value, setValue] = useState("");

  return (
    <div className="flex flex-col items-center gap-2 px-8 pt-4 pb-6">
      <div className="flex w-full max-w-3xl items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(10,10,10,0.04)]">
        <button
          type="button"
          aria-label="Attach"
          className="flex-shrink-0 text-gray-400 hover:text-ink"
        >
          <AttachIcon />
        </button>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Ask your cluster anything..."
          className="flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-gray-400"
        />
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-full border border-gray-200 px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-gray-50"
        >
          <MicIcon />
          Talk
        </button>
        <button
          type="button"
          aria-label="Send"
          disabled={!value.trim()}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-cyan text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <ArrowUpIcon />
        </button>
      </div>
      <p className="font-mono text-[11px] text-gray-400">
        Runs on macstudio.local:52415 · Your data stays private
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
