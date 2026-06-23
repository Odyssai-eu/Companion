import { useEffect, useMemo, useState } from "react";
import { useIsMobile } from "~/hooks/useIsMobile";
import {
  api,
  type ApiAddon,
  type ApiInferenceSettings,
} from "~/lib/api";
import { ObsidianPanel } from "./addons/ObsidianPanel";
import { TavilyPanel } from "./addons/TavilyPanel";
import { VoiceLivePanel } from "./addons/VoiceLivePanel";
import { RouterPanel } from "./addons/RouterPanel";
import { HybridRoutingPanel } from "./addons/HybridRoutingPanel";
import { HermesAddonPanel } from "./addons/HermesAddonPanel";
import { PiAddonPanel } from "./addons/PiAddonPanel";
import { ComfyuiAddonPanel } from "./addons/ComfyuiAddonPanel";

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
          api.hybridRoutingInfo().catch(() => undefined),
          api.voiceLiveInfo().catch(() => undefined),
          api.hermesAddonInfo().catch(() => undefined),
          api.piAddonInfo().catch(() => undefined),
          api.comfyuiAddonInfo().catch(() => undefined),
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
      addon.name === "Auto Router" ||
      addon.name === "Hybrid Routing" ||
      addon.name === "Hermes Agent" ||
      addon.name === "Pi Agent" ||
      addon.name === "ComfyUI Imager");

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
          {addon.name === "Voice" && <VoiceLivePanel />}
          {addon.name === "Auto Router" && <RouterPanel />}
          {addon.name === "Hybrid Routing" && <HybridRoutingPanel />}
          {addon.name === "Hermes Agent" && <HermesAddonPanel />}
          {addon.name === "Pi Agent" && <PiAddonPanel />}
          {addon.name === "ComfyUI Imager" && <ComfyuiAddonPanel />}
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
            or the Anthropic protocol bridge. In gateway mode OdyssAI-X
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
