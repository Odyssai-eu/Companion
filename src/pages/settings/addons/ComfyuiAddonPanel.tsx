import { useEffect, useRef, useState } from "react";
import { api } from "~/lib/api";
import { BridgeAddonPanel } from "./BridgeAddonPanel";
import { Field } from "./shared";

type GenerateEvent =
  | { event: "preflight"; data: { template?: string; model?: string } }
  | { event: "params"; data: Record<string, unknown> }
  | {
      event: "fp8_fallback";
      data: {
        substitutions: Array<{
          node_id: string;
          class_type: string;
          original: string;
          substituted: string;
          reason: string;
        }>;
      };
    }
  | { event: "downloads_start"; data: { files: string[] } }
  | { event: "downloads_done"; data: { count: number } }
  | { event: "submitting"; data: Record<string, unknown> }
  | {
      event: "submitted";
      data: { prompt_id: string; elapsed_s: number };
    }
  | { event: "sampling"; data: Record<string, unknown> }
  | {
      event: "done";
      data: {
        prompt_id: string;
        images: string[];
        raw_images: Array<{ filename: string; subfolder?: string; type?: string }>;
        duration_s: number;
      };
    }
  | { event: "error"; data: { phase?: string; message?: string } }
  | { event: string; data: unknown };

export function ComfyuiAddonPanel() {
  return (
    <div className="flex flex-col gap-6">
      <BridgeAddonPanel
        urlPlaceholder="http://192.168.86.141:8008"
        load={() => api.comfyuiAddonInfo()}
        save={(body) => api.comfyuiAddonSetConfig(body)}
        probe={() => api.comfyuiAddonProbe()}
      >
        <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
          <summary className="cursor-pointer font-medium text-ink">
            How the ComfyUI Imager bridge works
          </summary>
          <p className="mt-3 leading-relaxed">
            Companion forwards every generation to the{" "}
            <code className="rounded bg-gray-100 px-1 font-mono">
              OdyssAI-Imager
            </code>{" "}
            FastAPI bridge running on your Docker host. The bridge SSHes
            to the compute host (currently <code>.42</code>), talks to a
            running ComfyUI server, and streams progress back as SSE.
            Templates currently exposed:{" "}
            <code className="rounded bg-gray-100 px-1 font-mono">
              flux1-schnell-t2i-v1
            </code>{" "}
            (4 steps, fast) and{" "}
            <code className="rounded bg-gray-100 px-1 font-mono">
              flux1-dev-t2i-v1
            </code>{" "}
            (20 steps, full quality). More templates — including video —
            coming in later PRs.
          </p>
        </details>
      </BridgeAddonPanel>

      <GenerateSection />
    </div>
  );
}

function GenerateSection() {
  const [templates, setTemplates] = useState<string[]>([]);
  const [template, setTemplate] = useState("flux1-dev-t2i-v1");
  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [steps, setSteps] = useState(20);
  const [cfg, setCfg] = useState(3.5);
  const [seed, setSeed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState<GenerateEvent[]>([]);
  const [result, setResult] = useState<{
    images: string[];
    duration_s: number;
    prompt_id: string;
  } | null>(null);
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
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events]);

  async function run() {
    if (busy || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setEvents([]);
    try {
      for await (const ev of api.comfyuiGenerate({
        template,
        prompt: prompt.trim(),
        negative_prompt: negative.trim() || undefined,
        width,
        height,
        steps,
        cfg,
        seed: seed || undefined,
      })) {
        setEvents((prev) => [...prev, ev as GenerateEvent]);
        const data = (ev as GenerateEvent).data as Record<string, unknown>;
        if (ev.event === "done" && Array.isArray(data.images)) {
          setResult({
            images: data.images as string[],
            duration_s: typeof data.duration_s === "number" ? (data.duration_s as number) : 0,
            prompt_id: typeof data.prompt_id === "string" ? (data.prompt_id as string) : "",
          });
        } else if (ev.event === "error") {
          setError(
            typeof data.message === "string" ? (data.message as string) : "bridge error",
          );
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // The image URLs point at the private compute host which the browser
  // can't reach directly; Companion's tools executor base64-encodes the
  // image bytes server-side so the chat UI can render them inline. The
  // panel's role here is the request / progress stream only — the
  // resulting image surfaces in the chat (or via a future proxy route).

  return (
    <div className="flex flex-col gap-4 rounded-md border border-gray-200 bg-white px-4 py-4">
      <div className="flex flex-col gap-1">
        <h4 className="font-display text-[16px] font-medium text-ink">
          Generate
        </h4>
        <p className="text-[12px] text-gray-500">
          Submit a job. Progress streams below; the resulting image URL is
          for the bridge-side proxy only — render it via the chat or save
          the image directly from <code>.42</code>.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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

        <Field label="Seed (0 = random)">
          <input
            type="number"
            value={seed}
            onChange={(e) => setSeed(Number(e.target.value))}
            disabled={busy}
            min={0}
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
          />
        </Field>
      </div>

      <Field label="Prompt">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder="a small red fox sitting in fresh snow, soft morning light, cinematic, 35mm"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
        />
      </Field>

      <Field label="Negative prompt">
        <input
          type="text"
          value={negative}
          onChange={(e) => setNegative(e.target.value)}
          disabled={busy}
          placeholder="blurry, low quality, watermark, text"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan disabled:opacity-50"
        />
      </Field>

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

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={run}
          disabled={busy || !prompt.trim()}
          className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "Generating…" : "Generate"}
        </button>
        {result && (
          <span className="font-mono text-[11px] text-emerald-700">
            ✓ done in {result.duration_s.toFixed(1)}s ·{" "}
            {result.images.length} image(s)
          </span>
        )}
        {error && (
          <span className="font-mono text-[11px] text-red-700">✗ {error}</span>
        )}
      </div>

      {(events.length > 0 || busy) && (
        <div
          ref={logRef}
          className="max-h-48 overflow-y-auto rounded-md border border-gray-100 bg-gray-50 px-3 py-2 font-mono text-[11px] leading-[18px] text-gray-700"
        >
          {events.map((ev, i) => (
            <div key={i} className="flex gap-2">
              <span className="text-gray-400">{ev.event}</span>
              <span className="truncate text-gray-600">
                {summarise(ev)}
              </span>
            </div>
          ))}
          {busy && (
            <div className="flex gap-2 text-gray-400">
              <span>…</span>
              <span>streaming</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function summarise(ev: GenerateEvent): string {
  const d = ev.data as Record<string, unknown>;
  switch (ev.event) {
    case "preflight":
      return `template=${(d.template as string) ?? "?"}`;
    case "params":
      return `prompt="${(d.prompt as string)?.slice(0, 40) ?? ""}…"`;
    case "fp8_fallback":
      return `${(d.substitutions as unknown[])?.length ?? 0} substitution(s)`;
    case "downloads_start":
      return `${(d.files as string[])?.join(", ") ?? ""}`;
    case "downloads_done":
      return `${d.count} file(s)`;
    case "submitted":
      return `prompt_id=${(d.prompt_id as string)?.slice(0, 8)}…`;
    case "done":
      return `${(d.duration_s as number)?.toFixed(1)}s · ${
        (d.images as string[])?.length ?? 0
      } image(s)`;
    case "error":
      return `${d.phase ?? ""} ${d.message ?? ""}`;
    default:
      return JSON.stringify(d).slice(0, 120);
  }
}
