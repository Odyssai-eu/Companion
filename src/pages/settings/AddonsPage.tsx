import { useEffect, useMemo, useState } from "react";
import { api, type ApiAddon } from "~/lib/api";

type Filter = "all" | "plugin" | "mcp" | "core";

export default function AddonsPage() {
  const [addons, setAddons] = useState<ApiAddon[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
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
          Extend Thecomp.ai with plugins and MCP servers. Each add-on can
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
        <button
          type="button"
          className="flex h-9 items-center gap-2 rounded-lg bg-navy px-4 text-[13px] font-medium text-white hover:opacity-95"
          onClick={() => alert("Install-from-URL flow coming soon.")}
        >
          <PlusIcon />
          Install from URL
        </button>
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
  const hasPanel = addon.name === "Obsidian";

  return (
    <div className="flex flex-col gap-0 rounded-xl border border-gray-200 bg-white">
      <div className="flex items-center gap-5 px-6 py-5">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-[rgba(79,179,217,0.12)]">
          <PackageIcon />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-medium text-ink">{addon.name}</span>
            <KindBadge kind={addon.kind} />
            {addon.version && (
              <span className="font-mono text-[11px] text-gray-400">
                v{addon.version}
              </span>
            )}
          </div>
          {addon.description && (
            <span className="text-[13px] leading-[20px] text-gray-600">
              {addon.description}
            </span>
          )}
        </div>
        <StatusPill enabled={addon.enabled} />
        <Toggle value={addon.enabled} onClick={onToggle} pending={pending} />
      </div>
      {hasPanel && addon.enabled && (
        <div className="border-t border-gray-200 bg-gray-50/60 px-6 py-5">
          {addon.name === "Obsidian" && <ObsidianPanel />}
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
          Paste this in the Thecomp.ai plugin inside Obsidian. Treat it like a
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
            Download the latest release of the Thecomp.ai plugin from the
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
            manual sync from the command palette (<code>Thecomp.ai: Sync now</code>).
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] tracking-[0.04em] text-gray-500 uppercase">
        {label}
      </span>
      {children}
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
