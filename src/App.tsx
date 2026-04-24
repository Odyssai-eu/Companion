import { useEffect, useState } from "react";

type Health = { status: "ok"; version: string; engines: number };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <main className="flex min-h-full items-center justify-center p-8">
      <div className="flex w-full max-w-xl flex-col gap-10">
        <Wordmark />

        <div className="flex flex-col gap-3">
          <span className="font-mono text-xs uppercase tracking-[0.12em] text-cyan">
            Day 1
          </span>
          <h1 className="font-display text-5xl leading-tight text-navy">
            Your own AI infrastructure, on every device.
          </h1>
          <p className="text-gray-600 leading-relaxed">
            The universal client for local AI inference. Connect any HTTP
            engine — exo, Ollama, Anthropic, OpenRouter — from a single calm
            interface.
          </p>
        </div>

        <HealthCard health={health} />
      </div>
    </main>
  );
}

function Wordmark() {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan">
        <span className="font-mono text-sm font-medium text-white">[B]</span>
      </div>
      <span className="font-mono text-lg tracking-tight">
        <span className="text-cyan font-medium">&gt;</span>
        <span className="font-light"> the comp</span>
        <span className="text-cyan font-medium">.ai</span>
      </span>
    </div>
  );
}

function HealthCard({ health }: { health: Health | null }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-[0.08em] text-gray-400">
          Backend
        </span>
        <span
          className={`flex items-center gap-2 text-xs font-medium ${
            health ? "text-emerald-700" : "text-gray-400"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              health ? "bg-emerald-500" : "bg-gray-400"
            }`}
          />
          {health ? "Connected" : "Offline"}
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-4 font-mono text-sm">
        <Stat label="Status" value={health?.status ?? "—"} />
        <Stat label="Version" value={health?.version ?? "—"} />
        <Stat label="Engines" value={health?.engines?.toString() ?? "—"} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-sans text-[11px] uppercase tracking-[0.08em] text-gray-400">
        {label}
      </span>
      <span className="text-ink">{value}</span>
    </div>
  );
}
