import { useEffect, useState } from "react";
import {
  api,
  ApiError,
  type ApiMcpServer,
  type ApiMcpServerInput,
  type ApiMcpToolSpec,
} from "~/lib/api";

/**
 * Settings → Extensions → MCP servers.
 *
 * Companion as a CLIENT of remote MCP servers. The user registers
 * Notion, Qdrant, Linear, GitHub, … endpoints here. At chat time
 * their tools are merged into the toolset the LLM sees, prefixed
 * `mcp_<slug>_<tool>` to dodge name collisions.
 *
 * Auth header is stored verbatim. Common shapes:
 *   "Bearer sk_…"            → Authorization: Bearer sk_…
 *   "X-API-Key: abc123"      → X-API-Key: abc123 (split on first colon)
 *   any other plain string   → Authorization: <as-is>
 */

type Draft = {
  id?: string;
  name: string;
  slug: string;
  transport: "streamable_http" | "sse";
  url: string;
  authKind: "bearer" | "oauth" | "none";
  authHeader: string;
  authHeaderDirty: boolean;
  enabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  slug: "",
  transport: "streamable_http",
  url: "",
  authKind: "bearer",
  authHeader: "",
  authHeaderDirty: false,
  enabled: true,
};

// Quick-add catalog (2026-05-19). Each preset seeds the EditModal so
// the user types only the auth token (or signs in via OAuth) instead
// of guessing transport + url + headers. URLs are public endpoints
// or canonical templates — the user can still tweak before saving.
//
// Sources:
//   - Notion        https://mcp.notion.com/mcp                (OAuth)
//   - GitHub        https://api.githubcopilot.com/mcp/         (OAuth)
//   - Tavily        https://mcp.tavily.com/mcp/?tavilyApiKey=… (bearer)
//   - Obsidian      user-hosted bridge over LAN                (bearer)
//   - Linear        https://mcp.linear.app/sse                 (OAuth)
//   - Filesystem    user-hosted MCP fs over HTTP               (bearer)
type Preset = {
  id: string;
  label: string;
  description: string;
  draft: Partial<Draft>;
};

const PRESETS: Preset[] = [
  {
    id: "notion",
    label: "Notion",
    description: "Pages, databases, search. OAuth.",
    draft: {
      name: "Notion",
      slug: "notion",
      transport: "streamable_http",
      url: "https://mcp.notion.com/mcp",
      authKind: "oauth",
      enabled: true,
    },
  },
  {
    id: "github",
    label: "GitHub",
    description: "Repos, issues, PRs, code search. OAuth via Copilot.",
    draft: {
      name: "GitHub",
      slug: "github",
      transport: "streamable_http",
      url: "https://api.githubcopilot.com/mcp/",
      authKind: "oauth",
      enabled: true,
    },
  },
  {
    id: "tavily",
    label: "Tavily",
    description: "Web search + URL fetch. Bearer (API key).",
    draft: {
      name: "Tavily",
      slug: "tavily",
      transport: "streamable_http",
      url: "https://mcp.tavily.com/mcp/",
      authKind: "bearer",
      enabled: true,
    },
  },
  {
    id: "linear",
    label: "Linear",
    description: "Issues, projects, comments. OAuth.",
    draft: {
      name: "Linear",
      slug: "linear",
      transport: "sse",
      url: "https://mcp.linear.app/sse",
      authKind: "oauth",
      enabled: true,
    },
  },
  {
    id: "obsidian",
    label: "Obsidian",
    description: "Local vault bridge. Bearer to your self-hosted endpoint.",
    draft: {
      name: "Obsidian",
      slug: "obsidian",
      transport: "streamable_http",
      url: "",  // user fills LAN URL
      authKind: "bearer",
      enabled: true,
    },
  },
  {
    id: "filesystem",
    label: "Filesystem",
    description: "Local files via your own MCP fs server.",
    draft: {
      name: "Filesystem",
      slug: "fs",
      transport: "streamable_http",
      url: "",
      authKind: "bearer",
      enabled: true,
    },
  },
];

export default function McpServersPage() {
  const [servers, setServers] = useState<ApiMcpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);

  async function reload() {
    try {
      const { servers } = await api.listMcpServers();
      setServers(servers);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  function startNew() {
    setEditing({ ...EMPTY_DRAFT });
  }

  function startFromPreset(p: Preset) {
    setEditing({ ...EMPTY_DRAFT, ...p.draft });
  }

  function startEdit(s: ApiMcpServer) {
    setEditing({
      id: s.id,
      name: s.name,
      slug: s.slug,
      transport: s.transport,
      url: s.url,
      authKind: s.authKind,
      authHeader: "",
      authHeaderDirty: false,
      enabled: s.enabled,
    });
  }

  async function connectOauth(s: ApiMcpServer) {
    try {
      const { authorizationUrl } = await api.startMcpOauth(s.id);
      // Open the auth URL in a popup. The callback page postMessages
      // back to us on completion; we then refresh the list to show
      // the connected status.
      const popup = window.open(
        authorizationUrl,
        `mcp-oauth-${s.id}`,
        "width=600,height=720,popup=yes",
      );
      if (!popup) {
        setError(
          "Popup was blocked. Allow popups for this site and try again.",
        );
        return;
      }
      // Listen for the callback's postMessage. The popup self-closes
      // after a short delay, so we just need to know it succeeded.
      function onMessage(e: MessageEvent) {
        if (!e.data || e.data.type !== "mcp-oauth") return;
        window.removeEventListener("message", onMessage);
        if (e.data.ok) {
          reload();
        } else {
          setError(`OAuth failed: ${e.data.message ?? "unknown"}`);
        }
      }
      window.addEventListener("message", onMessage);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function disconnectOauth(s: ApiMcpServer) {
    if (!confirm(`Disconnect ${s.name}? You'll need to re-authorize to use it again.`))
      return;
    try {
      await api.disconnectMcpOauth(s.id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(s: ApiMcpServer) {
    // Two different meanings behind one button (0060). When an instance
    // server of the same slug exists, this row is only an OVERRIDE of it,
    // so deleting it is "go back to the shared configuration", not
    // "remove the server" — and saying "Remove" there would read as a
    // destructive action on something the user does not own.
    const msg = s.overridesInstance
      ? `Drop your override of "${s.name}" and go back to the instance configuration?`
      : `Remove "${s.name}"?`;
    if (!confirm(msg)) return;
    try {
      await api.deleteMcpServer(s.id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function refresh(s: ApiMcpServer) {
    try {
      await api.refreshMcpServer(s.id);
      await reload();
    } catch (e) {
      // Surface the API error in the server's lastError row by reloading
      await reload();
      if (e instanceof ApiError) setError(e.message);
    }
  }

  async function toggleEnabled(s: ApiMcpServer) {
    try {
      await api.updateMcpServer(s.id, { enabled: !s.enabled });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Extensions
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          MCP servers.
        </h1>
        <p className="max-w-[680px] text-[15px] leading-[24px] text-gray-600">
          Register external MCP servers (Notion, Qdrant, Linear, GitHub, …)
          and Companion exposes their tools to the LLM at chat time. Tool
          names are namespaced{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-[12px]">
            mcp_&lt;slug&gt;_&lt;tool&gt;
          </code>{" "}
          so two servers can ship a <code>search</code> tool without
          colliding.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <div className="text-[11px] font-medium tracking-wider text-gray-400 uppercase">
          Quick add
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => startFromPreset(p)}
              title={p.description}
              className="flex flex-col items-start gap-0.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-left hover:border-cyan hover:bg-gray-50"
            >
              <span className="font-display text-[14px] font-medium text-navy">
                {p.label}
              </span>
              <span className="font-mono text-[10px] leading-tight text-gray-500">
                {p.draft.authKind === "oauth" ? "OAuth" : "Bearer"}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={startNew}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95"
          >
            Add MCP server
          </button>
        </div>
      </div>

      {servers === null ? (
        <div className="font-mono text-[12px] text-gray-400">Loading…</div>
      ) : servers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-200 bg-white p-8 text-center">
          <p className="text-[14px] text-gray-600">
            No MCP servers registered yet.
          </p>
          <p className="mt-2 text-[12px] text-gray-400">
            Click <strong>Add MCP server</strong> to register your first
            endpoint. Examples worth trying: Qdrant (local vector search),
            Notion (pages + databases), GitHub (issues + PRs).
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {servers.map((s) => (
            <ServerCard
              key={s.id}
              server={s}
              onEdit={() => startEdit(s)}
              onDelete={() => remove(s)}
              onRefresh={() => refresh(s)}
              onToggle={() => toggleEnabled(s)}
              onOauthConnect={() => connectOauth(s)}
              onOauthDisconnect={() => disconnectOauth(s)}
            />
          ))}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 font-mono text-[12px] text-rose-700">
          {error}
        </div>
      )}

      {editing && (
        <EditModal
          draft={editing}
          onChange={setEditing}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ServerCard({
  server,
  onEdit,
  onDelete,
  onRefresh,
  onToggle,
  onOauthConnect,
  onOauthDisconnect,
}: {
  server: ApiMcpServer;
  onEdit: () => void;
  onDelete: () => void;
  onRefresh: () => void;
  onToggle: () => void;
  onOauthConnect: () => void;
  onOauthDisconnect: () => void;
}) {
  const isOauth = server.authKind === "oauth";
  // `oauthConnectedByMe`, not `oauthConnected`: an instance row can declare
  // an OAuth server that somebody else authorized, and offering no Connect
  // button because of that would leave this account permanently unable to
  // use it. Tokens are never shared (0060), so "connected" is always a
  // per-account fact.
  const oauthNeedsAuth = isOauth && !server.oauthConnectedByMe;
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg border bg-white p-4 ${
        server.lastError
          ? "border-rose-200"
          : server.enabled
            ? "border-gray-200"
            : "border-gray-200 opacity-70"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[14px] font-medium text-ink">
            {server.name}
            <span
              className="rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600"
              title="Tool name prefix"
            >
              mcp_{server.slug}_…
            </span>
            {/* 0060 — this server is declared for the whole instance. Any
                edit here becomes a private override, and Delete is not
                offered at all (the shared row belongs to the admin page). */}
            {server.inherited && (
              <span
                title="Declared for the whole instance. Editing anything here creates an override for your account only."
                className="rounded-md bg-[rgba(79,179,217,0.12)] px-1.5 py-0.5 text-[10px] font-medium text-cyan"
              >
                instance
              </span>
            )}
            {!server.enabled && (
              <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                disabled
              </span>
            )}
          </span>
          <span className="truncate font-mono text-[11px] text-gray-500">
            {server.transport === "sse" ? "SSE" : "Streamable HTTP"} ·{" "}
            {server.url}
          </span>
          <span className="font-mono text-[11px] text-gray-400">
            {server.toolsCount} tool{server.toolsCount === 1 ? "" : "s"}
            {server.toolsCacheAt &&
              ` · refreshed ${new Date(server.toolsCacheAt).toLocaleString()}`}
            {server.authKind === "bearer" && server.hasAuthHeader && " · auth set"}
            {isOauth &&
              (server.oauthConnectedByMe
                ? " · OAuth connected"
                : " · OAuth — needs authorization")}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {oauthNeedsAuth && (
            <button
              type="button"
              onClick={onOauthConnect}
              className="rounded-md bg-cyan px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
            >
              Connect
            </button>
          )}
          {isOauth && server.oauthConnectedByMe && (
            <button
              type="button"
              onClick={onOauthDisconnect}
              className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50"
              title="Sign out from this MCP server"
            >
              Sign out
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50"
          >
            {server.enabled ? "Disable" : "Enable"}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50"
            title="Re-fetch tools list now"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-700 hover:bg-gray-50"
          >
            Edit
          </button>
          {/* Only for a server this account owns. An instance server is
              removed for everybody from Admin → Instance MCP servers; the
              user-facing way to be rid of it is Disable, which writes an
              override on their own row. */}
          {!server.inherited && (
            <button
              type="button"
              onClick={onDelete}
              className="rounded-md border border-rose-200 bg-white px-2.5 py-1 text-[11px] text-rose-700 hover:bg-rose-50"
            >
              {server.overridesInstance ? "Reset to instance" : "Delete"}
            </button>
          )}
        </div>
      </div>
      {server.lastError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 font-mono text-[11px] text-rose-700">
          last error: {server.lastError}
        </div>
      )}
    </div>
  );
}

function EditModal({
  draft,
  onChange,
  onCancel,
  onSaved,
}: {
  draft: Draft;
  onChange: (next: Draft) => void;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    msg: string;
    tools?: ApiMcpToolSpec[];
  } | null>(null);

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    onChange({ ...draft, [key]: value });
  }

  async function save() {
    if (!draft.name.trim() || !draft.url.trim()) {
      setError("Name and URL are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (draft.id) {
        const patch: Partial<Omit<ApiMcpServerInput, "slug">> = {
          name: draft.name.trim(),
          transport: draft.transport,
          url: draft.url.trim(),
          authKind: draft.authKind,
          enabled: draft.enabled,
        };
        if (draft.authHeaderDirty) {
          patch.authHeader = draft.authHeader.trim() || null;
        }
        await api.updateMcpServer(draft.id, patch);
      } else {
        const body: ApiMcpServerInput = {
          name: draft.name.trim(),
          transport: draft.transport,
          url: draft.url.trim(),
          authKind: draft.authKind,
          enabled: draft.enabled,
        };
        if (draft.slug.trim()) body.slug = draft.slug.trim();
        if (draft.authKind === "bearer" && draft.authHeader.trim()) {
          body.authHeader = draft.authHeader.trim();
        }
        await api.createMcpServer(body);
      }
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    if (!draft.url.trim()) {
      setError("URL is required to test.");
      return;
    }
    setBusy(true);
    setTestResult(null);
    setError(null);
    try {
      const body: ApiMcpServerInput = {
        name: draft.name.trim() || "test",
        transport: draft.transport,
        url: draft.url.trim(),
      };
      if (draft.slug.trim()) body.slug = draft.slug.trim();
      if (draft.authHeader.trim()) body.authHeader = draft.authHeader.trim();
      const r = await api.testMcpServer(body);
      if (r.ok) {
        setTestResult({
          ok: true,
          msg: `✓ Connected · ${r.toolsCount} tool${r.toolsCount === 1 ? "" : "s"}`,
          tools: r.tools,
        });
      } else {
        setTestResult({ ok: false, msg: r.error || "connection failed" });
      }
    } catch (e) {
      setTestResult({ ok: false, msg: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-ink/40 p-6"
      onClick={onCancel}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-[600px] flex-col gap-4 overflow-y-auto rounded-2xl border border-gray-200 bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-[20px] font-light text-navy">
          {draft.id ? "Edit MCP server" : "Add MCP server"}
        </h3>

        <Field label="Name" required>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Notion"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
          />
        </Field>

        {!draft.id && (
          <Field
            label="Slug"
            hint="Optional — auto-derived from name. Lowercase ascii + dashes. Used to namespace tools: mcp_<slug>_<tool>."
          >
            <input
              type="text"
              value={draft.slug}
              onChange={(e) =>
                set(
                  "slug",
                  e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]/g, "-")
                    .replace(/^-+|-+$/g, ""),
                )
              }
              placeholder="(auto)"
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] outline-none focus:border-cyan"
            />
          </Field>
        )}

        <Field label="Transport">
          <select
            value={draft.transport}
            onChange={(e) =>
              set("transport", e.target.value as Draft["transport"])
            }
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
          >
            <option value="streamable_http">Streamable HTTP (modern)</option>
            <option value="sse">SSE (legacy)</option>
          </select>
        </Field>

        <Field label="URL" required>
          <input
            type="url"
            value={draft.url}
            onChange={(e) => set("url", e.target.value)}
            placeholder="https://example.com/mcp"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] outline-none focus:border-cyan"
          />
        </Field>

        <Field
          label="Authentication"
          hint={
            draft.authKind === "oauth"
              ? "Use OAuth 2.1 with PKCE — appropriate for Notion, Linear, GitHub, etc. After saving, click 'Connect' on the server card to authorize."
              : draft.authKind === "bearer"
                ? "Static bearer token, set once."
                : "No authentication — for local / unauthenticated servers."
          }
        >
          <select
            value={draft.authKind}
            onChange={(e) =>
              set("authKind", e.target.value as Draft["authKind"])
            }
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-cyan"
          >
            <option value="bearer">Bearer token (static)</option>
            <option value="oauth">OAuth 2.1 (Notion, Linear, …)</option>
            <option value="none">None</option>
          </select>
        </Field>

        {draft.authKind === "bearer" && (
          <Field
            label={
              draft.id && !draft.authHeaderDirty
                ? "Auth header (leave blank to keep existing)"
                : "Auth header"
            }
            hint='Examples: "Bearer sk_test_…" · "X-API-Key: abc123". Stored as plain text in DB.'
          >
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft.authHeader}
              onChange={(e) =>
                // Single onChange call — two consecutive set("authHeader",…)
                // + set("authHeaderDirty",…) used to lose every keystroke
                // because the second set() closed over the pre-update draft
                // and React batched both into one render. UX brief 2026-05-19:
                // "le auth header n'accepte pas le paste, impossible, pas
                // éditable en fait, même le type ne marche pas."
                onChange({
                  ...draft,
                  authHeader: e.target.value,
                  authHeaderDirty: true,
                })
              }
              placeholder={
                draft.id && !draft.authHeaderDirty
                  ? "•••••••• (saved)"
                  : "Bearer sk_…"
              }
              className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] outline-none focus:border-cyan"
            />
          </Field>
        )}

        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-gray-700">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />
          <span>Enabled — expose this server's tools to the LLM</span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={testConnection}
            disabled={busy}
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Test connection
          </button>
          {testResult && (
            <span
              className={`rounded-md px-2 py-1 font-mono text-[11px] ${
                testResult.ok
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-rose-100 text-rose-700"
              }`}
            >
              {testResult.msg}
            </span>
          )}
        </div>
        {testResult?.ok && testResult.tools && testResult.tools.length > 0 && (
          <details className="rounded-md border border-gray-200 bg-gray-50 p-2">
            <summary className="cursor-pointer text-[12px] text-gray-700">
              Tools exposed ({testResult.tools.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-1 font-mono text-[11px] text-gray-600">
              {testResult.tools.map((t) => (
                <li key={t.name}>
                  <span className="text-ink">{t.name}</span>
                  {t.description && (
                    <span className="text-gray-500"> — {t.description}</span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 font-mono text-[12px] text-rose-700">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-gray-200 bg-white px-4 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded-md bg-navy px-4 py-1.5 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {busy ? "Saving…" : draft.id ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] tracking-[0.04em] text-gray-500 uppercase">
        {label}
        {required && <span className="ml-1 text-rose-500">*</span>}
      </span>
      {children}
      {hint && (
        <span className="font-mono text-[11px] text-gray-400">{hint}</span>
      )}
    </div>
  );
}
