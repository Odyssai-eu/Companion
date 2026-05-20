import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "~/hooks/useIsMobile";
import type { ApiGlobalModel } from "~/lib/api";
import {
  ACCEPT_ATTR,
  type Attachment,
  formatBytes,
  processFile,
} from "~/lib/file-attach";
import { estimateTokens, formatTokenCount } from "~/lib/tokens";
import { voiceInput, type VoiceInputState } from "~/lib/voice-input";
import { useA11yPrefs } from "~/hooks/useA11yPrefs";

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
  hideModelPicker = false,
  onOpenVoiceLive,
  voiceLiveAvailable,
  priorTokens = 0,
  hiddenModels = [],
  inferenceMode = "expert",
  onToggleHidden,
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
  hideModelPicker?: boolean;
  onOpenVoiceLive?: () => void;
  voiceLiveAvailable?: boolean;
  /** Rough token count of the conversation history already on the wire
   *  (computed in ChatLayout from chat.messages). Combined with the live
   *  estimate of the typed value to render the context bar. */
  priorTokens?: number;
  /** Per-user hide list — filtered out in `easy`, grayed out elsewhere. */
  hiddenModels?: string[];
  inferenceMode?: "easy" | "advanced" | "expert";
  /** Toggle a model id's hidden state. Provided by ChatLayout; called
   *  from the eye button next to each row in advanced/expert mode. */
  onToggleHidden?: (id: string) => void;
}) {
  const [value, setValue] = useState("");
  const [voice, setVoice] = useState<VoiceInputState>({ status: "idle" });
  const a11y = useA11yPrefs();
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
          {a11y.voiceUiVisible && (
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
          )}

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
        <ContextBar
          model={model}
          models={models}
          priorTokens={priorTokens}
          draft={value}
        />
        <div className="flex items-center justify-between gap-2 pt-1">
          {!isMobile && (
            <p className="font-mono text-[11px] text-gray-400">
              Press <kbd>⇧</kbd> + <kbd>⏎</kbd> for a newline · <kbd>⏎</kbd> to send
            </p>
          )}
          <div className="flex items-center gap-2">
            {a11y.voiceUiVisible && voiceLiveAvailable && onOpenVoiceLive && (
              <button
                type="button"
                onClick={onOpenVoiceLive}
                title="Voice live (Gemini)"
                aria-label="Voice live"
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-50 hover:text-ink"
              >
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
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>
            )}
            {!hideModelPicker && (
              <ModelDropdown
                value={model}
                onChange={onModelChange}
                models={models}
                hiddenModels={hiddenModels}
                inferenceMode={inferenceMode}
                onToggleHidden={onToggleHidden}
              />
            )}
          </div>
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
  hiddenModels,
  inferenceMode,
  onToggleHidden,
}: {
  value: string;
  onChange: (id: string) => void;
  models: ApiGlobalModel[];
  hiddenModels: string[];
  inferenceMode: "easy" | "advanced" | "expert";
  onToggleHidden?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  // Easy mode: hidden ids vanish from the picker entirely so the user
  // sees only the curated set. Advanced / expert mode keeps them visible
  // (rendered grayed) with the eye toggle so they can be un-hidden inline.
  const hiddenSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);
  const visibleModels = useMemo(
    () =>
      inferenceMode === "easy"
        ? models.filter((m) => !hiddenSet.has(m.id))
        : models,
    [models, hiddenSet, inferenceMode],
  );

  // The "Auto" synthetic entry — picks chat / deep / code automatically
  // via the semantic-router add-on. Always rendered first; if the add-on
  // isn't configured, the server returns a clear 400 pointing to Settings.
  const AUTO_MODEL: ApiGlobalModel = useMemo(
    () => ({
      id: "auto",
      name: "Auto — pick best model per message",
      tags: ["Smart"],
      capabilities: { vision: false, tools: false },
    }),
    [],
  );

  // Group by tag (first tag wins). Untagged → "Other". Auto always
  // sits at the top of the list in its own "Smart" group.
  const groups = useMemo(() => {
    const out = new Map<string, ApiGlobalModel[]>();
    out.set("Smart", [AUTO_MODEL]);
    for (const m of visibleModels) {
      if (m.id === "auto") continue; // dedupe if backend ever lists it
      const tag = m.tags[0] ?? "Models";
      const list = out.get(tag) ?? [];
      list.push(m);
      out.set(tag, list);
    }
    return Array.from(out.entries());
  }, [visibleModels, AUTO_MODEL]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const current =
    value === "auto" ? AUTO_MODEL : models.find((m) => m.id === value);
  const label =
    value === "auto" ? "Auto" : (current?.name ?? value ?? "Pick a model");

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
                <ModelRow
                  key={m.id}
                  model={m}
                  selected={m.id === value}
                  hidden={hiddenSet.has(m.id)}
                  showHideToggle={inferenceMode !== "easy" && !!onToggleHidden}
                  onToggleHidden={
                    onToggleHidden ? () => onToggleHidden(m.id) : undefined
                  }
                  onPick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                />
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

/**
 * One row in the ModelDropdown. Renders the alias on the first line,
 * a compact metadata line below (family · quantization · ctx), plus
 * status badges (loaded / loading / cold) when the Odyssai capability
 * contract is available. Hover tooltip carries the long-form details
 * (size, backend, nodes, tps, cold-start ETA) so the picker stays
 * scannable without losing the depth a power user wants.
 *
 * When `m.odyssai` is absent (cloud aliases, no engine configured),
 * we fall back to just the alias + vision chip — same as before.
 */
function ModelRow({
  model,
  selected,
  hidden = false,
  showHideToggle = false,
  onToggleHidden,
  onPick,
}: {
  model: ApiGlobalModel;
  selected: boolean;
  /** True when this model is in the user's hide list. Renders grayed
   *  out so the user remembers it exists. Clicking the row still picks
   *  it (we don't lock the selection — only easy mode filters). */
  hidden?: boolean;
  /** When true, render the eye-toggle next to the row's right-side
   *  badges so the user can hide/un-hide inline. */
  showHideToggle?: boolean;
  onToggleHidden?: () => void;
  onPick: () => void;
}) {
  const o = model.odyssai;
  const subtitle = o
    ? [
        o.family ?? null,
        o.quantization ?? null,
        o.context_length ? `ctx ${formatTokenCount(o.context_length)}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const tooltip = o ? buildOdyssaiTooltip(o) : undefined;
  return (
    <div
      className={`group/row flex w-full items-start gap-2 px-3 py-2 text-[13px] ${
        selected
          ? "bg-cyan/10 text-navy"
          : "text-ink hover:bg-gray-50"
      } ${hidden ? "opacity-45" : ""}`}
    >
      <button
        type="button"
        onClick={onPick}
        title={tooltip}
        className="flex flex-1 min-w-0 items-start justify-between gap-2 text-left"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-mono">{model.name}</span>
          {subtitle && (
            <span className="truncate font-mono text-[10px] text-gray-500">
              {subtitle}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {o && <PoolBadge caps={o} />}
          {o && <LoadStateBadge caps={o} />}
          {model.capabilities.vision && (
            <span
              title="Vision-capable"
              className="rounded-full bg-cyan/15 px-1.5 py-0.5 text-[10px] text-cyan-700"
            >
              👁
            </span>
          )}
          {model.capabilities.tools && (
            <span
              title="Tool / function calling"
              className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-700"
            >
              ⚒
            </span>
          )}
        </span>
      </button>
      {showHideToggle && onToggleHidden && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleHidden();
          }}
          title={hidden ? "Show in picker (easy mode)" : "Hide from picker (easy mode)"}
          className="shrink-0 self-center rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-100 hover:text-ink group-hover/row:opacity-100"
        >
          {/* eye-slash if hidden, eye if visible */}
          <span aria-hidden className="text-[14px] leading-none">
            {hidden ? "🙈" : "👁"}
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * Small state pill on the right of each row. Three visual states:
 *   🟢 loaded  — green, model is warm and ready
 *   🟡 loading — amber pulse, hot-loading (4-8 min for big MoEs)
 *   ⚪ cold    — neutral, exists in the catalog but not in RAM
 *   (none)     — no capability info (cloud or non-Odyssai engine)
 */
function LoadStateBadge({
  caps,
}: {
  caps: NonNullable<ApiGlobalModel["odyssai"]>;
}) {
  if (caps.loading) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 font-mono text-[10px] text-amber-800">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
        loading
      </span>
    );
  }
  if (caps.loaded) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-1.5 py-0.5 font-mono text-[10px] text-emerald-800">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
        loaded
      </span>
    );
  }
  if (caps.admin_loadable) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600">
        <span className="h-1.5 w-1.5 rounded-full bg-gray-300" />
        cold
      </span>
    );
  }
  return null;
}

/**
 * Cloud vs local origin pill. Driven by `caps.backend`: `http-proxy`
 * means the engine is proxying an external cloud provider (OpenRouter,
 * Anthropic…), anything else is a local pool (jaccl, mlx, …). The
 * brand convention is ☁ for cloud, ⚙ for local.
 */
function PoolBadge({
  caps,
}: {
  caps: NonNullable<ApiGlobalModel["odyssai"]>;
}) {
  if (!caps.pool && !caps.backend) return null;
  const isCloud = caps.backend === "http-proxy";
  const label = caps.pool ?? (isCloud ? "cloud" : "local");
  return (
    <span
      title={
        isCloud
          ? `Cloud pool — proxied through the engine (${caps.backend})`
          : `Local pool — ${caps.backend ?? "engine-native"}`
      }
      className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
        isCloud
          ? "bg-slate-100 text-slate-700"
          : "bg-cyan/15 text-cyan-700"
      }`}
    >
      <span>{isCloud ? "☁" : "⚙"}</span>
      <span>{label}</span>
    </span>
  );
}

/**
 * Multi-line tooltip text shown on hover. Native `title` attribute —
 * no fancy popover, just plain text. Lines that have no value are
 * skipped so cloud models don't show "size: null" gibberish.
 */
function buildOdyssaiTooltip(
  caps: NonNullable<ApiGlobalModel["odyssai"]>,
): string {
  const lines: string[] = [];
  if (caps.alias_for) lines.push(`Alias of: ${caps.alias_for}`);
  if (caps.pool) lines.push(`Pool: ${caps.pool}`);
  if (caps.backend && caps.nodes) {
    lines.push(`Backend: ${caps.backend} · ${caps.nodes} node${caps.nodes === 1 ? "" : "s"}`);
  } else if (caps.backend) {
    lines.push(`Backend: ${caps.backend}`);
  }
  if (caps.context_length) {
    lines.push(`Context: ${caps.context_length.toLocaleString()} tokens`);
  }
  if (caps.quantization) lines.push(`Quantization: ${caps.quantization}`);
  if (caps.size_bytes) lines.push(`Size: ${formatBytes(caps.size_bytes)}`);
  if (caps.estimated_tps) {
    lines.push(`Speed: ~${caps.estimated_tps.toFixed(1)} tok/s`);
  }
  if (!caps.loaded && caps.estimated_load_s) {
    lines.push(
      `Cold-start ETA: ~${Math.round(caps.estimated_load_s)}s`,
    );
  }
  if (caps.kv_cache_q8) lines.push("KV cache: 8-bit");
  return lines.join("\n");
}

/**
 * Context-budget bar — renders when the selected model has a known
 * `context_length` (declared via the Odyssai capability contract, see
 * server/lib/odyssai-contract.ts). Combines an estimate of the
 * conversation history (priorTokens, computed in ChatLayout) with a
 * live estimate of the draft typed in the textarea.
 *
 * Token count is char-based (≈4 chars/token) — fine for budget signal,
 * not for billing. See src/lib/tokens.ts. When the model exposes no
 * context_length (cloud aliases without contract, heuristic fallback),
 * the bar is hidden — we'd rather show nothing than guess a ceiling.
 */
function ContextBar({
  model,
  models,
  priorTokens,
  draft,
}: {
  model: string;
  models: ApiGlobalModel[];
  priorTokens: number;
  draft: string;
}) {
  const current = models.find((m) => m.id === model);
  const ctx = current?.odyssai?.context_length ?? null;
  if (!ctx || ctx <= 0) return null;
  const used = priorTokens + estimateTokens(draft);
  const pct = Math.min(100, (used / ctx) * 100);
  const tone =
    pct >= 90
      ? { bar: "bg-rose-500", text: "text-rose-700" }
      : pct >= 70
        ? { bar: "bg-amber-500", text: "text-amber-700" }
        : { bar: "bg-cyan", text: "text-gray-500" };
  return (
    <div
      className="flex items-center gap-2 pt-1.5"
      title={`~${used.toLocaleString()} tokens used of ${ctx.toLocaleString()} context window (rough estimate, ≈4 chars/token).`}
    >
      <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-gray-100">
        <div
          className={`absolute inset-y-0 left-0 ${tone.bar} transition-[width]`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`font-mono text-[10px] ${tone.text}`}>
        ≈ {formatTokenCount(used)} / {formatTokenCount(ctx)}
      </span>
    </div>
  );
}
