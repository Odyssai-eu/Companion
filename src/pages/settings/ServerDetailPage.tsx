import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import AddEndpointModal from "~/components/settings/AddEndpointModal";
import { api, type ApiEndpoint, type ApiServer } from "~/lib/api";

export default function ServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<{
    server: ApiServer;
    endpoints: ApiEndpoint[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    api
      .getServer(id)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [id]);

  const testAll = useCallback(async () => {
    if (!id) return;
    setTestingAll(true);
    try {
      const res = await api.testServer(id);
      setData((prev) =>
        prev ? { ...prev, endpoints: res.endpoints } : prev,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTestingAll(false);
    }
  }, [id]);

  const testOne = useCallback(
    async (endpointId: string) => {
      if (!id) return;
      setTestingIds((s) => new Set(s).add(endpointId));
      try {
        const res = await api.testEndpoint(id, endpointId);
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            endpoints: prev.endpoints.map((e) =>
              e.id === endpointId ? res.endpoint : e,
            ),
          };
        });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setTestingIds((s) => {
          const next = new Set(s);
          next.delete(endpointId);
          return next;
        });
      }
    },
    [id],
  );

  const rename = useCallback(
    async (name: string) => {
      if (!id) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        const res = await api.updateServer(id, { name: trimmed });
        setData((prev) => (prev ? { ...prev, server: res.server } : prev));
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [id],
  );

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb serverName="Unknown" />
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 font-mono text-[12px] text-red-700">
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb serverName="…" />
        <div className="rounded-xl border border-gray-200 bg-white py-10 text-center">
          <span className="font-mono text-[12px] text-gray-400">Loading…</span>
        </div>
      </div>
    );
  }

  const { server, endpoints } = data;

  return (
    <div className="flex flex-col gap-10">
      <Breadcrumb serverName={server.name} />
      <Header
        server={server}
        endpointCount={endpoints.length}
        onRename={rename}
      />
      <EndpointsSection
        endpoints={endpoints}
        testingAll={testingAll}
        testingIds={testingIds}
        onTestAll={testAll}
        onTestOne={testOne}
        onAddClick={() => setAddOpen(true)}
      />
      <DangerZone />

      {id && (
        <AddEndpointModal
          serverId={id}
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onCreated={(endpoint) => {
            setData((prev) =>
              prev ? { ...prev, endpoints: [...prev.endpoints, endpoint] } : prev,
            );
            setAddOpen(false);
          }}
        />
      )}
    </div>
  );
}

function Breadcrumb({ serverName }: { serverName: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px] text-gray-400">
      <Link
        to="/settings/servers"
        className="flex items-center gap-1.5 text-gray-600 hover:text-ink"
      >
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
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Settings
      </Link>
      <span>·</span>
      <Link to="/settings/servers" className="text-gray-600 hover:text-ink">
        Servers
      </Link>
      <span>/</span>
      <span className="font-medium text-ink">{serverName}</span>
    </div>
  );
}

function Header({
  server,
  endpointCount,
  onRename,
}: {
  server: ApiServer;
  endpointCount: number;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(server.name);

  useEffect(() => {
    if (!editing) setValue(server.name);
  }, [editing, server.name]);

  function save() {
    const trimmed = value.trim();
    if (trimmed && trimmed !== server.name) onRename(trimmed);
    setEditing(false);
  }

  return (
    <header className="flex items-start justify-between gap-6">
      <div className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Infrastructure
        </span>
        <div className="flex items-center gap-4">
          {editing ? (
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setEditing(false);
              }}
              autoFocus
              className="font-display text-[40px] leading-[48px] font-light text-navy outline-none border-b-2 border-cyan bg-transparent"
              style={{ minWidth: 240 }}
            />
          ) : (
            <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
              {server.name}.
            </h1>
          )}
          <span className="flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-[12px] font-medium text-gray-600">
            <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
            Untested
          </span>
        </div>
        {server.description && (
          <p className="max-w-[600px] text-[15px] leading-[24px] text-gray-600">
            {server.description}
          </p>
        )}
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 font-mono text-[12px] text-gray-600">
          <span>
            <span className="text-gray-400">URL</span> {server.url}
          </span>
          <span>
            <span className="text-gray-400">Endpoints</span> {endpointCount}
          </span>
          <span>
            <span className="text-gray-400">Engine</span>{" "}
            {server.engineKind === "anthropic" ? "Anthropic" : "OpenAI-compat"}
          </span>
          {server.authBearer && (
            <span>
              <span className="text-gray-400">Auth</span> Bearer •••
            </span>
          )}
        </div>
      </div>
      <div className="flex flex-shrink-0 gap-2">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="flex h-9 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 text-[13px] font-medium text-ink hover:bg-gray-50"
        >
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
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
          </svg>
          <span className="whitespace-nowrap">{editing ? "Done" : "Rename"}</span>
        </button>
      </div>
    </header>
  );
}

function EndpointsSection({
  endpoints,
  testingAll,
  testingIds,
  onTestAll,
  onTestOne,
  onAddClick,
}: {
  endpoints: ApiEndpoint[];
  testingAll: boolean;
  testingIds: Set<string>;
  onTestAll: () => void;
  onTestOne: (id: string) => void;
  onAddClick: () => void;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <h2 className="font-display text-[22px] font-light text-navy">
            Endpoints
          </h2>
          <p className="max-w-[640px] text-[14px] leading-[20px] text-gray-600">
            One primary endpoint is required. Add secondary endpoints to reach
            individual nodes directly.
          </p>
        </div>
        <button
          type="button"
          onClick={onTestAll}
          disabled={testingAll || endpoints.length === 0}
          className="flex flex-shrink-0 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-[13px] font-medium text-ink hover:bg-gray-50 disabled:opacity-50"
        >
          <PlayIcon />
          <span className="whitespace-nowrap">
            {testingAll ? "Testing…" : "Test all"}
          </span>
        </button>
      </div>

      <div className="flex flex-col gap-2.5">
        {endpoints.length === 0 && (
          <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 text-[13px] text-gray-600">
            No endpoints yet. Add one to reach this server.
          </div>
        )}
        {endpoints.map((e) => (
          <EndpointRow
            key={e.id}
            endpoint={e}
            testing={testingIds.has(e.id) || testingAll}
            onTest={() => onTestOne(e.id)}
          />
        ))}
        <AddEndpointRow onClick={onAddClick} />
      </div>
    </section>
  );
}

function EndpointRow({
  endpoint,
  testing,
  onTest,
}: {
  endpoint: ApiEndpoint;
  testing: boolean;
  onTest: () => void;
}) {
  const isPrimary = endpoint.role === "primary";
  return (
    <div className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4">
      <div className="flex w-[180px] flex-shrink-0 flex-col gap-1">
        <span className="text-[14px] font-medium text-ink">
          {endpoint.label}
        </span>
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              isPrimary
                ? "bg-[rgba(79,179,217,0.12)] text-navy"
                : "bg-gray-100 text-gray-600"
            }`}
          >
            {isPrimary ? "Primary" : "Secondary"}
          </span>
          {endpoint.node && (
            <span className="font-mono text-[12px] text-gray-400">
              {endpoint.node}
            </span>
          )}
        </div>
      </div>

      <div className="flex h-10 w-[200px] flex-shrink-0 items-center rounded-lg border border-gray-200 bg-white px-3">
        <span className="font-mono text-[14px] text-ink">{endpoint.ip}</span>
      </div>
      <span className="flex-shrink-0 font-mono text-[14px] text-gray-400">:</span>
      <div className="flex h-10 w-[100px] flex-shrink-0 items-center justify-between rounded-lg border border-gray-200 bg-white px-3">
        <span className="font-mono text-[14px] text-ink">{endpoint.port}</span>
      </div>

      <button
        type="button"
        onClick={onTest}
        disabled={testing}
        className="flex h-10 flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 text-[13px] font-medium text-ink hover:bg-gray-50 disabled:opacity-50"
      >
        <PlayIcon small />
        <span className="whitespace-nowrap">{testing ? "…" : "Test"}</span>
      </button>

      <EndpointStatus endpoint={endpoint} testing={testing} />
    </div>
  );
}

function EndpointStatus({
  endpoint,
  testing,
}: {
  endpoint: ApiEndpoint;
  testing: boolean;
}) {
  if (testing) {
    return (
      <div className="flex flex-1 items-center gap-2 font-mono text-[12px] text-gray-400">
        <span>Pinging…</span>
      </div>
    );
  }
  if (endpoint.latencyMs !== null && endpoint.healthy) {
    return (
      <div className="flex flex-1 items-center gap-2 font-mono text-[12px] text-emerald-600">
        <CheckIcon />
        <span>{endpoint.latencyMs}ms</span>
      </div>
    );
  }
  if (endpoint.healthy === false) {
    return (
      <div className="flex flex-1 items-center gap-2 font-mono text-[12px] text-red-600">
        <CrossIcon />
        <span>unreachable</span>
      </div>
    );
  }
  return (
    <div className="flex flex-1 items-center gap-2 font-mono text-[12px] text-gray-400">
      <span>—</span>
    </div>
  );
}

function CrossIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function AddEndpointRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center gap-2.5 rounded-xl border border-dashed border-gray-300 bg-transparent py-4 text-[14px] font-medium text-gray-600 hover:border-gray-400 hover:text-ink"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
      Add endpoint
    </button>
  );
}

function DangerZone() {
  return (
    <div className="flex items-center justify-between gap-6 rounded-xl border border-red-200 bg-red-50/40 px-5 py-4">
      <div className="flex flex-col gap-1">
        <span className="text-[14px] font-medium text-red-800">
          Remove server
        </span>
        <span className="text-[13px] leading-[20px] text-red-900/70">
          Conversations tied to this server stay in your history. You can
          re-add it anytime.
        </span>
      </div>
      <button
        type="button"
        className="flex h-9 items-center rounded-lg border border-red-600 bg-white px-4 text-[13px] font-medium whitespace-nowrap text-red-600 hover:bg-red-50"
      >
        Remove server
      </button>
    </div>
  );
}

function PlayIcon({ small = false }: { small?: boolean }) {
  const size = small ? 12 : 14;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}
