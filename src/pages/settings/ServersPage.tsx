import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import AddServerModal from "~/components/settings/AddServerModal";
import { api, type ApiServer } from "~/lib/api";

export default function ServersPage() {
  const [servers, setServers] = useState<ApiServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const refetch = useCallback(() => {
    api
      .listServers()
      .then((data) => setServers(data.servers))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return (
    <div className="flex flex-col gap-10">
      <PageHeader />
      <div className="flex flex-col gap-3">
        {error && <ErrorBox message={error} />}
        {!servers && !error && <Loading />}
        {servers?.map((s) => <ServerCard key={s.id} server={s} />)}
        {servers && <AddServerRow onClick={() => setAddOpen(true)} />}
      </div>

      <AddServerModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={() => {
          setAddOpen(false);
          refetch();
        }}
      />
    </div>
  );
}

function PageHeader() {
  return (
    <header className="flex flex-col gap-2">
      <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
        Infrastructure
      </span>
      <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
        Servers.
      </h1>
      <p className="max-w-[560px] text-[15px] leading-[24px] text-gray-600">
        Inference endpoints you can reach. Add as many as you need — home,
        office, a client's lab.
      </p>
    </header>
  );
}

function ServerCard({ server }: { server: ApiServer }) {
  return (
    <Link
      to={`/settings/servers/${server.id}`}
      className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-5 transition-all hover:border-cyan hover:shadow-[0_1px_3px_rgba(10,10,10,0.04)]"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[rgba(79,179,217,0.12)]">
            <HardwareIcon />
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-medium text-ink">
                {server.name}
              </span>
              {server.hint && (
                <span className="text-[14px] text-gray-400">
                  · {server.hint}
                </span>
              )}
            </div>
            <span className="truncate font-mono text-[12px] text-gray-400">
              {server.url}
            </span>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <UntestedBadge />
          <MoreButton />
        </div>
      </div>
    </Link>
  );
}

function UntestedBadge() {
  return (
    <span className="flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-[12px] font-medium text-gray-600">
      <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
      Untested
    </span>
  );
}

function MoreButton() {
  return (
    <button
      type="button"
      aria-label="More"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-50 hover:text-ink"
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
  );
}

function AddServerRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-between gap-4 rounded-xl border border-dashed border-gray-300 bg-transparent p-5 text-left transition-colors hover:border-gray-400 hover:bg-white"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-gray-400">
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
        </div>
        <div className="flex flex-col">
          <span className="text-[15px] font-medium text-ink">Add a server</span>
          <span className="text-[13px] text-gray-400">
            Paste an endpoint URL, or scan your LAN.
          </span>
        </div>
      </div>
      <span className="rounded-lg bg-navy px-4 py-2 text-[13px] font-medium text-white">
        Add server
      </span>
    </button>
  );
}

function Loading() {
  return (
    <div className="flex items-center justify-center rounded-xl border border-gray-200 bg-white py-10">
      <span className="font-mono text-[12px] text-gray-400">Loading…</span>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 font-mono text-[12px] text-red-700">
      {message}
    </div>
  );
}

function HardwareIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#0F2F4F"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}
