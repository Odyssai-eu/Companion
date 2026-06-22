import { useEffect, useRef, useState } from "react";
import { api } from "~/lib/api";
import { Field } from "~/pages/settings/addons/shared";

/**
 * ComfyUI Imager enriched-prompt modal.
 *
 * Triggered by typing `/comfyui` (with or without a prompt) in the chat
 * composer. The composer routes to this modal instead of plain chat. The
 * modal collects template + knobs, then calls /api/agents/comfyui/slash
 * (server-side polls the bridge for completion; images come back base64
 * inlined because the upstream URLs point at the private compute host).
 *
 * The bridge's POST /v1/templates/{slug}/run contract only exposes
 * {prompt, width, height, steps}. Anything else (cfg, seed, batch,
 * negative_prompt) is intentionally absent — those knobs live inside
 * the workflow JSON and are not user-tunable today.
 *
 * On success the modal calls onResult(images, prompt_id, duration_s) and
 * closes; the chat composer decides how to render the image in the
 * message stream.
 */

type TemplateMeta = {
  slug: string;
  description: string | null;
  model: string | null;
  inputs: string[];
  defaults?: Record<string, number>;
};

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
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [templateSource, setTemplateSource] = useState<
    "bridge" | "fallback" | null
  >(null);
  const [template, setTemplate] = useState<string>("");
  const [prompt, setPrompt] = useState(initial.prompt);
  const [width, setWidth] = useState(1664);
  const [height, setHeight] = useState(928);
  const [steps, setSteps] = useState(12);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Load templates + their declared inputs on mount. The bridge is the
  // source of truth; on first paint we fall back to whatever the server
  // sent down (which itself may be a static fallback if the bridge is
  // unreachable).
  useEffect(() => {
    api
      .comfyuiTemplates()
      .then((r) => {
        setTemplates(r.templates);
        setTemplateSource(r.source ?? null);
        if (r.templates.length > 0) {
          // Keep the previously selected slug if it still exists; otherwise
          // pick the first one.
          setTemplate((prev) =>
            prev && r.templates.some((t) => t.slug === prev)
              ? prev
              : r.templates[0]!.slug,
          );
        }
      })
      .catch(() => undefined);
  }, []);

  // Apply the selected template's defaults whenever the template changes.
  // The user can still tweak any value after the seed; this only affects
  // the initial render and template switches. Skipping when the template
  // doesn't declare the input keeps the previous user value intact.
  const currentTemplate = templates.find((t) => t.slug === template) ?? null;
  useEffect(() => {
    if (!currentTemplate?.defaults) return;
    const d = currentTemplate.defaults;
    if (typeof d.width === "number") setWidth(d.width);
    if (typeof d.height === "number") setHeight(d.height);
    if (typeof d.steps === "number") setSteps(d.steps);
  }, [currentTemplate]);

  // Re-render the phase log on every update so the user sees progress
  // even though we no longer expose a real-time SSE stream (the server
  // polls on our behalf).
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [phase]);

  // ⌘↩ / Ctrl↩ to send; Esc to close; standard "form in a modal"
  // expectations.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run();
    }
  }

  async function run() {
    if (busy) return;
    if (!prompt.trim()) {
      setError("Type a prompt first.");
      return;
    }
    if (!template) {
      setError("Pick a template first.");
      return;
    }
    setBusy(true);
    setError(null);
    setPhase("submitting");
    try {
      // The server polls the bridge on our behalf. Typical generations
      // take 30s-5min depending on model + steps. The modal just waits.
      setPhase("generating");
      const r = await api.comfyuiSlash({
        conversationId,
        template,
        prompt: prompt.trim(),
        width,
        height,
        steps,
      });
      onResult({
        prompt_id: r.prompt_id,
        duration_s: r.duration_s,
        images: r.images,
        transcript_tail: r.transcript_tail,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPhase("");
    }
  }

  const declared = new Set(currentTemplate?.inputs ?? []);
  const showWidth = declared.has("width");
  const showHeight = declared.has("height");
  const showSteps = declared.has("steps");

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
              POST /api/agents/comfyui/slash · template={template || "—"}
              {templateSource === "fallback" && " · fallback"}
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
            <Field label="Template">
              <select
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                disabled={busy || templates.length === 0}
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
              >
                {templates.length === 0 ? (
                  <option value="">(loading…)</option>
                ) : (
                  templates.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.slug}
                    </option>
                  ))
                )}
              </select>
              {currentTemplate?.description && (
                <p className="mt-1 font-mono text-[10px] text-gray-400">
                  {currentTemplate.description}
                  {currentTemplate.model && (
                    <>
                      {" · "}
                      <span className="text-cyan">{currentTemplate.model}</span>
                    </>
                  )}
                </p>
              )}
              {templateSource === "fallback" && (
                <p className="mt-1 font-mono text-[10px] text-amber-600">
                  ⚠ bridge unreachable — showing static fallback list.
                </p>
              )}
            </Field>

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
            </Field>

            <div className="grid grid-cols-3 gap-3">
              {showWidth && (
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
              )}
              {showHeight && (
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
              )}
              {showSteps && (
                <Field label="Steps">
                  <input
                    type="number"
                    value={steps}
                    onChange={(e) => setSteps(Number(e.target.value))}
                    disabled={busy}
                    min={1}
                    max={200}
                    className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
                  />
                </Field>
              )}
            </div>

            {(phase || busy) && (
              <div
                ref={logRef}
                className="max-h-28 overflow-y-auto rounded-md border border-gray-100 bg-gray-50 px-3 py-2 font-mono text-[11px] leading-[18px] text-gray-700"
              >
                <div className="flex gap-2 text-gray-400">
                  <span>…</span>
                  <span>
                    {phase === "submitting" && "submitting to bridge"}
                    {phase === "generating" && "generating (bridge polling)"}
                    {!phase && busy && "working"}
                  </span>
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
            <kbd>⌘</kbd> + <kbd>⏎</kbd> generate · <kbd>Esc</kbd> close ·
            outputs base64 inlined
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
              disabled={busy || !prompt.trim() || !template}
              className="rounded-md bg-navy px-5 py-1.5 text-[13px] font-semibold text-white hover:opacity-95 disabled:opacity-40"
            >
              {busy ? "Generating…" : "Generate"}
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
