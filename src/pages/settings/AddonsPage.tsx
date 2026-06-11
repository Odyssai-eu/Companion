import { useEffect, useMemo, useState } from "react";
import { useIsMobile } from "~/hooks/useIsMobile";
import {
  api,
  type ApiAddon,
  type ApiGlobalModel,
  type ApiInferenceSettings,
} from "~/lib/api";
import { copyToClipboard } from "~/lib/clipboard";
import ModelDropdown from "~/components/chat/ModelDropdown";

/** UI relabel hook (kept for future renames without touching DB rows). */
function displayName(dbName: string): string {
  return dbName;
}

function displayDescription(_dbName: string): string | null {
  return null;
}

/** Add-on DB rows that the page deliberately hides. "Web Search" is the
 *  built-in Tavily plugin — superseded by the Tavily MCP server, so we no
 *  longer surface its card here (2026-05-30). */
const HIDDEN_ADDON_NAMES = new Set(["Web Search"]);

export default function AddonsPage() {
  const [addons, setAddons] = useState<ApiAddon[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());

  async function refresh() {
    try {
      const r = await api.listAddons();
      setAddons(r.addons);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    // Ensure all "lazy-init" add-ons have their DB row before listing. Each
    // `*Info()` call hits a route whose handler calls findOrInit, so the
    // row gets created on first visit. This is a no-op once the rows exist.
    // Add new add-on info-pings here whenever you ship one.
    (async () => {
      try {
        await Promise.all([
          api.routerInfo().catch(() => undefined),
          api.voiceLiveInfo().catch(() => undefined),
          api.hermesAddonInfo().catch(() => undefined),
          api.piAddonInfo().catch(() => undefined),
        ]);
      } catch {
        /* ignore — best-effort */
      }
      await refresh();
    })();
  }, []);

  const visible = useMemo(
    () => (addons ?? []).filter((a) => !HIDDEN_ADDON_NAMES.has(a.name)),
    [addons],
  );

  async function toggle(addon: ApiAddon) {
    setPending((s) => new Set(s).add(addon.id));
    try {
      const { addon: updated } = await api.updateAddon(addon.id, {
        enabled: !addon.enabled,
      });
      setAddons((prev) =>
        prev ? prev.map((a) => (a.id === updated.id ? updated : a)) : prev,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending((s) => {
        const next = new Set(s);
        next.delete(addon.id);
        return next;
      });
    }
  }

  const core = visible.filter((a) => a.kind === "core");
  const installed = visible.filter((a) => a.kind !== "core");

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Extensions
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Add-ons.
        </h1>
        <p className="max-w-[640px] text-[15px] leading-[24px] text-gray-600">
          Plugins, agents, and MCP servers you can switch on. Each add-on
          can surface in the Tools menu and carry its own configuration
          panel below.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 font-mono text-[12px] text-red-700">
          {error}
        </div>
      )}
      {!addons && !error && (
        <div className="rounded-xl border border-gray-200 bg-white py-10 text-center">
          <span className="font-mono text-[11px] text-gray-400">Loading…</span>
        </div>
      )}

      {/* LiteLLM add-on — backed by users.litellm* fields, not by an addons
       *  row. Lives here (per UX brief 2026-05-19) because it's an optional
       *  routing layer that the user adds or removes from their chain, just
       *  like the DB-backed plugins/MCP entries below. */}
      <LiteLLMAddon />

      {core.length > 0 && (
        <Group
          title="Core"
          subtitle="Built-in modules. Activate what you need."
        >
          {core.map((a) => (
            <AddonCard
              key={a.id}
              addon={a}
              pending={pending.has(a.id)}
              onToggle={() => toggle(a)}
            />
          ))}
        </Group>
      )}

      {installed.length > 0 && (
        <section className="flex flex-col gap-2.5">
          {installed.map((a) => (
            <AddonCard
              key={a.id}
              addon={a}
              pending={pending.has(a.id)}
              onToggle={() => toggle(a)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function Group({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <span className="font-display text-[22px] font-light text-navy">
          {title}
        </span>
        <span className="text-[13px] text-gray-400">{subtitle}</span>
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

function AddonCard({
  addon,
  pending,
  onToggle,
}: {
  addon: ApiAddon;
  pending: boolean;
  onToggle: () => void;
}) {
  const isMobile = useIsMobile();
  // Mobile hides the per-addon advanced panels — these are admin/infra
  // surfaces, desktop only, mirroring ExoScopy's filter pattern.
  const hasPanel =
    !isMobile &&
    (addon.name === "Obsidian" ||
      addon.name === "Web Search" ||
      addon.name === "Voice" ||
      addon.name === "Voice (Gemini Live)" ||
      addon.name === "Auto Router" ||
      addon.name === "Hermes Agent" ||
      addon.name === "Pi Agent");

  return (
    <div className="flex flex-col gap-0 rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-5 px-6 py-5">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-[rgba(79,179,217,0.12)]">
          <PackageIcon />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-medium text-ink">
              {displayName(addon.name)}
            </span>
            <KindBadge kind={addon.kind} />
            {addon.version && (
              <span className="font-mono text-[11px] text-gray-400">
                v{addon.version}
              </span>
            )}
          </div>
          {(displayDescription(addon.name) ?? addon.description) && (
            <span className="text-[13px] leading-[20px] text-gray-600">
              {displayDescription(addon.name) ?? addon.description}
            </span>
          )}
        </div>
        <StatusPill enabled={addon.enabled} />
        <Toggle value={addon.enabled} onClick={onToggle} pending={pending} />
      </div>
      {hasPanel && addon.enabled && (
        <div className="border-t border-gray-200 bg-gray-50/60 px-6 py-5">
          {addon.name === "Obsidian" && <ObsidianPanel />}
          {addon.name === "Web Search" && <TavilyPanel />}
          {(addon.name === "Voice" || addon.name === "Voice (Gemini Live)") && (
            <VoiceLivePanel />
          )}
          {addon.name === "Auto Router" && <RouterPanel />}
          {addon.name === "Hermes Agent" && <HermesAddonPanel />}
          {addon.name === "Pi Agent" && <PiAddonPanel />}
        </div>
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: ApiAddon["kind"] }) {
  const label = kind === "core" ? "Core" : kind === "mcp" ? "MCP" : "Plugin";
  return (
    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
      {label}
    </span>
  );
}

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`flex flex-shrink-0 items-center gap-1.5 text-[13px] font-medium ${
        enabled ? "text-emerald-700" : "text-gray-400"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          enabled ? "bg-emerald-500" : "bg-gray-300"
        }`}
      />
      {enabled ? "Active" : "Inactive"}
    </span>
  );
}

function Toggle({
  value,
  onClick,
  pending,
}: {
  value: boolean;
  onClick: () => void;
  pending: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={value}
      className={`flex h-6 w-11 flex-shrink-0 items-center rounded-full px-0.5 transition-colors disabled:opacity-50 ${
        value ? "justify-end bg-navy" : "justify-start bg-gray-200"
      }`}
    >
      <div className="h-5 w-5 rounded-full bg-white shadow-sm" />
    </button>
  );
}

function ObsidianPanel() {
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

function TavilyPanel() {
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


function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] tracking-[0.04em] text-gray-500 uppercase">
        {label}
      </span>
      {children}
      {hint && (
        <span className="font-mono text-[11px] text-gray-400">{hint}</span>
      )}
    </div>
  );
}

// ── Hermes / Pi bridge add-ons ────────────────────────────────────────────
//
// Both add-ons point Companion at an HTTP "bridge" the user runs on their
// own machine (the hermes ACP bridge / thecompai-pi-bridge wrapping the Pi
// CLI). The endpoint is per-user config stored on the addons row — never
// hardcoded — so every operator wires their own host + token here. Pi adds
// a default working directory the agent starts in.

type BridgeInfo = {
  enabled: boolean;
  configured: boolean;
  bridgeUrl: string;
  hasToken: boolean;
  cwd?: string;
};

type BridgeConfigBody = {
  enabled?: boolean;
  bridgeUrl?: string;
  bridgeToken?: string | null;
  cwd?: string | null;
};

type ProbeResult = {
  ok: boolean;
  health?: unknown;
  error?: string;
  status?: number;
};


function BridgeAddonPanel({
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

function HermesAddonPanel() {
  return (
    <BridgeAddonPanel
      urlPlaceholder="http://127.0.0.1:8013"
      load={() => api.hermesAddonInfo()}
      save={(body) => api.hermesAddonSetConfig(body)}
      probe={() => api.hermesAddonProbe()}
    >
      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How the Hermes bridge works
        </summary>
        <p className="mt-3 leading-relaxed">
          Type <code className="rounded bg-gray-100 px-1 font-mono">/hermes</code>{" "}
          in chat to open an agent sub-thread. Companion forwards your prompt
          to the bridge running on your machine, which drives the Hermes
          coding agent and streams its turns back.
        </p>
      </details>
    </BridgeAddonPanel>
  );
}

function PiAddonPanel() {
  return (
    <BridgeAddonPanel
      urlPlaceholder="http://127.0.0.1:8014"
      withCwd
      load={() => api.piAddonInfo()}
      save={(body) => api.piAddonSetConfig(body)}
      probe={() => api.piAddonProbe()}
    >
      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How the Pi bridge works
        </summary>
        <p className="mt-3 leading-relaxed">
          Type <code className="rounded bg-gray-100 px-1 font-mono">/pi</code>{" "}
          in chat to open a Pi coding-agent sub-thread. The bridge wraps the{" "}
          <code className="rounded bg-gray-100 px-1 font-mono">pi</code> CLI on
          its host and can read, write, edit files and run shell commands in
          the working directory above.
        </p>
      </details>
    </BridgeAddonPanel>
  );
}

// ── Voice (Gemini Live) panel ─────────────────────────────────────────────

/** Full Gemini Live prebuilt voice catalog, paired with the official
 *  one-word style descriptor Google publishes alongside each name.
 *  Reproduced verbatim so the picker labels match the docs. */
const VOICES: Array<{ name: string; tone: string }> = [
  { name: "Zephyr", tone: "Bright" },
  { name: "Puck", tone: "Upbeat" },
  { name: "Charon", tone: "Informative" },
  { name: "Kore", tone: "Firm" },
  { name: "Fenrir", tone: "Excitable" },
  { name: "Leda", tone: "Youthful" },
  { name: "Orus", tone: "Firm" },
  { name: "Aoede", tone: "Breezy" },
  { name: "Callirrhoe", tone: "Easy-going" },
  { name: "Autonoe", tone: "Bright" },
  { name: "Enceladus", tone: "Breathy" },
  { name: "Iapetus", tone: "Clear" },
  { name: "Umbriel", tone: "Easy-going" },
  { name: "Algieba", tone: "Smooth" },
  { name: "Despina", tone: "Smooth" },
  { name: "Erinome", tone: "Clear" },
  { name: "Algenib", tone: "Gravelly" },
  { name: "Rasalgethi", tone: "Informative" },
  { name: "Laomedeia", tone: "Upbeat" },
  { name: "Achernar", tone: "Soft" },
  { name: "Alnilam", tone: "Firm" },
  { name: "Schedar", tone: "Even" },
  { name: "Gacrux", tone: "Mature" },
  { name: "Pulcherrima", tone: "Forward" },
  { name: "Achird", tone: "Friendly" },
  { name: "Zubenelgenubi", tone: "Casual" },
  { name: "Vindemiatrix", tone: "Gentle" },
  { name: "Sadachbia", tone: "Lively" },
  { name: "Sadaltager", tone: "Knowledgeable" },
  { name: "Sulafat", tone: "Warm" },
];

const PRESET_MALE = "Orus";
const PRESET_FEMALE = "Aoede";

/**
 * Three-way voice picker: Male preset (Orus), Female preset (Aoede), or
 * Custom with a dropdown of every Gemini Live voice. The mode is derived
 * from the saved value rather than stored separately — single source of
 * truth stays the `voice` string the backend sends to the Live API.
 */
function VoicePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const trimmed = value.trim();
  const mode: "male" | "female" | "custom" =
    trimmed === PRESET_MALE
      ? "male"
      : trimmed === PRESET_FEMALE
        ? "female"
        : "custom";

  function pick(next: "male" | "female" | "custom") {
    if (next === "male") onChange(PRESET_MALE);
    else if (next === "female") onChange(PRESET_FEMALE);
    else if (mode !== "custom") {
      // Switching to Custom — seed with the first non-preset voice if the
      // current value is one of the presets, so the dropdown isn't blank.
      const seed =
        VOICES.find((v) => v.name !== PRESET_MALE && v.name !== PRESET_FEMALE)
          ?.name ?? "Charon";
      onChange(seed);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <ModeButton
          active={mode === "male"}
          label="Male"
          sub={PRESET_MALE}
          onClick={() => pick("male")}
        />
        <ModeButton
          active={mode === "female"}
          label="Female"
          sub={PRESET_FEMALE}
          onClick={() => pick("female")}
        />
        <ModeButton
          active={mode === "custom"}
          label="Custom"
          sub={mode === "custom" ? trimmed || "—" : "Pick from list"}
          onClick={() => pick("custom")}
        />
      </div>
      {mode === "custom" && (
        <select
          value={trimmed}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        >
          {VOICES.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name} — {v.tone}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function ModeButton({
  active,
  label,
  sub,
  onClick,
}: {
  active: boolean;
  label: string;
  sub: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors ${
        active
          ? "border-cyan bg-[rgba(79,179,217,0.08)] text-ink"
          : "border-gray-200 bg-white text-ink hover:bg-gray-50"
      }`}
    >
      <span className="text-[13px] font-medium">{label}</span>
      <span className="font-mono text-[11px] text-gray-500">{sub}</span>
    </button>
  );
}

function VoiceLivePanel() {
  type Info = Awaited<ReturnType<typeof api.voiceLiveInfo>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Local edits
  const [provider, setProvider] = useState<"local" | "gemini" | "mistral">(
    "local",
  );
  const [ttsEndpoint, setTtsEndpoint] = useState("");
  const [asrEndpoint, setAsrEndpoint] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [systemInstruction, setSystemInstruction] = useState("");
  const [showKey, setShowKey] = useState(false);

  async function refresh() {
    try {
      const r = await api.voiceLiveInfo();
      setInfo(r);
      setProvider(r.provider);
      setTtsEndpoint(r.ttsEndpoint);
      setAsrEndpoint(r.asrEndpoint);
      setTtsModel(r.ttsModel);
      setModel(r.model);
      setVoice(r.voice);
      setSystemInstruction(r.systemInstruction);
      setApiKey("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.voiceLiveUpdateConfig({
        provider,
        ttsEndpoint: ttsEndpoint.trim() || undefined,
        asrEndpoint: asrEndpoint.trim() || undefined,
        ttsModel: ttsModel.trim() || undefined,
        model: model.trim() || undefined,
        voice: voice.trim() || undefined,
        systemInstruction,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setSaved(true);
      await refresh();
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    if (!confirm("Remove the Gemini API key? Voice mode will stop working.")) return;
    setBusy(true);
    try {
      await api.voiceLiveUpdateConfig({ apiKey: null });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!info) {
    return <span className="font-mono text-[11px] text-gray-400">Loading…</span>;
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1.5 text-[12px] text-gray-600">
        <span>
          <span className="text-gray-400">Provider</span>{" "}
          <code className="font-mono text-ink">{info.provider}</code>
        </span>
        {info.provider !== "gemini" && (
          <span>
            <span className="text-gray-400">TTS</span>{" "}
            <code className="font-mono text-ink">{info.ttsEndpoint || "—"}</code>
          </span>
        )}
        {info.provider !== "local" && (
          <span className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${info.hasApiKey ? "bg-emerald-500" : "bg-rose-500"}`}
            />
            <span className="font-mono text-ink">
              {info.hasApiKey ? "key set" : "no key"}
            </span>
          </span>
        )}
      </div>

      <Field
        label="Provider"
        hint="Where chat voice (TTS out + ASR in) is handled. local/mistral forward to an OpenAI-compatible /v1/audio endpoint; gemini is full-duplex Live over WebSocket."
      >
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-ink outline-none focus:border-cyan"
        >
          <option value="local">Local (OpenAI-compatible audio)</option>
          <option value="mistral">Mistral (Voxtral)</option>
          <option value="gemini">Gemini Live (full-duplex)</option>
        </select>
      </Field>

      {provider !== "gemini" && (
        <>
          <Field
            label="TTS endpoint"
            hint="Base URL of an OpenAI-compatible TTS server (calls /v1/audio/speech). For Voxtral, your Mistral-compatible base URL."
          >
            <input
              type="text"
              value={ttsEndpoint}
              onChange={(e) => setTtsEndpoint(e.target.value)}
              placeholder="http://192.168.86.49:8003"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
          <Field
            label="ASR endpoint"
            hint="Base URL for /v1/audio/transcriptions. Leave blank to reuse the TTS endpoint."
          >
            <input
              type="text"
              value={asrEndpoint}
              onChange={(e) => setAsrEndpoint(e.target.value)}
              placeholder="(same as TTS endpoint)"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
          <Field label="TTS model" hint="Model id the TTS server should use.">
            <input
              type="text"
              value={ttsModel}
              onChange={(e) => setTtsModel(e.target.value)}
              placeholder="mlx-community/VibeVoice-Realtime-0.5B-8bit"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
          <Field
            label="Voice"
            hint="Voice id your TTS server understands (e.g. en-Emma_woman, fr-Spk1_woman for VibeVoice)."
          >
            <input
              type="text"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              placeholder="en-Emma_woman"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
        </>
      )}

      {provider !== "local" && (
        <Field
          label="API key"
          hint={
            provider === "gemini"
              ? "Gemini API key (https://aistudio.google.com/apikey). Stored server-side; minted into a session payload at voice start."
              : "Bearer key for the Voxtral / Mistral endpoint. Stored server-side."
          }
        >
          <div className="flex items-center gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                info.hasApiKey
                  ? "•••• (set — paste a new one to replace)"
                  : provider === "gemini"
                    ? "AIza…"
                    : "key…"
              }
              className="flex-1 rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600 hover:text-ink"
            >
              {showKey ? "Hide" : "Show"}
            </button>
            {info.hasApiKey && (
              <button
                type="button"
                onClick={clearKey}
                disabled={busy}
                className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[12px] text-gray-600 hover:text-ink"
              >
                Revoke
              </button>
            )}
          </div>
        </Field>
      )}

      {provider === "gemini" && (
        <>
          <Field
            label="Model"
            hint="Gemini Live model id. Default: models/gemini-3.1-flash-live-preview (newest, best multilingual ASR)."
          >
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="models/gemini-3.1-flash-live-preview"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
          <Field label="Voice" hint="Pick a quick preset or browse the full list.">
            <VoicePicker value={voice} onChange={setVoice} />
          </Field>
          <Field
            label="System instruction"
            hint="Optional — shapes the assistant's persona for voice sessions."
          >
            <textarea
              value={systemInstruction}
              onChange={(e) => setSystemInstruction(e.target.value)}
              rows={3}
              className="w-full resize-y rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
          </Field>
        </>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "Saving…" : saved ? "✓ Saved" : "Save"}
        </button>
      </div>

      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How Voice works
        </summary>
        <p className="mt-3 leading-relaxed">
          One voice function for the chat — TTS out + ASR in.{" "}
          <b>local</b> and <b>mistral</b> forward to an OpenAI-compatible
          /v1/audio endpoint (the chat speaks replies and transcribes your mic).{" "}
          <b>gemini</b> opens a full-duplex Live WebSocket from the browser (PCM
          16 kHz in / 24 kHz out); the server only mints session credentials.
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

function PackageIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#0F2F4F"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2l9 4.5v11L12 22l-9-4.5v-11L12 2z" />
      <path d="M3 7l9 4.5 9-4.5" />
      <path d="M12 22V11.5" />
    </svg>
  );
}

// LiteLLM as an add-on — moved here from Inference page 2026-05-19.
// Backed by `users.litellm{Url,ApiKey,Disabled}` so flipping the toggle
// persists across logins. When off, all sub-fields are hidden (the user's
// 'en off, on n'affiche pas les info comme actuellement').
function LiteLLMAddon() {
  const [s, setS] = useState<ApiInferenceSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
  const [keyDraft, setKeyDraft] = useState("");
  const [keyDirty, setKeyDirty] = useState(false);

  useEffect(() => {
    api.inferenceSettings()
      .then((data) => {
        setS(data);
        setUrlDraft(data.litellmUrl ?? "");
      })
      .catch((e: Error) => setErr(e.message));
  }, []);

  if (!s) return null;

  // Enabled = NOT disabled. The DB stores litellmDisabled (true means OFF).
  const enabled = !s.litellmDisabled;

  async function toggle(next: boolean) {
    setPending(true);
    setErr(null);
    try {
      await api.updateInferenceSettings({ litellmDisabled: !next });
      setS((prev) => (prev ? { ...prev, litellmDisabled: !next } : prev));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function saveFields() {
    setPending(true);
    setErr(null);
    try {
      const patch: {
        litellmUrl?: string | null;
        litellmApiKey?: string | null;
      } = {
        litellmUrl: urlDraft.trim() || null,
      };
      if (keyDirty) patch.litellmApiKey = keyDraft.trim() || null;
      await api.updateInferenceSettings(patch);
      setS((prev) =>
        prev
          ? { ...prev, litellmUrl: patch.litellmUrl ?? null, hasApiKey: keyDirty ? Boolean(patch.litellmApiKey) : prev.hasApiKey }
          : prev,
      );
      setKeyDraft("");
      setKeyDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-0 rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-5 px-6 py-5">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-[rgba(79,179,217,0.12)]">
          <PackageIcon />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-medium text-ink">
              LiteLLM proxy
            </span>
            <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
              optional
            </span>
          </div>
          <span className="text-[13px] leading-[20px] text-gray-600">
            Stand-alone LiteLLM proxy for cascade fallback, budget tracking,
            or the Anthropic protocol bridge. In gateway mode Odysseus
            already proxies cloud providers — most users can keep this off
            and run the simpler chain.
          </span>
        </div>
        <StatusPill enabled={enabled} />
        <Toggle
          value={enabled}
          onClick={() => toggle(!enabled)}
          pending={pending}
        />
      </div>

      {enabled && (
        <div className="flex flex-col gap-3 border-t border-gray-200 bg-gray-50/60 px-6 py-5">
          <div className="flex flex-col gap-1">
            <label className="font-sans text-[11px] tracking-wider text-gray-500 uppercase">
              Proxy URL
            </label>
            <input
              type="url"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder={s.envDefaultUrl}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
            <span className="font-mono text-[10px] text-gray-400">
              Default: {s.envDefaultUrl}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label className="font-sans text-[11px] tracking-wider text-gray-500 uppercase">
              API key (optional)
            </label>
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => {
                setKeyDraft(e.target.value);
                setKeyDirty(true);
              }}
              placeholder={s.hasApiKey ? "•••• (set)" : "sk-…"}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
            />
            <span className="font-mono text-[10px] text-gray-400">
              {s.hasApiKey
                ? "A key is set. Leave blank to keep; type a new one to replace."
                : "Only needed if the proxy enforces an API key."}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={saveFields}
              disabled={pending}
              className="rounded-md bg-navy px-3 py-1.5 text-[12px] text-white hover:opacity-95 disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <a
              href={
                (urlDraft || s.envDefaultUrl).replace(/\/+$/, "") + "/ui"
              }
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50 hover:text-ink"
            >
              Open LiteLLM admin UI ↗
            </a>
          </div>
        </div>
      )}

      {err && (
        <div className="border-t border-red-100 bg-red-50 px-5 py-2 font-mono text-[11px] text-red-700">
          {err}
        </div>
      )}
    </div>
  );
}

// ── Auto Router add-on ────────────────────────────────────────────────────
//
// Picks chat / deep / code automatically by embedding the user's last
// message and comparing it against per-bucket centroids. The embedding
// service can run anywhere the user hosts an OpenAI-compatible
// embeddings endpoint. The user supplies the URL + the three target
// model ids. Anchors are rebuilt whenever the URL changes.

function RouterPanel() {
  type Info = Awaited<ReturnType<typeof api.routerInfo>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [policy, setPolicy] = useState<{ chat: string; deep: string; code: string }>({
    chat: "",
    deep: "",
    code: "",
  });
  // Model catalog drives the per-bucket pickers. We exclude the "auto"
  // synthetic entry since picking Auto as a router bucket would loop
  // back into the router itself.
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
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function refreshModels() {
    try {
      const r = await api.listAllModels();
      setModels(r.models.filter((m) => m.id !== "auto"));
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
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => save(false)}
            disabled={busy !== null}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {busy === "save" ? "Saving…" : "Save policy"}
          </button>
          <button
            type="button"
            onClick={rebuild}
            disabled={busy !== null || !info.configured}
            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-600 hover:text-ink disabled:opacity-50"
          >
            Rebuild anchors
          </button>
        </div>
        <p className="mt-2 text-[11px] text-gray-500">
          Three intents, three models. <strong>Chat</strong> = small talk
          and quick replies. <strong>Deep</strong> = analysis, comparisons,
          longer reasoning. <strong>Code</strong> = write, refactor, debug.
          Use any model id your inference engine exposes.
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
          down, the chat returns a clear error instead of guessing a
          model on your behalf.
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
