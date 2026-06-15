import { useEffect, useState } from "react";
import { Field } from "./shared";

// ── Hermes / Pi bridge add-ons ────────────────────────────────────────────
//
// Both add-ons point Companion at an HTTP "bridge" the user runs on their
// own machine (the hermes ACP bridge / thecompai-pi-bridge wrapping the Pi
// CLI). The endpoint is per-user config stored on the addons row — never
// hardcoded — so every operator wires their own host + token here. Pi adds
// a default working directory the agent starts in.

export type BridgeInfo = {
  enabled: boolean;
  configured: boolean;
  bridgeUrl: string;
  hasToken: boolean;
  cwd?: string;
};

export type BridgeConfigBody = {
  enabled?: boolean;
  bridgeUrl?: string;
  bridgeToken?: string | null;
  cwd?: string | null;
};

export type ProbeResult = {
  ok: boolean;
  health?: unknown;
  error?: string;
  status?: number;
};

export function BridgeAddonPanel({
  urlPlaceholder,
  withCwd = false,
  load,
  save,
  probe,
  children,
}: {
  urlPlaceholder: string;
  withCwd?: boolean;
  load: () => Promise<BridgeInfo>;
  save: (body: BridgeConfigBody) => Promise<unknown>;
  probe: () => Promise<ProbeResult>;
  children?: React.ReactNode;
}) {
  const [info, setInfo] = useState<BridgeInfo | null>(null);
  const [url, setUrl] = useState("");
  const [cwd, setCwd] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenDirty, setTokenDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [probeMsg, setProbeMsg] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function refresh() {
    try {
      const r = await load();
      setInfo(r);
      setUrl(r.bridgeUrl ?? "");
      setCwd(r.cwd ?? "");
      setTokenDraft("");
      setTokenDirty(false);
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
      const body: BridgeConfigBody = { bridgeUrl: url.trim() };
      if (tokenDirty) body.bridgeToken = tokenDraft.trim() || null;
      if (withCwd) body.cwd = cwd.trim() || null;
      await save(body);
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
      const r = await probe();
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
          <span className="text-gray-400">Token</span>{" "}
          <span className="font-mono text-ink">
            {info.hasToken ? "set" : "none"}
          </span>
        </span>
      </div>

      <Field label="Bridge URL">
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={urlPlaceholder}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          The HTTP endpoint where your bridge listens, e.g.{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">
            {urlPlaceholder}
          </code>
          . Reachable from the Companion server, not your browser.
        </p>
      </Field>

      <Field label="Bridge token (optional)">
        <input
          type="password"
          value={tokenDraft}
          onChange={(e) => {
            setTokenDraft(e.target.value);
            setTokenDirty(true);
          }}
          placeholder={info.hasToken ? "•••• (set — paste a new one to replace)" : "shared secret"}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
        <p className="mt-2 text-[11px] text-gray-500">
          Must match the API key the bridge expects. Leave blank to keep the
          current one.
        </p>
      </Field>

      {withCwd && (
        <Field label="Working directory">
          <input
            type="text"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/Users/you/projects"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
          />
          <p className="mt-2 text-[11px] text-gray-500">
            Directory the agent starts in on the bridge host. Leave blank for
            the bridge's default.
          </p>
        </Field>
      )}

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

      {children}

      {err && (
        <div className="rounded-md border border-red-100 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
          {err}
        </div>
      )}
    </div>
  );
}
