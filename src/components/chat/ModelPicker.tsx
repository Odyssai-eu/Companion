import { useEffect, useRef, useState } from "react";
import { api, type ApiModel } from "~/lib/api";

type Props = {
  serverId: string | null;
  model: string | null;
  onChange: (model: string) => void;
};

export default function ModelPicker({ serverId, model, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ApiModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !serverId || models) return;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, serverId]);

  function refresh() {
    if (!serverId) return;
    setLoading(true);
    setError(null);
    api
      .listModels(serverId)
      .then((r) => {
        setModels(r.models);
        if (r.error) setError(r.error);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }

  const activeName =
    models?.find((m) => m.id === model)?.name ??
    (model && model !== "auto" ? stripPrefix(model) : "auto");

  const loaded = models?.filter((m) => m.loaded) ?? [];
  const registered = models?.filter((m) => !m.loaded) ?? [];
  const visible = showAll ? [...loaded, ...registered] : loaded;

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!serverId}
        className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50"
      >
        <span className="max-w-[220px] truncate font-mono text-[12px] text-ink">
          {activeName}
        </span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="absolute top-full left-0 z-40 mt-1 w-[360px] rounded-xl border border-gray-200 bg-white shadow-[0_10px_30px_rgba(10,10,10,0.12)]">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <div className="flex items-center gap-3 text-[11px] font-mono tracking-[0.08em] text-gray-400 uppercase">
              <span>Models</span>
              {loaded.length > 0 && (
                <span className="text-emerald-600">{loaded.length} loaded</span>
              )}
              {registered.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="normal-case text-gray-500 hover:text-ink"
                >
                  {showAll
                    ? "Hide registered"
                    : `+ ${registered.length} registered`}
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

          <div className="max-h-[360px] overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                onChange("auto");
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between px-3 py-2 text-left ${
                model === "auto" || !model
                  ? "bg-[rgba(79,179,217,0.12)]"
                  : "hover:bg-gray-50"
              }`}
            >
              <span className="font-mono text-[12px] text-ink">auto</span>
              <span className="text-[11px] text-gray-400">pick a loaded one</span>
            </button>

            {loading && !models && (
              <div className="px-3 py-6 text-center font-mono text-[11px] text-gray-400">
                Loading…
              </div>
            )}

            {visible.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left ${
                  model === m.id
                    ? "bg-[rgba(79,179,217,0.12)]"
                    : "hover:bg-gray-50"
                }`}
              >
                <span className="flex w-full items-center justify-between gap-2">
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
                </span>
                {m.endpoints.length > 0 && (
                  <span className="font-mono text-[10px] text-gray-400">
                    {m.endpoints.join(" · ")}
                  </span>
                )}
              </button>
            ))}

            {!loading && models !== null && visible.length === 0 && (
              <div className="px-3 py-6 text-center font-mono text-[11px] text-gray-400">
                {loaded.length === 0 && registered.length > 0
                  ? "No loaded models. Toggle above to see registered."
                  : "No models reported."}
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
