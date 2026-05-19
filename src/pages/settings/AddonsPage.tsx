import { useEffect, useMemo, useState } from "react";
import { useIsMobile } from "~/hooks/useIsMobile";
import { api, type ApiAddon, type ApiInferenceSettings } from "~/lib/api";

type Filter = "all" | "plugin" | "mcp" | "core";

/** UI relabel without changing the DB row name. */
function displayName(dbName: string): string {
  if (dbName === "Hermes Agent") return "Cluster Operations";
  return dbName;
}

function displayDescription(dbName: string): string | null {
  if (dbName === "Hermes Agent") {
    return "Power-user tasks on your home server (RAG, ComfyUI, vault, rsync). Workspace files use the agent's built-in fs_* tools.";
  }
  return null;
}

export default function AddonsPage() {
  const [addons, setAddons] = useState<ApiAddon[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [pending, setPending] = useState<Set<string>>(new Set());
  const isMobile = useIsMobile();

  async function refresh() {
    try {
      const r = await api.listAddons();
      setAddons(r.addons);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const counts = useMemo(() => {
    const list = addons ?? [];
    return {
      all: list.length,
      plugin: list.filter((a) => a.kind === "plugin").length,
      mcp: list.filter((a) => a.kind === "mcp").length,
      core: list.filter((a) => a.kind === "core").length,
    };
  }, [addons]);

  const visible = useMemo(() => {
    const list = addons ?? [];
    if (filter === "all") return list;
    return list.filter((a) => a.kind === filter);
  }, [addons, filter]);

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
          Extend Companion with plugins and MCP servers. Each add-on can
          surface in the Tools menu and carry its own screen if it needs one.
        </p>
      </header>

      <div className="flex items-center justify-between gap-4">
        <div className="flex gap-1.5">
          <FilterChip label={`All · ${counts.all}`} active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterChip label={`Plugins · ${counts.plugin}`} active={filter === "plugin"} onClick={() => setFilter("plugin")} />
          <FilterChip label={`MCP · ${counts.mcp}`} active={filter === "mcp"} onClick={() => setFilter("mcp")} />
          <FilterChip label={`Core · ${counts.core}`} active={filter === "core"} onClick={() => setFilter("core")} />
        </div>
        {!isMobile && (
          <button
            type="button"
            className="flex h-9 items-center gap-2 rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95"
            onClick={() => alert("Install-from-URL flow coming soon.")}
          >
            <PlusIcon />
            Install from URL
          </button>
        )}
      </div>

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
       *  row. Lives here (per Sophie 2026-05-19) because it's an optional
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
        <Group
          title="Installed"
          subtitle="Plugins and MCP servers you've added."
        >
          {installed.map((a) => (
            <AddonCard
              key={a.id}
              addon={a}
              pending={pending.has(a.id)}
              onToggle={() => toggle(a)}
            />
          ))}
        </Group>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border px-3.5 py-1.5 text-[13px] transition-colors ${
        active
          ? "border-navy bg-navy text-white"
          : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
      }`}
    >
      {label}
    </button>
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
  // Mobile hides the per-addon advanced panels (Tavily key, Obsidian token,
  // Hermes bridge config). These are admin/infra surfaces — desktop only,
  // mirroring ExoScopy's filter pattern.
  const hasPanel =
    !isMobile &&
    (addon.name === "Obsidian" ||
      addon.name === "Web Search" ||
      addon.name === "Hermes Agent" ||
      addon.name === "Voice (Gemini Live)");

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
          {addon.name === "Hermes Agent" && <HermesPanel />}
          {addon.name === "Voice (Gemini Live)" && <VoiceLivePanel />}
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

function PlusIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
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
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // ignore
    }
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
              {"<vault>/.obsidian/plugins/thecompai/"}
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

/**
 * NousResearch hermes-agent ships a separate web Dashboard that exposes
 * skills, sessions, model config, history. By convention it listens on
 * port 9119 of the same host as the gateway. Derive its URL from the
 * configured gateway URL by swapping the port — falls back to the host
 * with :9119 if the user's gateway URL has no port.
 */
function dashboardUrl(gatewayUrl: string): string {
  try {
    const u = new URL(gatewayUrl);
    u.port = "9119";
    return u.toString();
  } catch {
    return "http://192.168.86.50:9119";
  }
}

function HermesPanel() {
  type Info = Awaited<ReturnType<typeof api.hermesInfo>>;
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Local edits
  const [apiUrl, setApiUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [showKey, setShowKey] = useState(false);

  async function refresh() {
    try {
      const r = await api.hermesInfo();
      setInfo(r);
      setApiUrl(r.apiUrl ?? "");
      setDefaultModel(r.defaultModel);
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
      await api.hermesUpdateConfig({
        apiUrl: apiUrl.trim() || null,
        defaultModel: defaultModel.trim(),
        // Send apiKey only when the user typed a new value (empty = keep current).
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
    if (!confirm("Remove the Hermes API key? The agent will stop working until you set a new one.")) return;
    setBusy(true);
    setErr(null);
    try {
      await api.hermesUpdateConfig({ apiKey: null });
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
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              info.gatewayOk ? "bg-emerald-500" : "bg-rose-500"
            }`}
          />
          <span className="font-mono text-ink">
            {info.gatewayOk ? "gateway online" : "gateway unreachable"}
          </span>
        </span>
        <span>
          <span className="text-gray-400">Gateway</span>{" "}
          <code className="font-mono text-ink">{info.gatewayUrl}</code>
        </span>
        <span>
          <span className="text-gray-400">Models</span>{" "}
          <span className="font-mono text-ink">{info.availableModels.length}</span>
        </span>
        {info.lastError && !info.gatewayOk && (
          <span className="text-rose-600">⚠ {info.lastError}</span>
        )}
      </div>

      <Field
        label="Gateway URL (override)"
        hint="Where the Hermes Agent gateway runs. Leave empty for the default."
      >
        <input
          type="url"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          placeholder={info.gatewayUrl}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
      </Field>

      <Field
        label="API key (Bearer)"
        hint="API_SERVER_KEY from ~/.hermes/.env on the gateway host. Required — the gateway rejects unauth requests."
      >
        <div className="flex items-center gap-2">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={info.hasApiKey ? "•••• (set — paste a new one to replace)" : "paste API key…"}
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

      <Field
        label="Default model"
        hint="The Hermes gateway exposes a single virtual model named hermes-agent. Leave default unless your gateway is configured otherwise."
      >
        <input
          type="text"
          value={defaultModel}
          onChange={(e) => setDefaultModel(e.target.value)}
          placeholder="hermes-agent"
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
        />
      </Field>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
        >
          {busy ? "Saving…" : saved ? "✓ Saved" : "Save"}
        </button>
        <a
          href={dashboardUrl(info.gatewayUrl)}
          target="_blank"
          rel="noreferrer"
          className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] font-medium text-ink hover:bg-gray-50"
        >
          Open Hermes Dashboard ↗
        </a>
      </div>

      <details className="rounded-md border border-gray-200 bg-white px-4 py-3 text-[12px] text-gray-600">
        <summary className="cursor-pointer font-medium text-ink">
          How Hermes works in Companion
        </summary>
        <p className="mt-3 leading-relaxed">
          Click the <strong>Hermes</strong> button in the sidebar to start a
          dedicated conversation that talks <em>directly</em> to your Hermes
          Agent gateway. Hermes brings its own toolbox — every skill installed
          in <code className="rounded bg-gray-100 px-1 font-mono">~/.hermes/skills/</code>{" "}
          on the gateway host (Notion, Obsidian, ComfyUI, GitHub, browser, …)
          plus shell access via the terminal toolset.
        </p>
        <p className="mt-3 leading-relaxed">
          The agent loop can take 30s–3min per turn — that's intrinsic to
          NousResearch hermes-agent. Streaming keeps the connection alive.
        </p>
        <p className="mt-3 leading-relaxed">
          Skill management, model defaults and session history live in the{" "}
          <a
            href={dashboardUrl(info.gatewayUrl)}
            target="_blank"
            rel="noreferrer"
            className="text-cyan underline-offset-2 hover:underline"
          >
            Hermes Dashboard
          </a>
          . We don't duplicate it here.
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
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [voice, setVoice] = useState("");
  const [systemInstruction, setSystemInstruction] = useState("");
  const [showKey, setShowKey] = useState(false);

  async function refresh() {
    try {
      const r = await api.voiceLiveInfo();
      setInfo(r);
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
        <span className="flex items-center gap-1.5">
          <span
            className={`h-1.5 w-1.5 rounded-full ${info.hasApiKey ? "bg-emerald-500" : "bg-rose-500"}`}
          />
          <span className="font-mono text-ink">
            {info.hasApiKey ? "key set" : "missing key"}
          </span>
        </span>
        <span>
          <span className="text-gray-400">Model</span>{" "}
          <code className="font-mono text-ink">{info.model}</code>
        </span>
        <span>
          <span className="text-gray-400">Voice</span>{" "}
          <code className="font-mono text-ink">{info.voice}</code>
        </span>
      </div>

      <Field
        label="API key"
        hint="Gemini API key (https://aistudio.google.com/apikey). Stored server-side; minted into a session payload at voice-mode start."
      >
        <div className="flex items-center gap-2">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={info.hasApiKey ? "•••• (set — paste a new one to replace)" : "AIza…"}
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

      <Field
        label="Voice"
        hint="Pick a quick preset or browse the full list."
      >
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
          How Voice (Gemini Live) works
        </summary>
        <p className="mt-3 leading-relaxed">
          When enabled with an API key, the chat's voice mode opens a WebSocket
          to Google's Gemini Live API directly from the browser. Audio is PCM
          16-bit 16 kHz LE in / 24 kHz out, streamed bidirectionally. The
          server only mints session credentials — it never proxies audio.
        </p>
        <p className="mt-3">
          Voxtral / Kokoro local TTS / VibeVoice ASR are paused while the
          Gemini path is the primary voice provider. They'll come back once
          the local stack matures.
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
// persists across logins. When off, all sub-fields are hidden (Sophie's
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
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex items-start gap-4 p-5">
        <div className="mt-0.5 shrink-0 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[10px] tracking-wider text-gray-500 uppercase">
          add-on
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <h3 className="font-display text-[18px] font-medium text-navy">
              LiteLLM proxy
            </h3>
            <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600">
              optional
            </span>
          </div>
          <p className="max-w-[640px] text-[13px] leading-relaxed text-gray-600">
            Stand-alone LiteLLM proxy for cascade fallback, budget tracking,
            or the Anthropic protocol bridge. In gateway mode Odysseus
            already proxies cloud providers — most users can keep this off
            and run the simpler chain.
          </p>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2">
          <span className="font-mono text-[11px] text-gray-500">
            {enabled ? "ON" : "OFF"}
          </span>
          <input
            type="checkbox"
            checked={enabled}
            disabled={pending}
            onChange={(e) => toggle(e.target.checked)}
            className="h-4 w-4 cursor-pointer"
          />
        </label>
      </div>

      {enabled && (
        <div className="flex flex-col gap-3 border-t border-gray-100 px-5 py-4">
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
