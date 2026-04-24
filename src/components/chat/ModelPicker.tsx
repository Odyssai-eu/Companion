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
  }, [open, serverId, models]);

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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!serverId}
        className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-50 disabled:opacity-50"
      >
        <span className="max-w-[220px] truncate font-mono text-[12px] text-ink">
          {model ?? "auto"}
        </span>
        <ChevronDownIcon />
      </button>

      {open && (
        <div className="absolute top-full left-0 z-40 mt-1 w-[320px] rounded-xl border border-gray-200 bg-white shadow-[0_10px_30px_rgba(10,10,10,0.12)]">
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <span className="font-mono text-[11px] tracking-[0.08em] text-gray-400 uppercase">
              Models
            </span>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-gray-500 hover:text-ink"
            >
              Refresh
            </button>
          </div>

          <div className="max-h-[320px] overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                onChange("auto");
                setOpen(false);
              }}
              className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-gray-50"
            >
              <span className="font-mono text-[12px] text-ink">auto</span>
              <span className="text-[11px] text-gray-400">pick loaded</span>
            </button>
            {loading && !models && (
              <div className="px-3 py-6 text-center font-mono text-[11px] text-gray-400">
                Loading…
              </div>
            )}
            {models?.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left ${
                  model === m.id ? "bg-[rgba(79,179,217,0.12)]" : "hover:bg-gray-50"
                }`}
              >
                <span className="truncate font-mono text-[12px] text-ink">
                  {m.id}
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
            ))}
            {!loading && models?.length === 0 && !error && (
              <div className="px-3 py-6 text-center font-mono text-[11px] text-gray-400">
                No models reported.
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
