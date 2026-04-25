import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiGlobalModel } from "~/lib/api";

export type SelectedModel = {
  id: string; // "auto" or a real model id
  serverId: string | null; // null when "auto"
};

type Props = {
  selected: SelectedModel;
  onChange: (next: SelectedModel) => void;
};

export default function ModelPicker({ selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ApiGlobalModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || models) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function refresh() {
    setLoading(true);
    setError(null);
    api
      .listAllModels()
      .then((r) => setModels(r.models))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }

  // Group by server, with deterministic order = order of first appearance.
  const groups = useMemo(() => {
    if (!models) return [];
    const map = new Map<
      string,
      { serverId: string; serverName: string; loaded: ApiGlobalModel[]; registered: ApiGlobalModel[] }
    >();
    for (const m of models) {
      const key = m.serverId;
      if (!map.has(key)) {
        map.set(key, {
          serverId: m.serverId,
          serverName: m.serverName,
          loaded: [],
          registered: [],
        });
      }
      const group = map.get(key)!;
      if (m.loaded) group.loaded.push(m);
      else group.registered.push(m);
    }
    return Array.from(map.values());
  }, [models]);

  const totalLoaded = groups.reduce((n, g) => n + g.loaded.length, 0);
  const totalRegistered = groups.reduce((n, g) => n + g.registered.length, 0);

  const selectedDisplay =
    selected.id === "auto" || !selected.id
      ? "auto"
      : models?.find((m) => m.id === selected.id && m.serverId === selected.serverId)?.name ??
        stripPrefix(selected.id);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-50"
      >
        <span className="max-w-[220px] truncate font-mono text-[12px] text-ink">
          {selectedDisplay}
        </span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="absolute top-full left-0 z-40 mt-1 w-[400px] rounded-xl border border-gray-200 bg-white shadow-[0_10px_30px_rgba(10,10,10,0.12)]">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <div className="flex items-center gap-3 text-[11px] font-mono tracking-[0.08em] text-gray-400 uppercase">
              <span>Models</span>
              {totalLoaded > 0 && (
                <span className="text-emerald-600">{totalLoaded} loaded</span>
              )}
              {totalRegistered > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="normal-case text-gray-500 hover:text-ink"
                >
                  {showAll ? "Hide registered" : `+ ${totalRegistered} registered`}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-gray-500 hover:text-ink"
            >
              Refresh
            </button>
          </div>

          <div className="max-h-[400px] overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                onChange({ id: "auto", serverId: null });
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between px-3 py-2 text-left ${
                selected.id === "auto"
                  ? "bg-[rgba(79,179,217,0.12)]"
                  : "hover:bg-gray-50"
              }`}
            >
              <span className="font-mono text-[12px] text-ink">auto</span>
              <span className="text-[11px] text-gray-400">
                pick a loaded model on the active server
              </span>
            </button>

            {loading && !models && (
              <div className="px-3 py-6 text-center font-mono text-[11px] text-gray-400">
                Loading…
              </div>
            )}

            {groups.map((g) => {
              const visible = showAll ? [...g.loaded, ...g.registered] : g.loaded;
              if (visible.length === 0) return null;
              return (
                <div key={g.serverId} className="border-t border-gray-100 first:border-t-0">
                  <div className="px-3 py-1.5 font-sans text-[10px] font-medium tracking-[0.08em] text-gray-400 uppercase">
                    {g.serverName}
                  </div>
                  {visible.map((m) => {
                    const isActive =
                      selected.id === m.id && selected.serverId === m.serverId;
                    return (
                      <button
                        key={`${m.serverId}:${m.id}`}
                        type="button"
                        onClick={() => {
                          onChange({ id: m.id, serverId: m.serverId });
                          setOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left ${
                          isActive
                            ? "bg-[rgba(79,179,217,0.12)]"
                            : "hover:bg-gray-50"
                        }`}
                      >
                        <span className="truncate font-mono text-[12px] text-ink">
                          {m.name}
                        </span>
                        {m.loaded ? (
                          <span className="flex-shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                            loaded
                          </span>
                        ) : (
                          <span className="flex-shrink-0 text-[10px] text-gray-400">
                            registered
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {!loading && models !== null && groups.length === 0 && (
              <div className="px-3 py-6 text-center font-mono text-[11px] text-gray-400">
                No models on any server.
              </div>
            )}
          </div>

          {error && (
            <div className="border-t border-gray-100 px-3 py-2 font-mono text-[11px] text-red-600">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function stripPrefix(id: string): string {
  const slash = id.indexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

function ChevronDownIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-gray-400"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
