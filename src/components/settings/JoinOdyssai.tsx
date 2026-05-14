import { useEffect, useState } from "react";
import { api, ApiError } from "~/lib/api";

/**
 * "Join the Odyssai" — discovery & pair flow.
 *
 * 1. Server scans the LAN for engines advertising `vendor: "odyssai.eu"`
 *    on `.well-known/inference-engine.json`.
 * 2. UI shows the list (usually 1 engine in a home setup).
 * 3. User picks one, optionally sets a label, clicks Join.
 * 4. Backend POSTs `/admin/pair` on the engine (no auth — gate is open).
 * 5. Engine returns a crew token, server persists it on the user row.
 *
 * Caveat: the scan runs on the *server* side. In dev this is rpi-dev's
 * LAN — same network as Sophie's home. For users on a different LAN
 * than the Companion backend, the scan won't find their engine and
 * they need the manual-URL fallback below the modal.
 */

type FoundEngine = Awaited<ReturnType<typeof api.searchOdyssai>>[
  "engines"
][number];

type Phase = "scanning" | "found" | "pairing" | "done" | "error";

export function JoinOdyssaiModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("scanning");
  const [engines, setEngines] = useState<FoundEngine[]>([]);
  const [chosen, setChosen] = useState<FoundEngine | null>(null);
  const [userLabel, setUserLabel] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [summary, setSummary] = useState<
    Awaited<ReturnType<typeof api.joinOdyssai>>["summary"] | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    api
      .searchOdyssai()
      .then((d) => {
        if (cancelled) return;
        if (!d.engines.length) {
          setErrorMsg(
            "No Odysseus engines found on the network. Make sure the operator opened the gate (Odysseus → Settings → Crew → Open gate).",
          );
          setPhase("error");
          return;
        }
        setEngines(d.engines);
        setChosen(d.engines[0]);
        setPhase("found");
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorMsg((e as Error).message);
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function join() {
    if (!chosen) return;
    setPhase("pairing");
    setErrorMsg("");
    try {
      const r = await api.joinOdyssai({
        host: chosen.host,
        port: chosen.port,
        user_label: userLabel.trim() || undefined,
      });
      setSummary(r.summary);
      setPhase("done");
      setTimeout(() => {
        onDone();
        onClose();
      }, 1400);
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.code === "gate_closed"
            ? "The Odysseus discovery gate is closed. Ask the operator to open it (Settings → Crew → Open gate)."
            : e.message
          : (e as Error).message;
      setErrorMsg(msg);
      setPhase("error");
    }
  }

  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-ink/40 p-6"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-[520px] flex-col gap-5 rounded-2xl border border-gray-200 bg-white p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <span className="font-sans text-[11px] tracking-[0.08em] text-cyan uppercase">
              Discovery
            </span>
            <h2 className="font-display text-[22px] font-light text-navy">
              Join the Odyssai
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[13px] text-gray-500 hover:text-ink"
          >
            ✕
          </button>
        </header>

        {phase === "scanning" && (
          <div className="flex flex-col gap-2 text-[13px] text-gray-600">
            <div className="font-mono text-[12px] text-gray-500">
              Scanning local network…
            </div>
            <p>
              Make sure the operator opened the gate in Odysseus → Settings →
              Crew → "Open gate". The scan takes 5–10 seconds.
            </p>
          </div>
        )}

        {phase === "found" && chosen && (
          <>
            {engines.length > 1 && (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] tracking-[0.04em] text-gray-500 uppercase">
                  Engines found ({engines.length})
                </span>
                <div className="flex flex-col gap-1">
                  {engines.map((e) => (
                    <button
                      key={e.url}
                      type="button"
                      onClick={() => setChosen(e)}
                      className={`flex flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-[13px] transition-colors ${
                        chosen.url === e.url
                          ? "border-cyan bg-[rgba(79,179,217,0.06)]"
                          : "border-gray-200 bg-white hover:bg-gray-50"
                      }`}
                    >
                      <span className="font-medium text-ink">
                        {e.meta?.name ?? "Odysseus"}
                      </span>
                      <span className="font-mono text-[11px] text-gray-500">
                        {e.host}:{e.port} · v{e.meta?.version ?? "?"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {engines.length <= 1 && (
              <div className="flex flex-col gap-0.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                <span className="text-[13px] font-medium text-emerald-800">
                  ✓ {chosen.meta?.name ?? "Odysseus"}
                </span>
                <span className="font-mono text-[11px] text-emerald-700">
                  at {chosen.host}:{chosen.port} · vendor{" "}
                  {chosen.meta?.vendor ?? "?"} · v{chosen.meta?.version ?? "?"}
                </span>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] tracking-[0.04em] text-gray-500 uppercase">
                Optional label
              </span>
              <input
                type="text"
                value={userLabel}
                onChange={(e) => setUserLabel(e.target.value)}
                placeholder="Sophie's desktop"
                className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-cyan"
              />
              <span className="font-mono text-[11px] text-gray-400">
                Shown to the operator in the engine's Crew tab.
              </span>
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-gray-200 bg-white px-4 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={join}
                className="rounded-md bg-navy px-4 py-1.5 text-[13px] font-medium text-white hover:opacity-95"
              >
                Join
              </button>
            </div>
          </>
        )}

        {phase === "pairing" && (
          <div className="font-mono text-[12px] text-gray-500">
            Pairing with Odysseus…
          </div>
        )}

        {phase === "done" && summary && (
          <div className="flex flex-col gap-2 text-[13px]">
            <div className="text-emerald-700">
              ✓ Paired with Odysseus v{summary.version ?? "?"}
            </div>
            <div className="text-gray-600">
              {summary.modelsCount - summary.cloudAliasesCount} local +{" "}
              {summary.cloudAliasesCount} cloud aliases
            </div>
            <div className="text-gray-600">
              {summary.gateway
                ? "✓ Gateway mode active"
                : "~ Hybrid mode (engine doesn't declare cloud-passthrough)"}
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 font-mono text-[12px] text-rose-700">
              {errorMsg}
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-gray-200 bg-white px-4 py-1.5 text-[13px] text-gray-700 hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
