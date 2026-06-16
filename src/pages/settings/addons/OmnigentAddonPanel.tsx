import { useEffect, useState } from "react";
import { api } from "~/lib/api";
import { Field } from "./shared";

// ── Omnigent add-on panel ──────────────────────────────────────────────────
//
// Bidirectional bridge client. Unlike the Hermes / Pi panels (which reuse the
// generic BridgeAddonPanel: just URL + token + cwd), Omnigent carries two
// extra dimensions the agent needs:
//   - enabledAgents  : which Omnigent agents the model may delegate to.
//   - enabledTools   : which of Companion's OWN tools the agent may call back
//                      into via the reverse channel (the "deux sens").
// We mirror BridgeAddonPanel's structure (status row, Field wrappers, Save /
// Test-connection buttons, error box) and add multi-selects for those two.

/** Built-in Companion tools the agent can be allowed to call back into.
 *  Mirrors the server-side tool registry (server/lib/tools.ts). MCP / skill
 *  tools are per-user + dynamic, so they're entered free-form below; this is
 *  the stable built-in set surfaced as checkboxes. */
const COMPANION_TOOLS: Array<{ name: string; label: string }> = [
  { name: "web_search", label: "web_search — search the web" },
  { name: "web_read", label: "web_read — fetch a URL (paginated)" },
  { name: "web_read_full", label: "web_read_full — fetch a URL (full)" },
  { name: "fs_list", label: "fs_list — list workspace files" },
  { name: "fs_read", label: "fs_read — read a workspace file" },
  { name: "fs_write", label: "fs_write — write a workspace file" },
  { name: "fs_edit", label: "fs_edit — edit a workspace file" },
  { name: "rag_search", label: "rag_search — search the knowledge base" },
  { name: "bash", label: "bash — run a sandboxed shell command" },
];

type OmnigentInfo = {
  enabled: boolean;
  configured: boolean;
  serverUrl: string;
  defaultAgent: string;
  enabledAgents: string[];
  enabledTools: string[];
  hasApiKey: boolean;
};

export function OmnigentAddonPanel() {
  const [info, setInfo] = useState<OmnigentInfo | null>(null);
  const [url, setUrl] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);
  const [defaultAgent, setDefaultAgent] = useState("");
  const [agentsText, setAgentsText] = useState("");
  const [tools, setTools] = useState<Set<string>>(new Set());
  const [extraTools, setExtraTools] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function refresh() {
    try {
      const r = await api.omnigentAddonInfo();
      setInfo(r);
      setUrl(r.serverUrl ?? "");
      setDefaultAgent(r.defaultAgent ?? "");
      setAgentsText((r.enabledAgents ?? []).join(", "));
      const known = new Set(COMPANION_TOOLS.map((t) => t.name));
      setTools(new Set((r.enabledTools ?? []).filter((t) => known.has(t))));
      setExtraTools(
        (r.enabledTools ?? []).filter((t) => !known.has(t)).join(", "),
      );
      setKeyDraft("");
      setKeyDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleTool(name: string) {
    setTools((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function splitTokens(s: string): string[] {
    return s
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  async function persist() {
    setBusy("save");
    setErr(null);
    try {
      const enabledTools = [...tools, ...splitTokens(extraTools)];
      const body: Parameters<typeof api.omnigentAddonSetConfig>[0] = {
        serverUrl: url.trim(),
        defaultAgent: defaultAgent.trim() || null,
        enabledAgents: splitTokens(agentsText),
        enabledTools,
      };
      if (keyDirty) body.apiKey = keyDraft.trim() || null;
      await api.omnigentAddonSetConfig(body);
      setSaved(true);
      await refresh();
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function runProbe() {
    setBusy("probe");
    setErr(null);
    setProbeMsg(null);
    try {
      const r = await api.omnigentAddonProbe();
      setProbeMsg(
        r.ok
          ? { ok: true, text: "Bridge reachable — /health OK" }
          : {
              ok: false,
              text:
                r.error ??
                (r.status ? `Bridge returned HTTP ${r.status}` : "No response"),
            },
      );
    } catch (e) {
      setProbeMsg({ ok: false, text: (e as Error).message });
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
          <span className="text-gray-400">API key</span>{" "}
          <span className="font-mono text-ink">
            {info.hasApiKey ? "set" : "none"}
          </span>
        </span>
      </div>

      <Field label="Bridge URL">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.86.50:8010"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          The thecompai-omnigent-bridge HTTP endpoint, reachable from the
          Companion server (not your browser).
        </p>
      </Field>

      <Field label="API key (optional)">
        <input
          type="password"
          value={keyDraft}
          onChange={(e) => {
            setKeyDraft(e.target.value);
            setKeyDirty(true);
          }}
          placeholder={
            info.hasApiKey ? "•••• (set — paste a new one to replace)" : "Bearer token the bridge expects"
          }
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          Sent as <code className="rounded bg-gray-100 px-1 font-mono">Authorization: Bearer …</code>{" "}
          to the bridge. Leave blank to keep the current one.
        </p>
      </Field>

      <Field label="Default agent">
        <input
          type="text"
          value={defaultAgent}
          onChange={(e) => setDefaultAgent(e.target.value)}
          placeholder="e.g. researcher"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          Used by <code className="rounded bg-gray-100 px-1 font-mono">omnigent_run</code>{" "}
          when the model doesn't name an agent.
        </p>
      </Field>

      <Field label="Enabled agents">
        <input
          type="text"
          value={agentsText}
          onChange={(e) => setAgentsText(e.target.value)}
          placeholder="researcher, coder, reviewer"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          Comma-separated agent names the bridge exposes. Surfaced to the model
          so it knows which agents it can delegate to.
        </p>
      </Field>

      <Field label="Companion tools the agent may call back into">
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {COMPANION_TOOLS.map((t) => (
            <label
              key={t.name}
              className="flex items-center gap-2 text-[12px] text-gray-700"
            >
              <input
                type="checkbox"
                checked={tools.has(t.name)}
                onChange={() => toggleTool(t.name)}
                className="h-3.5 w-3.5 rounded border-gray-300 text-navy focus:ring-cyan"
              />
              <span className="font-mono">{t.label}</span>
            </label>
          ))}
        </div>
        <input
          type="text"
          value={extraTools}
          onChange={(e) => setExtraTools(e.target.value)}
          placeholder="mcp_notion_search, skill_get  (extra tool names, comma-separated)"
          className="mt-2 w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[11px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          These tools are offered to the Omnigent agent over the reverse
          channel — it can invoke them and Companion runs them in your context.
          Add MCP / skill tool names in the free-form box. Leave everything
          unchecked to keep the agent one-way (no callback).
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
        <button
          type="button"
          onClick={runProbe}
          disabled={busy !== null || !info.configured}
          className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-600 hover:text-ink disabled:opacity-50"
        >
          {busy === "probe" ? "Probing…" : "Test connection"}
        </button>
        {probeMsg && (
          <span
            className={`font-mono text-[11px] ${probeMsg.ok ? "text-emerald-700" : "text-red-700"}`}
          >
            {probeMsg.ok ? "● " : "✗ "}
            {probeMsg.text}
          </span>
        )}
      </div>

      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How the Omnigent bridge works (both directions)
        </summary>
        <p className="mt-3 leading-relaxed">
          With this add-on on, the chat model gains{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">omnigent_run</code>,{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">omnigent_orchestrate</code>, and{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">omnigent_status</code>{" "}
          tools. It can hand a task to an Omnigent agent on the bridge (the
          down path). While the agent works, it can call back into the
          Companion tools you checked above (the up path) — Companion runs them
          in your context and returns the result to the agent.
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
