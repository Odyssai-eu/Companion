import { useEffect, useMemo, useState } from "react";
import { api } from "~/lib/api";

type Token = Awaited<ReturnType<typeof api.listHermesTokens>>[number];

const TTL_PRESETS: Array<{ label: string; ttlMs: number | null }> = [
  { label: "24 hours", ttlMs: 24 * 60 * 60 * 1000 },
  { label: "30 days", ttlMs: 30 * 24 * 60 * 60 * 1000 },
  { label: "90 days", ttlMs: 90 * 24 * 60 * 60 * 1000 },
  { label: "No expiry", ttlMs: null },
];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function isExpired(t: Token): boolean {
  if (!t.expiresAt) return false;
  return new Date(t.expiresAt).getTime() < Date.now();
}

function statusOf(t: Token): "active" | "expired" | "revoked" {
  if (t.revokedAt) return "revoked";
  if (isExpired(t)) return "expired";
  return "active";
}

export default function ExternalAgentsPage() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Mint form
  const [label, setLabel] = useState("");
  const [ttlMs, setTtlMs] = useState<number | null>(
    TTL_PRESETS[1]?.ttlMs ?? null,
  );

  // One-shot reveal: when a token is just minted, we keep its plaintext
  // in this state so the user can copy it. Once they dismiss the modal,
  // the plain token is wiped and never recoverable.
  const [revealed, setRevealed] = useState<{
    token: string;
    label: string | null;
    baseUrl: string;
  } | null>(null);

  async function refresh() {
    try {
      setTokens(await api.listHermesTokens());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function mint() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.mintHermesToken({
        label: label.trim() || undefined,
        ttlMs,
        source: "cowork",
      });
      setRevealed({
        token: r.token,
        label: r.label,
        baseUrl: window.location.origin,
      });
      setLabel("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this token? Any MCP client using it will lose access immediately.")) {
      return;
    }
    setBusy(true);
    try {
      await api.revokeHermesToken(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(
    () => (tokens ?? []).filter((t) => !t.revokedAt),
    [tokens],
  );

  return (
    <div className="flex flex-col gap-8 p-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-[28px] font-light text-navy">
          Agents tokens
        </h1>
        <p className="max-w-[640px] text-[13px] leading-relaxed text-gray-600">
          Generate a token to let an external MCP client — Claude Cowork
          dispatch, Hermes Agent, Claude Desktop, Continue.dev — call back
          into Companion as you. The client gets read/write access to your
          projects, conversations, and inference. (Renamed from "External
          agents" 2026-05-19: the page is just tokens, no more no less.)
        </p>
        <div className="mt-2 rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-[12px] text-gray-700">
          <div className="mb-1 font-sans text-[11px] tracking-wider text-gray-400 uppercase">
            MCP endpoint
          </div>
          <code>{window.location.origin}/api/mcp</code>
        </div>
      </header>

      {/* Mint form */}
      <section className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="font-display text-[18px] font-light text-navy">
          Generate a new token
        </h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-[11px] tracking-wider text-gray-500 uppercase">
              Label
            </span>
            <input
              type="text"
              placeholder="e.g. cowork-laptop"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2 text-[13px] focus:border-cyan-500 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] tracking-wider text-gray-500 uppercase">
              Expires
            </span>
            <select
              value={
                TTL_PRESETS.findIndex((p) => p.ttlMs === ttlMs).toString() ??
                "1"
              }
              onChange={(e) => {
                const i = Number(e.target.value);
                setTtlMs(TTL_PRESETS[i]?.ttlMs ?? null);
              }}
              className="rounded-md border border-gray-300 px-3 py-2 text-[13px] focus:border-cyan-500 focus:outline-none"
            >
              {TTL_PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={mint}
            disabled={busy}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[#1a3f63] disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate token"}
          </button>
        </div>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {error}
          </div>
        )}
      </section>

      {/* Token list */}
      <section className="flex flex-col gap-2">
        <h2 className="font-display text-[18px] font-light text-navy">
          Active tokens
        </h2>
        {tokens === null && (
          <div className="text-[13px] text-gray-500">Loading…</div>
        )}
        {tokens && visible.length === 0 && (
          <div className="rounded-md border border-dashed border-gray-300 px-4 py-6 text-center text-[13px] text-gray-500">
            No active tokens. Generate one above to connect an external agent.
          </div>
        )}
        {visible.length > 0 && (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50 text-left text-[11px] tracking-wider text-gray-500 uppercase">
                  <th className="px-4 py-2 font-medium">Label</th>
                  <th className="px-4 py-2 font-medium">Source</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2 font-medium">Last used</th>
                  <th className="px-4 py-2 font-medium">Expires</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => {
                  const st = statusOf(t);
                  return (
                    <tr key={t.id} className="border-b border-gray-100 last:border-b-0">
                      <td className="px-4 py-2">{t.label ?? <span className="text-gray-400">—</span>}</td>
                      <td className="px-4 py-2 text-gray-600">{t.source}</td>
                      <td className="px-4 py-2 text-gray-600">{formatDate(t.createdAt)}</td>
                      <td className="px-4 py-2 text-gray-600">{formatDate(t.lastUsedAt)}</td>
                      <td className="px-4 py-2 text-gray-600">{formatDate(t.expiresAt)}</td>
                      <td className="px-4 py-2">
                        <span
                          className={
                            st === "active"
                              ? "text-green-600"
                              : st === "expired"
                                ? "text-gray-400"
                                : "text-red-600"
                          }
                        >
                          {st}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => revoke(t.id)}
                          disabled={busy}
                          className="text-[12px] text-red-600 hover:underline disabled:opacity-50"
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {revealed && (
        <RevealModal
          revealed={revealed}
          onClose={() => setRevealed(null)}
        />
      )}
    </div>
  );
}

function RevealModal(props: {
  revealed: { token: string; label: string | null; baseUrl: string };
  onClose: () => void;
}) {
  const { token, label, baseUrl } = props.revealed;
  const [copied, setCopied] = useState<"token" | "cowork" | "url" | null>(null);

  const coworkConfig = `{
  "mcpServers": {
    "companion": {
      "url": "${baseUrl}/api/mcp",
      "headers": {
        "Authorization": "Bearer ${token}"
      }
    }
  }
}`;

  function copy(what: "token" | "cowork" | "url", text: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-[640px] flex-col gap-5 rounded-lg bg-white p-6 shadow-xl">
        <header>
          <h2 className="font-display text-[20px] font-light text-navy">
            Token generated
          </h2>
          <p className="mt-1 text-[12px] text-gray-600">
            Copy the token now — it won't be shown again. If you lose it,
            revoke and generate a new one.
          </p>
        </header>

        <div className="flex flex-col gap-1">
          <div className="text-[11px] tracking-wider text-gray-500 uppercase">
            {label ? `Token (${label})` : "Token"}
          </div>
          <div className="flex items-stretch gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-[12px]">
              {token}
            </code>
            <button
              type="button"
              onClick={() => copy("token", token)}
              className="rounded-md bg-cyan-500 px-3 py-2 text-[12px] font-medium text-white hover:bg-cyan-600"
            >
              {copied === "token" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-[11px] tracking-wider text-gray-500 uppercase">
            MCP endpoint URL
          </div>
          <div className="flex items-stretch gap-2">
            <code className="flex-1 overflow-x-auto rounded-md border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-[12px]">
              {baseUrl}/api/mcp
            </code>
            <button
              type="button"
              onClick={() => copy("url", `${baseUrl}/api/mcp`)}
              className="rounded-md border border-gray-300 px-3 py-2 text-[12px] font-medium text-gray-700 hover:bg-gray-50"
            >
              {copied === "url" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="text-[11px] tracking-wider text-gray-500 uppercase">
            Ready-to-paste config (Cowork / Claude Desktop / Continue.dev)
          </div>
          <div className="relative">
            <pre className="max-h-[200px] overflow-auto rounded-md border border-gray-300 bg-gray-50 p-3 font-mono text-[11px] leading-relaxed">
              {coworkConfig}
            </pre>
            <button
              type="button"
              onClick={() => copy("cowork", coworkConfig)}
              className="absolute top-2 right-2 rounded-md bg-white border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
            >
              {copied === "cowork" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <footer className="flex justify-end">
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:bg-[#1a3f63]"
          >
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
