import { Link, useParams } from "react-router";
import { endpointsByServer, servers, type Endpoint } from "~/data/mock";

export default function ServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const server = servers.find((s) => s.id === id);

  if (!server) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumb serverName="Unknown" />
        <p className="text-gray-600">Server not found.</p>
      </div>
    );
  }

  const endpoints = endpointsByServer[server.id] ?? [];

  return (
    <div className="flex flex-col gap-10">
      <Breadcrumb serverName={server.name} />

      <Header server={server} />

      <StatsCard server={server} />

      <EndpointsSection endpoints={endpoints} />

      <DangerZone />
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

function Header({ server }: { server: { name: string; description?: string } }) {
  return (
    <header className="flex items-start justify-between gap-6">
      <div className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Infrastructure
        </span>
        <div className="flex items-center gap-4">
          <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
            {server.name}.
          </h1>
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[12px] font-medium text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Online
          </span>
        </div>
        {server.description && (
          <p className="max-w-[600px] text-[15px] leading-[24px] text-gray-600">
            {server.description}
          </p>
        )}
      </div>
      <div className="flex flex-shrink-0 gap-2">
        <button
          type="button"
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
          <span className="whitespace-nowrap">Rename</span>
        </button>
        <button
          type="button"
          aria-label="More"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 bg-white text-ink hover:bg-gray-50"
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
            <circle cx="12" cy="5" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="12" cy="19" r="1.5" />
          </svg>
        </button>
      </div>
    </header>
  );
}

type StatsServer = {
  engine: string;
  engineVersion: string;
  nodesOnline: number;
  nodesTotal: number;
  models: number;
  latencyMs: number;
  activeModel?: string;
};

function StatsCard({ server }: { server: StatsServer }) {
  return (
    <div className="grid grid-cols-5 gap-4 rounded-xl border border-gray-200 bg-white px-7 py-6">
      <Stat label="Engine" value={`${server.engine} ${server.engineVersion}`} />
      <Stat label="Nodes" value={`${server.nodesOnline} / ${server.nodesTotal}`} />
      <Stat label="Models" value={String(server.models)} />
      <Stat label="Latency" value={`${server.latencyMs}ms`} />
      <Stat
        label="Active"
        value={
          server.activeModel ? (
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-cyan" />
              <span className="text-cyan">{server.activeModel}</span>
            </span>
          ) : (
            "—"
          )
        }
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
        {label}
      </span>
      <span className="font-mono text-[14px] text-ink">{value}</span>
    </div>
  );
}

function EndpointsSection({ endpoints }: { endpoints: Endpoint[] }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-1.5">
          <h2 className="font-display text-[22px] font-light text-navy">
            Endpoints
          </h2>
          <p className="max-w-[640px] text-[14px] leading-[20px] text-gray-600">
            One primary endpoint is required. Add secondary endpoints to reach
            individual nodes directly — useful for diagnostics or routing
            around a slow link.
          </p>
        </div>
        <button
          type="button"
          className="flex flex-shrink-0 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-[13px] font-medium text-ink hover:bg-gray-50"
        >
          <PlayIcon />
          <span className="whitespace-nowrap">Test all</span>
        </button>
      </div>

      <div className="flex flex-col gap-2.5">
        {endpoints.map((e) => (
          <EndpointRow key={e.id} endpoint={e} />
        ))}
        <AddEndpointRow />
      </div>
    </section>
  );
}

function EndpointRow({ endpoint }: { endpoint: Endpoint }) {
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
          <span className="font-mono text-[12px] text-gray-400">
            {endpoint.node}
          </span>
        </div>
      </div>

      <div className="flex h-10 w-[200px] flex-shrink-0 items-center rounded-lg border border-gray-200 bg-white px-3">
        <span className="font-mono text-[14px] text-ink">{endpoint.ip}</span>
      </div>
      <span className="flex-shrink-0 font-mono text-[14px] text-gray-400">:</span>
      <div className="flex h-10 w-[100px] flex-shrink-0 items-center justify-between rounded-lg border border-gray-200 bg-white px-3">
        <span className="font-mono text-[14px] text-ink">{endpoint.port}</span>
        <div className="flex flex-col gap-0.5 text-gray-400">
          <CaretUp />
          <CaretDown />
        </div>
      </div>

      <button
        type="button"
        className="flex h-10 flex-shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 text-[13px] font-medium text-ink hover:bg-gray-50"
      >
        <PlayIcon small />
        <span className="whitespace-nowrap">Test</span>
      </button>

      <div
        className={`flex flex-1 items-center gap-2 font-mono text-[12px] ${
          endpoint.healthy ? "text-emerald-600" : "text-gray-400"
        }`}
      >
        {endpoint.healthy ? (
          <>
            <CheckIcon />
            <span>{endpoint.latencyMs}ms</span>
          </>
        ) : (
          <span>offline</span>
        )}
      </div>

      <button
        type="button"
        aria-label="More"
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-50 hover:text-ink"
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
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      </button>
    </div>
  );
}

function AddEndpointRow() {
  return (
    <button
      type="button"
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

function CaretUp() {
  return (
    <svg
      width="10"
      height="6"
      viewBox="0 0 10 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 5l4-4 4 4" />
    </svg>
  );
}

function CaretDown() {
  return (
    <svg
      width="10"
      height="6"
      viewBox="0 0 10 6"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 1l4 4 4-4" />
    </svg>
  );
}
