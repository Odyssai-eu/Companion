import { useEffect, useState } from "react";
import { api } from "~/lib/api";
import { Field } from "./shared";

export function TavilyPanel() {
  type Info = Awaited<ReturnType<typeof api.tavilyInfo>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function refresh() {
    try {
      setInfo(await api.tavilyInfo());
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save() {
    if (!keyInput.trim()) return;
    setBusy("save");
    setErr(null);
    try {
      await api.tavilySetKey(keyInput.trim());
      setSaved(true);
      setKeyInput("");
      await refresh();
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    if (!confirm("Remove the Tavily key? Web access will stop working.")) return;
    setBusy("clear");
    try {
      await api.tavilyClearKey();
      await refresh();
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
            {info.hasKey ? "🔑 Key set" : "✗ no key"}
          </span>
        </span>
      </div>

      <Field label="Tavily API key">
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder={info.hasKey ? "•••• (set — paste a new one to replace)" : "tvly-dev-…"}
            className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
          />
          <button
            type="button"
            onClick={save}
            disabled={busy !== null || !keyInput.trim()}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {busy === "save" ? "Saving…" : saved ? "✓ Saved" : info.hasKey ? "Replace" : "Save"}
          </button>
          {info.hasKey && (
            <button
              type="button"
              onClick={clear}
              disabled={busy !== null}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-600 hover:text-ink"
            >
              Revoke
            </button>
          )}
        </div>
        <p className="mt-2 text-[11px] text-gray-500">
          Get a key at{" "}
          <a
            href="https://app.tavily.com/home"
            target="_blank"
            rel="noopener noreferrer"
            className="text-cyan hover:text-navy"
          >
            app.tavily.com
          </a>
          . The Researcher plan gives 1,000 free credits per month — 1 credit
          per search or extract. Plenty for personal use.
        </p>
      </Field>

      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How web access works
        </summary>
        <p className="mt-3 leading-relaxed">
          When this add-on is enabled and a key is set, the assistant gets two
          tools it can call on its own initiative:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            <code className="rounded bg-gray-100 px-1 font-mono">web_search(query)</code>{" "}
            — Tavily's LLM-tuned search engine. Returns snippets + sources.
          </li>
          <li>
            <code className="rounded bg-gray-100 px-1 font-mono">web_fetch(url)</code>{" "}
            — Pull a single page's clean text (Markdown).
          </li>
        </ul>
        <p className="mt-3">
          The model decides when to use them. You'll see "🔍 Searching…" inline
          in the chat when it does.
        </p>
      </details>

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
          {err}
        </div>
      )}
    </div>
  );
}
