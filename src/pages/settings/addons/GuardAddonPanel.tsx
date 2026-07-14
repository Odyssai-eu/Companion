import { useEffect, useState } from "react";
import { api } from "~/lib/api";
import { Field } from "./shared";

/**
 * Confidential Guard add-on panel.
 *
 * Configures the guard service endpoint (GLiNER2 PII sidecar) + the
 * policy (warn only, or warn + force the turn onto the local engine)
 * and exposes a Test box that classifies a text sample via
 * POST /api/addons/guard/test to verify the service is reachable.
 * Visual style matches ParserAddonPanel.
 *
 * The classification itself happens server-side on the chat send path
 * (the guard hook in server/lib/guard.ts). This panel is setup only:
 * the on/off switch is the card toggle above.
 */
export function GuardAddonPanel() {
  const [info, setInfo] = useState<{
    enabled: boolean;
    url: string;
    action: "warn" | "force-local";
    localModel: string;
    threshold: number;
    contextualLlmUrl: string;
    contextualLlmModel: string;
    configured: boolean;
  } | null>(null);
  const [url, setUrl] = useState("");
  const [action, setAction] = useState<"warn" | "force-local">("warn");
  const [localModel, setLocalModel] = useState("");
  const [contextualLlmUrl, setContextualLlmUrl] = useState("");
  const [contextualLlmModel, setContextualLlmModel] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testText, setTestText] = useState(
    "My IBAN is FR76 3000 6000 0112 3456 7890 189 and I live at 12 rue de la Paix, Paris.",
  );
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function refresh() {
    try {
      const r = await api.guardAddonInfo();
      setInfo(r);
      setUrl(r.url ?? "");
      setAction(r.action === "force-local" ? "force-local" : "warn");
      setLocalModel(r.localModel ?? "");
      setContextualLlmUrl(r.contextualLlmUrl ?? "");
      setContextualLlmModel(r.contextualLlmModel ?? "");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    // Populate the local-model picker from the same list the model picker
    // uses (resolved per provider mode). Prevents typos like the bare
    // "dsparthagemma" that never matched a loaded pool. Empty list (no
    // engine paired) → the panel falls back to a free-text field.
    // Only local models are valid force-local targets — filtering to
    // origin==="local" makes a cloud id impossible to pick (the leak we're
    // preventing). Older servers omit origin → fall back to the full list.
    api
      .listAllModels()
      .then((r) =>
        setModels(
          r.models
            .filter((m) => m.origin === undefined || m.origin === "local")
            .map((m) => m.id),
        ),
      )
      .catch(() => setModels([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function persist() {
    setBusy("save");
    setErr(null);
    try {
      await api.guardAddonSetConfig({
        url: url.trim(),
        action,
        localModel: localModel.trim(),
        contextualLlmUrl: contextualLlmUrl.trim(),
        contextualLlmModel: contextualLlmModel.trim(),
      });
      setSaved(true);
      await refresh();
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    setBusy("test");
    setErr(null);
    setTestMsg(null);
    try {
      const r = await api.guardAddonTest(testText);
      if (!r.ok) {
        setTestMsg({ ok: false, text: r.error ?? "No response" });
      } else {
        const cats = (r.findings ?? [])
          .map((f) => f.category)
          .join(", ");
        setTestMsg({
          ok: true,
          text: r.sensitive
            ? `Sensitive (${r.maxSeverity}) — ${cats || "no categories"} · ${r.ms ?? 0} ms`
            : `Clean · ${r.ms ?? 0} ms`,
        });
      }
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
          <span className="text-gray-400">Policy</span>{" "}
          <span className="font-mono text-ink">{action}</span>
        </span>
      </div>

      <Field label="Guard service URL">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://guard-host:8084/guard"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          The guard classification endpoint (GLiNER2 PII sidecar), reachable
          from the Companion server (not your browser). The last user message
          is POSTed here as JSON before every send.
        </p>
      </Field>

      <Field label="Policy">
        <select
          value={action}
          onChange={(e) => setAction(e.target.value as "warn" | "force-local")}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-cyan"
        >
          <option value="warn">warn — show a banner, send as chosen</option>
          <option value="force-local">
            force-local — banner + keep the turn on the local engine
          </option>
        </select>
        <p className="mt-2 text-[11px] text-gray-500">
          <strong className="text-ink">warn</strong> only tells you what was
          detected. <strong className="text-ink">force-local</strong>{" "}
          additionally re-routes the flagged turn to your paired engine so the
          sensitive content never reaches a cloud provider. Requires a paired
          engine and a local model id below — otherwise it degrades to warn.
        </p>
      </Field>

      {action === "force-local" && (
        <Field label="Local model">
          {models && models.length > 0 ? (
            <select
              value={models.includes(localModel) ? localModel : ""}
              onChange={(e) => setLocalModel(e.target.value)}
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            >
              <option value="" disabled>
                Select a model served by your engine…
              </option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={localModel}
              onChange={(e) => setLocalModel(e.target.value)}
              placeholder="argo:qwen3.5-122b"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          )}
          <p className="mt-2 text-[11px] text-gray-500">
            Model id served by your local engine that flagged turns are
            re-routed to.{" "}
            {models && models.length === 0 && (
              <span className="text-amber-700">
                No engine models found — pair an engine or type the id
                manually.
              </span>
            )}
          </p>
        </Field>
      )}

      <Field label="Contextual detection (optional)">
        <input
          type="text"
          value={contextualLlmUrl}
          onChange={(e) => setContextualLlmUrl(e.target.value)}
          placeholder="http://your-engine:8000/v1  (empty = stage 2 off)"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <input
          type="text"
          value={contextualLlmModel}
          onChange={(e) => setContextualLlmModel(e.target.value)}
          placeholder="dsparkqwen"
          className="mt-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          A small instruct LLM (OpenAI-compatible) for stage 2 — catches
          contextual confidential content (business secrets, health narrative,
          HR, legal) that the PII pass misses. Relayed to the guard service per
          request; leave empty to run PII detection only. Adds ~1&nbsp;s of
          latency to messages that pass the PII stage.
        </p>
      </Field>

      <Field label="Test">
        <textarea
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
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
        <button
          type="button"
          onClick={onTest}
          disabled={busy !== null || !info.configured || !testText.trim()}
          className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-600 hover:text-ink disabled:opacity-50"
        >
          {busy === "test" ? "Testing…" : "Test classification"}
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
          How the confidential guard works
        </summary>
        <p className="mt-3 leading-relaxed">
          Before your message leaves for the provider, its text is classified
          by a local PII detection model (GLiNER2). If GDPR identifiers,
          health data, financials or credentials are found, a banner appears
          on the reply and — with the{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">force-local</code>{" "}
          policy — the turn is silently kept on your paired local engine
          instead of the selected cloud model. Every detection is written to
          the audit log. If the guard service is down, messages send normally
          (fail-open, no detection).
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
