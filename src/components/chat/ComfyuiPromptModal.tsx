import { useEffect, useRef, useState } from "react";
import { api } from "~/lib/api";
import { Field } from "~/pages/settings/addons/shared";

/**
 * ComfyUI Imager enriched-prompt modal.
 *
 * Triggered by typing `/comfyui` (with or without a prompt) in the chat
 * composer. The composer routes to this modal instead of plain chat. The
 * modal collects template + knobs, then calls /api/agents/comfyui/slash
 * (SSE drained server-side; images come back base64 inlined because the
 * upstream URLs point at the private compute host).
 *
 * Flux.1 has no negative prompt, so the field is intentionally absent.
 * (SD / SDXL have it; Wan / LTX may have their own conventions — the
 * template select will gate which fields show up in a later PR.)
 *
 * On success the modal calls onResult(images, prompt_id, duration_s) and
 * closes; the chat composer decides how to render the image in the
 * message stream.
 */
export type ComfyuiPrompt = {
  /** Initial prompt text from the slash command (everything after
   *  /comfyui). Empty string if the user typed just `/comfyui`. */
  prompt: string;
};

export type ComfyuiResult = {
  prompt_id: string | null;
  duration_s: number | null;
  images: Array<{ filename: string; mime: string; dataBase64: string }>;
  transcript_tail: Array<{ event: string; data: unknown }>;
};

export function ComfyuiPromptModal({
  initial,
  conversationId,
  onClose,
  onResult,
}: {
  initial: ComfyuiPrompt;
  conversationId: string;
  onClose: () => void;
  onResult: (r: ComfyuiResult) => void;
}) {
  const [templates, setTemplates] = useState<string[]>([]);
  const [template, setTemplate] = useState("flux1-dev-t2i-v1");
  const [prompt, setPrompt] = useState(initial.prompt);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(3.5);
  const [seed, setSeed] = useState(0);
  const [batch, setBatch] = useState(1);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api
      .comfyuiTemplates()
      .then((r) => {
        setTemplates(r.templates);
        if (r.templates.length && !r.templates.includes(template)) {
          setTemplate(r.templates[0]);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [phase]);

  async function run() {
    if (busy) return;
    if (!prompt.trim()) {
      setError("Type a prompt first.");
      return;
    }
    setBusy(true);
    setError(null);
    setPhase("submitting");
    try {
      // Run batch sequentially. We could parallelize, but the bridge's
      // own model is already heavy; running two generations at once
      // thrashes MPS memory more than it helps wall time.
      const allImages: ComfyuiResult["images"] = [];
      let lastPromptId: string | null = null;
      let lastDuration: number | null = null;
      let transcriptTail: ComfyuiResult["transcript_tail"] = [];
      for (let i = 0; i < batch; i++) {
        if (batch > 1) setPhase(`Generating ${i + 1} / ${batch}…`);
        const r = await api.comfyuiSlash({
          conversationId,
          prompt: prompt.trim(),
          template,
          width,
          height,
          steps,
          cfg,
          // Per-image seed: keep base + i so re-running with the same
          // base seed produces reproducible variants.
          seed: seed || undefined,
        });
        allImages.push(...r.images);
        lastPromptId = r.prompt_id;
        lastDuration = r.duration_s;
        transcriptTail = r.transcript_tail;
      }
      onResult({
        prompt_id: lastPromptId,
        duration_s: lastDuration,
        images: allImages,
        transcript_tail: transcriptTail,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPhase("");
    }
  }

  // ⌘↩ / Ctrl↩ to send; Esc to close; standard "form in a modal"
  // expectations.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6"
      onClick={() => !busy && onClose()}
    >
      <div
        role="dialog"
        aria-label="ComfyUI image generation"
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <div className="flex flex-col gap-0.5">
            <h2 className="font-display text-[18px] font-medium text-ink">
              ComfyUI Imager
            </h2>
            <p className="font-mono text-[11px] text-gray-400">
              POST /api/agents/comfyui/slash · template={template}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="text-gray-400 hover:text-ink disabled:opacity-30"
          >
            <CloseIcon />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-4">
            <Field label="Prompt">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                disabled={busy}
                rows={4}
                autoFocus
                placeholder="a small red fox sitting in fresh snow, soft morning light, cinematic, 35mm photography"
                className="w-full resize-none rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
              />
              <p className="mt-1 font-mono text-[10px] text-gray-400">
                Flux.1 has no negative prompt — the field is omitted on
                purpose (ComfyUI's CLIPTextEncode #5 on Flux is wired to a
                zero-out conditioning).
              </p>
            </Field>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
              <Field label="Template">
                <select
                  value={template}
                  onChange={(e) => setTemplate(e.target.value)}
                  disabled={busy || templates.length === 0}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
                >
                  {templates.length === 0 ? (
                    <option value="flux1-dev-t2i-v1">flux1-dev-t2i-v1</option>
                  ) : (
                    templates.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))
                  )}
                </select>
              </Field>
              <Field label="Batch count">
                <input
                  type="number"
                  value={batch}
                  onChange={(e) =>
                    setBatch(Math.max(1, Math.min(8, Number(e.target.value))))
                  }
                  disabled={busy}
                  min={1}
                  max={8}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
                />
              </Field>
              <Field label="Seed (0 = random)">
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Math.max(0, Number(e.target.value)))}
                  disabled={busy}
                  min={0}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Field label="Width">
                <input
                  type="number"
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value))}
                  disabled={busy}
                  min={64}
                  step={8}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
                />
              </Field>
              <Field label="Height">
                <input
                  type="number"
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value))}
                  disabled={busy}
                  min={64}
                  step={8}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
                />
              </Field>
              <Field label="Steps">
                <input
                  type="number"
                  value={steps}
                  onChange={(e) => setSteps(Number(e.target.value))}
                  disabled={busy}
                  min={1}
                  max={100}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
                />
              </Field>
              <Field label="CFG">
                <input
                  type="number"
                  value={cfg}
                  onChange={(e) => setCfg(Number(e.target.value))}
                  disabled={busy}
                  min={0}
                  step={0.1}
                  className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
                />
              </Field>
            </div>

            {(phase || busy) && (
              <div
                ref={logRef}
                className="max-h-28 overflow-y-auto rounded-md border border-gray-100 bg-gray-50 px-3 py-2 font-mono text-[11px] leading-[18px] text-gray-700"
              >
                <div className="flex gap-2 text-gray-400">
                  <span>…</span>
                  <span>{phase || "streaming"}</span>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-red-100 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
                ✗ {error}
              </div>
            )}
          </div>
        </div>

        <footer className="flex items-center justify-between border-t border-gray-200 px-6 py-3">
          <span className="font-mono text-[10px] text-gray-400">
            <kbd>⌘</kbd> + <kbd>⏎</kbd> generate · <kbd>Esc</kbd> close · outputs base64 inlined
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md px-4 py-1.5 text-[13px] text-gray-600 hover:text-ink disabled:opacity-30"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={run}
              disabled={busy || !prompt.trim()}
              className="rounded-md bg-navy px-5 py-1.5 text-[13px] font-semibold text-white hover:opacity-95 disabled:opacity-40"
            >
              {busy ? "Generating…" : batch > 1 ? `Generate ${batch}` : "Generate"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
