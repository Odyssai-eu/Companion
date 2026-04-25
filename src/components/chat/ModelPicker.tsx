import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ApiGlobalModel } from "~/lib/api";

export type SelectedModel = {
  id: string; // "auto" or a real model id
  serverId: string | null; // null when "auto"
};

type Source = "local" | "cloud";

const SOURCE_KEY = "thecompai:modelSource";

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
  const [source, setSource] = useState<Source>(() => {
    if (typeof window === "undefined") return "local";
    const stored = window.localStorage.getItem(SOURCE_KEY);
    return stored === "cloud" ? "cloud" : "local";
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SOURCE_KEY, source);
    }
  }, [source]);

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

  const counts = useMemo(() => {
    if (!models) return { local: 0, cloud: 0 };
    return {
      local: models.filter((m) => m.source === "local").length,
      cloud: models.filter((m) => m.source === "cloud").length,
    };
  }, [models]);

  const visible = useMemo(() => {
    if (!models) return [];
    return models.filter((m) => m.source === source);
  }, [models, source]);

  // Local models: group by server. Cloud models: group by provider (if known).
  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        label: string;
        loaded: ApiGlobalModel[];
        registered: ApiGlobalModel[];
      }
    >();
    for (const m of visible) {
      const key =
        source === "local"
          ? m.serverId
          : m.provider ?? m.serverName.toLowerCase();
      const label =
        source === "local"
          ? m.serverName
          : m.provider
            ? capitalize(m.provider)
            : m.serverName;
      if (!map.has(key)) {
        map.set(key, { key, label, loaded: [], registered: [] });
      }
      const group = map.get(key)!;
      if (m.loaded) group.loaded.push(m);
      else group.registered.push(m);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [visible, source]);

  const totalLoaded = groups.reduce((n, g) => n + g.loaded.length, 0);
  const totalRegistered = groups.reduce((n, g) => n + g.registered.length, 0);

  const selectedDisplay =
    selected.id === "auto" || !selected.id
      ? "auto"
      : models?.find(
          (m) => m.id === selected.id && m.serverId === selected.serverId,
        )?.name ?? stripPrefix(selected.id);

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
          {/* Source toggle */}
          <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-3 py-2">
            <div className="flex gap-0.5 rounded-lg border border-gray-200 bg-white p-0.5">
              <SourceTab
                label="Local"
                count={counts.local}
                active={source === "local"}
                onClick={() => setSource("local")}
              />
              <SourceTab
                label="Cloud"
                count={counts.cloud}
                active={source === "cloud"}
                onClick={() => setSource("cloud")}
              />
            </div>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-gray-500 hover:text-ink"
            >
              Refresh
            </button>
          </div>

          {/* Counts strip */}
          <div className="flex items-center gap-3 border-b border-gray-100 px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-gray-400 uppercase">
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

          {/* List */}
          <div className="max-h-[420px] overflow-y-auto py-1">
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
                <div
                  key={g.key}
                  className="border-t border-gray-100 first:border-t-0"
                >
                  <div className="px-3 py-1.5 font-sans text-[10px] font-medium tracking-[0.08em] text-gray-400 uppercase">
                    {g.label}
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
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-mono text-[12px] text-ink">
                            {m.name}
                          </span>
                          {m.capabilities?.vision && (
                            <span
                              title="Vision-capable"
                              className="flex-shrink-0 rounded bg-violet-50 px-1.5 py-0.5 font-mono text-[9px] font-medium text-violet-700"
                            >
                              👁
                            </span>
                          )}
                          {m.capabilities?.tools && (
                            <span
                              title="Function calling"
                              className="flex-shrink-0 rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[9px] font-medium text-amber-700"
                            >
                              ⚒
                            </span>
                          )}
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
                {source === "cloud"
                  ? "No cloud server. Add OpenRouter or Anthropic in Settings."
                  : "No local server. Add an exo or Ollama server in Settings."}
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

function SourceTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] transition-colors ${
        active
          ? "bg-gray-50 font-medium text-ink"
          : "font-normal text-gray-400 hover:text-ink"
      }`}
    >
      {label}
      <span
        className={`font-mono text-[10px] ${
          active ? "text-gray-500" : "text-gray-400"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
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
