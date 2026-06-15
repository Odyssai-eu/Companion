import { useEffect, useState } from "react";
import { api } from "~/lib/api";
import { copyToClipboard } from "~/lib/clipboard";
import { Field } from "./shared";

export function ObsidianPanel() {
  type Info = Awaited<ReturnType<typeof api.obsidianInfo>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<"url" | "token" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      setInfo(await api.obsidianInfo());
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
    // Refresh after a sync (when user manually downloads or plugin polls).
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  async function rotate() {
    setBusy("rotate");
    setErr(null);
    try {
      const { token } = await api.obsidianRotateToken();
      setToken(token);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function clearToken() {
    if (!confirm("Revoke the sync token? Your Obsidian plugin will stop syncing.")) return;
    setBusy("clear");
    setErr(null);
    try {
      await api.obsidianClearToken();
      setToken(null);
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function copyText(value: string, kind: "url" | "token") {
    const ok = await copyToClipboard(value);
    if (!ok) return;
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  function downloadNow() {
    window.location.href = "/api/addons/obsidian/vault.zip";
  }

  if (!info) {
    return (
      <span className="font-mono text-[11px] text-gray-400">Loading…</span>
    );
  }

  const fullVaultUrl = new URL(info.vaultUrl, window.location.origin).toString();

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[12px] text-gray-600">
        <span>
          <span className="text-gray-400">Articles</span>{" "}
          <span className="font-mono text-ink">{info.articleCount}</span>
        </span>
        <span>
          <span className="text-gray-400">Last synced</span>{" "}
          <span className="font-mono text-ink">
            {info.lastSyncedAt
              ? new Date(info.lastSyncedAt).toLocaleString()
              : "never"}
          </span>
        </span>
      </div>

      <Field label="Vault URL">
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink">
            {fullVaultUrl}
          </code>
          <button
            type="button"
            onClick={() => copyText(fullVaultUrl, "url")}
            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600 hover:bg-gray-100 hover:text-ink"
          >
            {copied === "url" ? "Copied!" : "Copy"}
          </button>
        </div>
      </Field>

      <Field label="Sync token">
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink">
            {token
              ? token
              : info.hasToken
                ? "•".repeat(20) + " (hidden — generate a new one to see it)"
                : "(not generated yet)"}
          </code>
          {token && (
            <button
              type="button"
              onClick={() => copyText(token, "token")}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600 hover:bg-gray-100 hover:text-ink"
            >
              {copied === "token" ? "Copied!" : "Copy"}
            </button>
          )}
        </div>
        <p className="mt-2 text-[11px] text-gray-500">
          Paste this in the Companion plugin inside Obsidian. Treat it like a
          password — anyone with the URL + token can download your wiki.
        </p>
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={rotate}
          disabled={busy !== null}
          className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
        >
          {info.hasToken ? "Generate new token" : "Generate token"}
        </button>
        {info.hasToken && (
          <button
            type="button"
            onClick={clearToken}
            disabled={busy !== null}
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-600 hover:text-ink disabled:opacity-50"
          >
            Revoke
          </button>
        )}
        <button
          type="button"
          onClick={downloadNow}
          className="ml-auto rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] text-gray-600 hover:text-ink"
        >
          Download vault now (.zip)
        </button>
      </div>

      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How to set up the Obsidian plugin
        </summary>
        <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5">
          <li>
            Download the latest release of the Companion plugin from the
            companion repo.
          </li>
          <li>
            In Obsidian, open <strong>Settings → Community plugins → Browse</strong> and
            sideload (or copy the plugin into{" "}
            <code className="rounded bg-gray-100 px-1 font-mono">
              {"<vault>/.obsidian/plugins/companion/"}
            </code>
            ).
          </li>
          <li>Enable the plugin.</li>
          <li>
            Open its settings, paste the <strong>Vault URL</strong> and{" "}
            <strong>Sync token</strong> from above, choose a target subfolder, save.
          </li>
          <li>
            The plugin syncs on startup and every 30 minutes. You can trigger a
            manual sync from the command palette (<code>Companion: Sync now</code>).
          </li>
        </ol>
      </details>

      {err && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
          {err}
        </div>
      )}
    </div>
  );
}
