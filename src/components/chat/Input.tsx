import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "~/hooks/useIsMobile";
import type { ApiGlobalModel } from "~/lib/api";
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
  modelHasVision = true,
  model,
  onModelChange,
  models,
}: {
  onSend: (text: string, attachments: Attachment[]) => void;
  onCancel: () => void;
  sending: boolean;
  disabled?: boolean;
  placeholder?: string;
  /** When false, show a warning if the user has attached images. Defaults to
   *  true (permissive) so we never show a false negative. */
  modelHasVision?: boolean;
  model: string;
  onModelChange: (id: string) => void;
  models: ApiGlobalModel[];
}) {
  const [value, setValue] = useState("");
  const [voice, setVoice] = useState<VoiceInputState>({ status: "idle" });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isMobile = useIsMobile();

  // ExoScopy-style auto-resize: grow up to 200px, then scroll.
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    el.style.overflowY = el.scrollHeight > 200 ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

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
        {!modelHasVision &&
          attachments.some((a) => a.kind === "image") && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] text-amber-700">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="flex-shrink-0"
              >
                <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              This model may not support images — the image might be ignored.
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
            className={`flex-shrink-0 text-gray-400 hover:text-ink disabled:opacity-50 ${
              isMobile
                ? "flex h-11 w-11 items-center justify-center"
                : "mb-1"
            }`}
          >
            <AttachIcon />
          </button>
          <textarea
            ref={textareaRef}
            value={listening ? interim : value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            disabled={disabled || listening}
            rows={1}
            placeholder={
              listening
                ? "Listening… speak now, click Stop when done."
                : placeholder ?? "Ask anything…"
            }
            className="flex-1 resize-none border-0 bg-transparent p-0 text-[15px] leading-[22px] text-ink outline-none placeholder:text-gray-400 disabled:opacity-50"
            style={{
              minHeight: "22px",
              maxHeight: "200px",
              overflowY: "hidden",
              overflowX: "hidden",
              appearance: "none",
              WebkitAppearance: "none",
              boxShadow: "none",
            }}
          />
          {!isMobile && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              disabled={disabled || listening}
              title="Expand editor"
              className="mb-1 flex-shrink-0 text-gray-400 hover:text-ink disabled:opacity-50"
            >
              <ExpandIcon />
            </button>
          )}
          <button
            type="button"
            onClick={startTalk}
            disabled={disabled || sending}
            title={listening ? "Stop listening" : "Talk (push-to-talk)"}
            className={`mb-0.5 flex flex-shrink-0 items-center gap-1.5 rounded-full border font-medium transition-colors disabled:opacity-50 ${
              isMobile ? "h-11 w-11 justify-center" : "px-3 py-1.5 text-[12px]"
            } ${
              listening
                ? "border-cyan bg-[rgba(79,179,217,0.12)] text-cyan"
                : "border-gray-200 text-ink hover:bg-gray-50"
            }`}
          >
            <MicIcon />
            {!isMobile && (listening ? "Stop" : "Talk")}
          </button>

          {sending ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop"
              className={`mb-0.5 flex flex-shrink-0 items-center justify-center rounded-full bg-navy text-white transition-opacity hover:opacity-90 ${
                isMobile ? "h-11 w-11" : "h-9 w-9"
              }`}
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
              className={`mb-0.5 flex flex-shrink-0 items-center justify-center rounded-full bg-cyan text-white transition-opacity hover:opacity-90 disabled:opacity-40 ${
                isMobile ? "h-11 w-11" : "h-9 w-9"
              }`}
            >
              <ArrowUpIcon />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          {!isMobile && (
            <p className="font-mono text-[11px] text-gray-400">
              Press <kbd>⇧</kbd> + <kbd>⏎</kbd> for a newline · <kbd>⏎</kbd> to send
            </p>
          )}
          <ModelDropdown
            value={model}
            onChange={onModelChange}
            models={models}
          />
        </div>
      </div>
      {expanded && (
        <ExpandedEditor
          value={value}
          onChange={(v) => {
            setValue(v);
          }}
          onClose={() => setExpanded(false)}
          onSend={() => {
            setExpanded(false);
            submit();
          }}
        />
      )}
    </div>
  );
}

// ── Expanded editor modal (ExoScopy parity) ────────────────────────────────

function ExpandedEditor({
  value,
  onChange,
  onClose,
  onSend,
}: {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  onSend: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-8"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <span className="text-[14px] font-semibold text-ink">Edit message</span>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] text-gray-400">
              {value.length} chars
            </span>
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-ink"
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden p-4">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onSend();
              }
            }}
            autoFocus
            placeholder="Type your message…"
            className="h-full min-h-[300px] w-full resize-none text-[15px] leading-relaxed text-ink outline-none placeholder:text-gray-400"
          />
        </div>
        <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3">
          <span className="font-mono text-[11px] text-gray-400">
            <kbd>⇧</kbd> + <kbd>⏎</kbd> newline · <kbd>⌘</kbd> + <kbd>⏎</kbd> send · <kbd>Esc</kbd> close
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-4 py-1.5 text-[13px] text-gray-600 hover:text-ink"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onSend}
              disabled={!value.trim()}
              className="rounded-md bg-cyan px-5 py-1.5 text-[13px] font-semibold text-white hover:opacity-95 disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Model dropdown ─────────────────────────────────────────────────────────

function ModelDropdown({
  value,
  onChange,
  models,
}: {
  value: string;
  onChange: (id: string) => void;
  models: ApiGlobalModel[];
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // Group by tag (first tag wins). Untagged → "Other".
  const groups = useMemo(() => {
    const out = new Map<string, ApiGlobalModel[]>();
    for (const m of models) {
      const tag = m.tags[0] ?? "Models";
      const list = out.get(tag) ?? [];
      list.push(m);
      out.set(tag, list);
    }
    return Array.from(out.entries());
  }, [models]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = models.find((m) => m.id === value);
  const label = current?.name ?? value ?? "Pick a model";

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-1 font-mono text-[11px] text-gray-700 hover:bg-gray-50 hover:text-ink"
      >
        <span className="max-w-[260px] truncate">{label}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div
          className={`absolute bottom-full z-30 mb-2 max-h-[400px] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg ${
            isMobile
              ? // Mobile: trigger sits on the left of the row (justify-between
                // with a single child), so anchor the panel to the trigger's
                // left edge and let it extend right, clamped to viewport.
                "left-0 w-[min(320px,calc(100vw-1.5rem))]"
              : "right-0 w-[320px]"
          }`}
        >
          {models.length === 0 && (
            <div className="px-3 py-4 text-center font-mono text-[11px] text-gray-400">
              No models — check your LiteLLM URL in Settings → Inference.
            </div>
          )}
          {groups.map(([group, list]) => (
            <div key={group}>
              <div className="border-b border-gray-100 bg-gray-50 px-3 py-1.5 font-mono text-[10px] tracking-[0.05em] text-gray-500 uppercase">
                {group}
              </div>
              {list.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] ${
                    m.id === value
                      ? "bg-cyan/10 text-navy"
                      : "text-ink hover:bg-gray-50"
                  }`}
                >
                  <span className="truncate font-mono">{m.name}</span>
                  {m.capabilities.vision && (
                    <span
                      title="Vision-capable"
                      className="flex-shrink-0 rounded-full bg-cyan/15 px-1.5 py-0.5 text-[10px] text-cyan-700"
                    >
                      👁
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
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

function ExpandIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function CloseIcon() {
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
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
