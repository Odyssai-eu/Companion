import { useEffect, useState } from "react";
import { api, AUTO_ROUTER_MODEL_ID, type ApiGlobalModel } from "~/lib/api";
import ModelDropdown from "~/components/chat/ModelDropdown";
import { Field } from "./shared";

// ── Auto Router add-on ────────────────────────────────────────────────────
//
// Picks chat / deep / code automatically by embedding the user's last
// message and comparing it against per-bucket centroids. The embedding
// service can run anywhere the user hosts an OpenAI-compatible
// embeddings endpoint. The user supplies the URL + the three target
// model ids. Anchors are rebuilt whenever the URL changes.

export function RouterPanel() {
  type Info = Awaited<ReturnType<typeof api.routerInfo>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [policy, setPolicy] = useState<{ chat: string; deep: string; code: string }>({
    chat: "",
    deep: "",
    code: "",
  });
  // Model that answers when routing itself can't run. "" = none, which
  // restores the fail-loud behaviour (error, no answer).
  const [fallbackModel, setFallbackModel] = useState("");
  // Model catalog drives the per-bucket pickers AND the fallback picker.
  // Whatever the engine lists is offered as-is — no allow-list, no
  // curation. That's how a router-style virtual model such as CoeOS shows
  // up in the Deep / Code buckets the moment the user's engine advertises
  // it. The ONLY exclusion is the "auto" sentinel itself, because binding
  // a bucket to Auto would loop the router back into itself.
  const [models, setModels] = useState<ApiGlobalModel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Quick-test box
  const [testInput, setTestInput] = useState("");
  const [testResult, setTestResult] = useState<
    Awaited<ReturnType<typeof api.routerTest>> | null
  >(null);

  async function refresh() {
    try {
      const r = await api.routerInfo();
      setInfo(r);
      setUrlInput(r.embeddingsUrl || r.embeddingsUrlDefault);
      setPolicy(r.policy);
      setFallbackModel(r.fallbackModel ?? "");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function refreshModels() {
    try {
      const r = await api.listAllModels();
      setModels(r.models.filter((m) => m.id !== AUTO_ROUTER_MODEL_ID));
    } catch {
      // Non-fatal — the picker will render with an empty list + the
      // standard "No models" hint. The router itself doesn't depend on
      // the picker working to function.
    }
  }

  useEffect(() => {
    refresh();
    refreshModels();
  }, []);

  async function save(rebuildAnchors = false) {
    setBusy(rebuildAnchors ? "rebuild" : "save");
    setErr(null);
    try {
      await api.routerSetConfig({
        embeddingsUrl: urlInput.trim() || undefined,
        policy,
        fallbackModel: fallbackModel.trim() || null,
        rebuildAnchors,
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

  async function rebuild() {
    setBusy("rebuild");
    setErr(null);
    try {
      await api.routerRebuild();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runTest() {
    if (!testInput.trim()) return;
    setBusy("test");
    setErr(null);
    setTestResult(null);
    try {
      setTestResult(await api.routerTest(testInput.trim()));
    } catch (e) {
      setErr((e as Error).message);
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
            {info.configured ? "✓ ready" : "✗ not configured"}
          </span>
        </span>
        {info.anchorsBuiltAt && (
          <span>
            <span className="text-gray-400">Anchors built</span>{" "}
            <span className="font-mono text-ink">
              {new Date(info.anchorsBuiltAt).toLocaleString()}
            </span>
          </span>
        )}
      </div>

      <Field label="Embedding service URL">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={info.embeddingsUrlDefault || "https://your-embedding-host/v1/embeddings"}
            className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
          />
          <button
            type="button"
            onClick={() => save(true)}
            disabled={busy !== null || !urlInput.trim()}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {busy === "rebuild"
              ? "Building…"
              : saved
                ? "✓ Saved"
                : info.configured
                  ? "Update + rebuild"
                  : "Save + build anchors"}
          </button>
        </div>
        <p className="mt-2 text-[11px] text-gray-500">
          Any OpenAI-compatible embeddings endpoint works (small models
          are fine — we recommend something around 0.5B–1B params for
          sub-10ms latency). Saving with a new URL rebuilds the anchor
          centroids so they match the new embedding space.
        </p>
      </Field>

      <Field label="Model per bucket">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">
              Chat
            </span>
            <ModelDropdown
              value={policy.chat}
              onChange={(id) => setPolicy((p) => ({ ...p, chat: id }))}
              models={models}
              includeAuto={false}
              fullWidth
              placeholder={info.policyDefault.chat || "Pick a model"}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">
              Deep
            </span>
            <ModelDropdown
              value={policy.deep}
              onChange={(id) => setPolicy((p) => ({ ...p, deep: id }))}
              models={models}
              includeAuto={false}
              fullWidth
              placeholder={info.policyDefault.deep || "Pick a model"}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-gray-500">
              Code
            </span>
            <ModelDropdown
              value={policy.code}
              onChange={(id) => setPolicy((p) => ({ ...p, code: id }))}
              models={models}
              includeAuto={false}
              fullWidth
              placeholder={info.policyDefault.code || "Pick a model"}
            />
          </div>
        </div>
        <p className="mt-2 text-[11px] text-gray-500">
          Three intents, three models. <strong>Chat</strong> = small talk
          and quick replies. <strong>Deep</strong> = analysis, comparisons,
          longer reasoning. <strong>Code</strong> = write, refactor, debug.
          Use any model id your inference engine exposes — including
          router-style models such as CoeOS, which show up here as soon as
          your engine advertises them.
        </p>
      </Field>

      {/* Fallback — the answer path when routing itself can't run. Same
          picker component as the buckets so the UX is identical. */}
      <Field label="Fallback model">
        <div className="sm:max-w-[50%]">
          <ModelDropdown
            value={fallbackModel}
            onChange={setFallbackModel}
            models={models}
            includeAuto={false}
            fullWidth
            placeholder="None — fail with an error"
          />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => save(false)}
            disabled={busy !== null}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {/* Saves buckets AND fallback — both live in the same config
                blob, so one button covers the two fields above. */}
            {busy === "save" ? "Saving…" : "Save routing config"}
          </button>
          <button
            type="button"
            onClick={rebuild}
            disabled={busy !== null || !info.configured}
            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-600 hover:text-ink disabled:opacity-50"
          >
            Rebuild anchors
          </button>
          {fallbackModel && (
            <button
              type="button"
              onClick={() => setFallbackModel("")}
              disabled={busy !== null}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-600 hover:text-ink disabled:opacity-50"
            >
              Clear fallback
            </button>
          )}
        </div>
        <p className="mt-2 text-[11px] text-gray-500">
          Answers when the router <em>itself</em> can't run — embedding
          service unreachable, anchors never built, add-on switched off.
          The chat still shows you the routing error; the reply just comes
          from this model instead of dying. Leave it empty to keep the
          strict behaviour: an error and no answer at all.
        </p>
      </Field>

      <Field label="Quick test">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
            placeholder="Type a sample message — e.g. 'écris-moi un poème'"
            className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            onKeyDown={(e) => {
              if (e.key === "Enter") runTest();
            }}
          />
          <button
            type="button"
            onClick={runTest}
            disabled={busy !== null || !testInput.trim() || !info.configured}
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-600 hover:text-ink disabled:opacity-50"
          >
            {busy === "test" ? "Routing…" : "Test"}
          </button>
        </div>
        {testResult && (
          <div className="mt-3 rounded-md border border-gray-200 bg-white px-4 py-3 font-mono text-[12px] text-gray-700">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                <span className="text-gray-400">Label</span>{" "}
                <span className="text-ink">{testResult.label}</span>
              </span>
              <span>
                <span className="text-gray-400">→ Model</span>{" "}
                <span className="text-ink">{testResult.model}</span>
              </span>
              <span>
                <span className="text-gray-400">Score</span>{" "}
                <span className="text-ink">{testResult.score.toFixed(3)}</span>
              </span>
              <span>
                <span className="text-gray-400">Latency</span>{" "}
                <span className="text-ink">{testResult.ms}ms</span>
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-gray-500">
              <span>chat={testResult.scores.chat.toFixed(2)}</span>
              <span>deep={testResult.scores.deep.toFixed(2)}</span>
              <span>code={testResult.scores.code.toFixed(2)}</span>
            </div>
          </div>
        )}
      </Field>

      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How auto-routing works
        </summary>
        <p className="mt-3 leading-relaxed">
          When you pick <strong>Auto</strong> in the model picker, every
          message goes through a small embedding model that compares your
          text to a dozen reference sentences per bucket: conversation,
          deep analysis, or code. The closest bucket wins, and we
          dispatch to the model you set above.
        </p>
        <p className="mt-2 leading-relaxed">
          The embedding service is opt-in and runs wherever you choose —
          locally, in your own cluster, or via a cloud provider that
          exposes an OpenAI-compatible embeddings endpoint. If it goes
          down, the chat shows you the error rather than guessing silently,
          and — if you set a <strong>fallback model</strong> above — still
          answers using it. With no fallback set, the turn fails outright.
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
