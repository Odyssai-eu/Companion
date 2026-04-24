import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api, type ApiAddon } from "~/lib/api";

export default function ToolsMenu() {
  const [open, setOpen] = useState(false);
  const [addons, setAddons] = useState<ApiAddon[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const r = await api.listAddons();
        if (!cancelled) setAddons(r.addons);
      } catch {
        // ignore
      }
    }
    refresh();
    const i = setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      clearInterval(i);
    };
  }, []);

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

  const active = (addons ?? []).filter(
    (a) => a.enabled && a.kind !== "core",
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 hover:bg-gray-50"
      >
        <WrenchIcon />
        <span className="text-[12px] font-medium text-ink">Tools</span>
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-[rgba(79,179,217,0.16)] px-1.5 font-mono text-[10px] font-medium text-navy">
          {active.length}
        </span>
      </button>

      {open && (
        <div className="absolute top-full left-0 z-40 mt-1 w-[300px] rounded-xl border border-gray-200 bg-white shadow-[0_10px_30px_rgba(10,10,10,0.12)]">
          <div className="border-b border-gray-100 px-3 py-2">
            <span className="font-mono text-[11px] tracking-[0.08em] text-gray-400 uppercase">
              Active tools
            </span>
          </div>
          <div className="max-h-[300px] overflow-y-auto py-1">
            {active.length === 0 && (
              <div className="px-3 py-6 text-center font-mono text-[11px] text-gray-400">
                No active tools. Enable some in Settings.
              </div>
            )}
            {active.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50"
              >
                <span className="text-[13px] text-ink">{a.name}</span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                  {a.kind === "mcp" ? "MCP" : "Plugin"}
                </span>
              </div>
            ))}
          </div>
          <Link
            to="/settings/add-ons"
            onClick={() => setOpen(false)}
            className="block border-t border-gray-100 px-3 py-2 text-[12px] font-medium text-cyan hover:bg-gray-50"
          >
            Manage add-ons →
          </Link>
        </div>
      )}
    </div>
  );
}

function WrenchIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}
