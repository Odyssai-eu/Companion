import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api, type ApiServer } from "~/lib/api";

type EngineEntry = {
  kind: string;
  label: string;
  icon: string;
  servers: ApiServer[];
};

const ENGINE_META: Record<string, { label: string; icon: string }> = {
  "openai-compat": { label: "OpenAI-compatible", icon: "🖥" },
  anthropic: { label: "Anthropic", icon: "◆" },
};

export default function EnginesPage() {
  const [servers, setServers] = useState<ApiServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listServers()
      .then((r) => setServers(r.servers))
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Infrastructure
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Engines.
        </h1>
        <p className="max-w-[560px] text-[15px] leading-[24px] text-gray-600">
          Every inference engine you've configured, grouped by protocol.
          OpenAI-compatible covers exo, Ollama, LM Studio, vLLM, OpenRouter.
          Anthropic uses its own messages API.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 font-mono text-[12px] text-red-700">
          {error}
        </div>
      )}

      {!servers && !error && (
        <div className="rounded-xl border border-gray-200 bg-white py-10 text-center">
          <span className="font-mono text-[11px] text-gray-400">Loading…</span>
        </div>
      )}

      {servers && <EngineList servers={servers} />}
    </div>
  );
}

function EngineList({ servers }: { servers: ApiServer[] }) {
  const byKind: Record<string, ApiServer[]> = {};
  for (const s of servers) {
    const k = s.engineKind || "openai-compat";
    if (!byKind[k]) byKind[k] = [];
    byKind[k].push(s);
  }
  const entries: EngineEntry[] = Object.entries(byKind).map(([kind, srvs]) => ({
    kind,
    label: ENGINE_META[kind]?.label ?? kind,
    icon: ENGINE_META[kind]?.icon ?? "▲",
    servers: srvs,
  }));

  if (entries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-white py-10 text-center text-[13px] text-gray-500">
        No engines yet. Add a server in{" "}
        <Link
          to="/settings/servers"
          className="font-medium text-cyan hover:underline"
        >
          Servers
        </Link>
        .
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-8">
      {entries.map((e) => (
        <EngineGroup key={e.kind} entry={e} />
      ))}
    </section>
  );
}

function EngineGroup({ entry }: { entry: EngineEntry }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <span className="font-display text-[22px] font-light text-navy">
          {entry.label}
        </span>
        <span className="font-mono text-[12px] text-gray-400">
          {entry.servers.length} {entry.servers.length === 1 ? "server" : "servers"}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {entry.servers.map((s) => (
          <Link
            key={s.id}
            to={`/settings/servers/${s.id}`}
            className="flex items-center justify-between gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4 transition-colors hover:border-cyan"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-[14px] font-medium text-ink">{s.name}</span>
              <span className="truncate font-mono text-[12px] text-gray-400">
                {s.url}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {s.authBearer && (
                <span className="font-mono text-[11px] text-gray-400">
                  Bearer •••
                </span>
              )}
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#9CA3AF"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 18l6-6-6-6" />
              </svg>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
