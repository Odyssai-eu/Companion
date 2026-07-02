import { useEffect, useRef, useState } from "react";
import { api } from "~/lib/api";
import { Field } from "./shared";

/**
 * Document Parser add-on panel.
 *
 * Configures the Docling endpoint + PDF mode and exposes a Test button
 * that uploads a small file to POST /api/addons/parser/test to verify the
 * service is reachable. Visual style matches ComfyuiAddonPanel /
 * BridgeAddonPanel — Save + Test buttons, uppercase field labels, the
 * shared Field wrapper.
 *
 * The parse itself happens server-side on the chat send path (the Parser
 * hook in server/lib/parser.ts). This panel is setup only: the on/off
 * switch is the card toggle above; here the user points Companion at their
 * Docling URL and picks how PDFs are handled.
 */
export function ParserAddonPanel() {
  const [info, setInfo] = useState<{
    enabled: boolean;
    url: string;
    pdfMode: "text" | "vision";
    configured: boolean;
  } | null>(null);
  const [url, setUrl] = useState("");
  const [pdfMode, setPdfMode] = useState<"text" | "vision">("text");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const testInputRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      const r = await api.parserAddonInfo();
      setInfo(r);
      setUrl(r.url ?? "");
      setPdfMode(r.pdfMode === "vision" ? "vision" : "text");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function persist() {
    setBusy("save");
    setErr(null);
    try {
      await api.parserAddonSetConfig({ url: url.trim(), pdfMode });
      setSaved(true);
      await refresh();
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onTestFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy("test");
    setErr(null);
    setTestMsg(null);
    try {
      const r = await api.parserAddonTest(file);
      setTestMsg(
        r.ok
          ? {
              ok: true,
              text: `Parsed ${file.name} — ${r.chars ?? 0} chars, ${
                r.pages ?? 0
              } page(s), ${r.ms ?? 0} ms`,
            }
          : {
              ok: false,
              text:
                r.error ??
                (r.status ? `Docling returned HTTP ${r.status}` : "No response"),
            },
      );
    } catch (e) {
      setTestMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  if (!info) {
    return <span className="font-mono text-[11px] text-gray-400">Loading…</span>;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[12px] text-gray-600">
        <span>
          <span className="text-gray-400">Status</span>{" "}
          <span className="font-mono text-ink">
            {info.configured ? "✓ configured" : "✗ no endpoint set"}
          </span>
        </span>
        <span>
          <span className="text-gray-400">PDF mode</span>{" "}
          <span className="font-mono text-ink">{pdfMode}</span>
        </span>
      </div>

      <Field label="Docling URL">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://docling-host:8083/parse"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          The Docling parse endpoint, reachable from the Companion server (not
          your browser). Documents are POSTed here as multipart{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">file</code> and
          come back as markdown.
        </p>
      </Field>

      <Field label="PDF mode">
        <select
          value={pdfMode}
          onChange={(e) => setPdfMode(e.target.value as "text" | "vision")}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-cyan"
        >
          <option value="text">text — parse PDFs to markdown via Docling</option>
          <option value="vision">
            vision — send PDF pages as images (needs a vision model)
          </option>
        </select>
        <p className="mt-2 text-[11px] text-gray-500">
          <strong className="text-ink">text</strong> extracts the PDF to
          markdown so text-only models (MiniMax) can read it.{" "}
          <strong className="text-ink">vision</strong> keeps the existing
          rasterize-to-image behaviour for models that see.
        </p>
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={persist}
          disabled={busy !== null}
          className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
        >
          {busy === "save" ? "Saving…" : saved ? "✓ Saved" : "Save"}
        </button>
        <input
          ref={testInputRef}
          type="file"
          accept=".pdf,.docx,.doc,.pptx,.xlsx,.csv,.md,.html"
          onChange={onTestFile}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => testInputRef.current?.click()}
          disabled={busy !== null || !info.configured}
          className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-600 hover:text-ink disabled:opacity-50"
        >
          {busy === "test" ? "Testing…" : "Test with a file"}
        </button>
        {testMsg && (
          <span
            className={`font-mono text-[11px] ${
              testMsg.ok ? "text-emerald-700" : "text-red-700"
            }`}
          >
            {testMsg.ok ? "● " : "✗ "}
            {testMsg.text}
          </span>
        )}
      </div>

      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How the document parser works
        </summary>
        <p className="mt-3 leading-relaxed">
          When you attach a document (PDF, DOCX, PPTX, XLSX, CSV, MD, HTML),
          Companion uploads the raw file to the{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">Docling</code>{" "}
          service, which extracts it to markdown{" "}
          <em>before</em> the message reaches the model. The model sees the
          document as inline text, wrapped in{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">
            [Document: name]
          </code>{" "}
          markers. Images are unaffected — they still go straight to a vision
          model. If parsing fails, the turn still sends with a short note in
          place of the document.
        </p>
      </details>

      {err && (
        <div className="rounded-md border border-red-100 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
          {err}
        </div>
      )}
    </div>
  );
}
