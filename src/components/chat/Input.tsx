import { useEffect, useRef, useState } from "react";
import {
  ACCEPT_ATTR,
  type Attachment,
  formatBytes,
  processFile,
} from "~/lib/file-attach";
import { voiceInput, type VoiceInputState } from "~/lib/voice-input";

export default function Input({
  onSend,
  onCancel,
  sending,
  disabled,
  placeholder,
}: {
  onSend: (text: string, attachments: Attachment[]) => void;
  onCancel: () => void;
  sending: boolean;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [voice, setVoice] = useState<VoiceInputState>({ status: "idle" });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      if (text) onSend(text, []);
    });
  }

  const listening = voice.status === "listening";
  const interim = listening ? voice.interim : "";

  function submit() {
    const ready = attachments.every((a) => a.kind !== "pdf" || !a.processing);
    if (!ready || sending || disabled) return;
    if (!value.trim() && attachments.length === 0) return;
    onSend(value, attachments);
    setValue("");
    setAttachments([]);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  async function onFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow same file to be re-selected later
    await ingestFiles(files);
  }

  async function ingestFiles(files: File[]) {
    if (files.length === 0) return;

    for (const file of files) {
      const isPdf =
        file.type === "application/pdf" ||
        file.name.toLowerCase().endsWith(".pdf");
      const placeholder: Attachment | null = isPdf
        ? {
            kind: "pdf",
            id: `pdf-pending-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 8)}`,
            name: file.name,
            size: file.size,
            processing: true,
            progress: "0/?",
          }
        : null;
      if (placeholder) {
        setAttachments((prev) => [...prev, placeholder]);
      }
      try {
        const att = await processFile(file, (_id, processed, total) => {
          setAttachments((prev) =>
            prev.map((a) =>
              a.kind === "pdf" && a.id === placeholder?.id
                ? { ...a, progress: `${processed}/${total}` }
                : a,
            ),
          );
        });
        if (placeholder) {
          // Replace pending placeholder
          setAttachments((prev) =>
            prev.map((a) => (a.id === placeholder.id ? att : a)),
          );
        } else {
          setAttachments((prev) => [...prev, att]);
        }
      } catch (err) {
        console.warn("file_attach_failed", err);
        if (placeholder) {
          setAttachments((prev) => prev.filter((a) => a.id !== placeholder.id));
        }
      }
    }
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const files: File[] = [];
    for (const it of items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      void ingestFiles(files);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) void ingestFiles(files);
  }

  return (
    <div className="flex flex-col items-center gap-2 px-4 pt-4 pb-4 md:px-8 md:pb-6">
      <div
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
            setDragOver(true);
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex w-full max-w-3xl flex-col gap-2 rounded-2xl border bg-white px-4 py-3 shadow-[0_1px_2px_rgba(10,10,10,0.04)] transition-colors ${
          dragOver
            ? "border-cyan ring-2 ring-[rgba(79,179,217,0.25)]"
            : "border-gray-200"
        }`}
      >
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {attachments.map((a) => (
              <AttachmentChip
                key={a.id}
                att={a}
                onRemove={() => removeAttachment(a.id)}
              />
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            onChange={onFilesSelected}
            className="hidden"
          />
          <button
            type="button"
            aria-label="Attach"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            className="mb-1 flex-shrink-0 text-gray-400 hover:text-ink disabled:opacity-50"
          >
            <AttachIcon />
          </button>
          <textarea
            value={listening ? interim : value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
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
              disabled={
                disabled ||
                (!value.trim() && attachments.length === 0) ||
                attachments.some((a) => a.kind === "pdf" && a.processing)
              }
              className="mb-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-cyan text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
      </div>
      <p className="font-mono text-[11px] text-gray-400">
        Your data stays on your hardware. Press <kbd>⇧</kbd> + <kbd>⏎</kbd> for a newline.
      </p>
    </div>
  );
}

function AttachmentChip({
  att,
  onRemove,
}: {
  att: Attachment;
  onRemove: () => void;
}) {
  if (att.kind === "image") {
    return (
      <div className="group relative overflow-hidden rounded-lg border border-cyan/30">
        <img
          src={att.dataUrl}
          alt={att.name}
          className="h-16 w-auto max-w-[140px] bg-gray-50 object-cover"
        />
        <div className="absolute right-0 bottom-0 left-0 truncate bg-black/60 px-1.5 py-0.5 text-[9px] text-white">
          {att.name} · {formatBytes(att.size)}
        </div>
        <RemoveButton onRemove={onRemove} />
      </div>
    );
  }
  if (att.kind === "pdf") {
    return (
      <div className="group relative h-16 w-[160px] overflow-hidden rounded-lg border border-rose-300 bg-rose-50">
        {att.processing ? (
          <div className="flex h-full flex-col items-center justify-center gap-1">
            <SpinnerIcon />
            <span className="font-mono text-[10px] font-medium text-rose-700">
              Page {att.progress ?? "…"}
            </span>
          </div>
        ) : att.error ? (
          <div className="flex h-full items-center justify-center px-2 text-center text-[10px] text-rose-700">
            ⚠︎ {att.error}
          </div>
        ) : att.thumbnail ? (
          <img
            src={att.thumbnail}
            alt={att.name}
            className="h-full w-full object-cover"
          />
        ) : null}
        <div className="absolute right-0 bottom-0 left-0 truncate bg-rose-900/70 px-1.5 py-0.5 text-[9px] text-white">
          {att.name}
          {att.processedPages !== undefined &&
            ` · ${att.processedPages}p${
              att.truncated ? ` (of ${att.totalPages})` : ""
            }`}
        </div>
        <RemoveButton onRemove={onRemove} />
      </div>
    );
  }
  return (
    <div className="group flex items-center gap-1.5 rounded-lg border border-cyan/30 bg-cyan/10 px-2.5 py-1 font-mono text-[11px] text-cyan-700">
      <FileIcon />
      <span>{att.name}</span>
      <span className="text-cyan-700/60">({formatBytes(att.size)})</span>
      <button
        type="button"
        onClick={onRemove}
        className="ml-0.5 text-cyan-700/60 hover:text-rose-600"
        aria-label="Remove"
      >
        ×
      </button>
    </div>
  );
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="absolute top-1 right-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[12px] text-white hover:bg-rose-600 group-hover:flex"
      aria-label="Remove"
    >
      ×
    </button>
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

function FileIcon() {
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
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
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
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="animate-spin text-rose-600"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
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
