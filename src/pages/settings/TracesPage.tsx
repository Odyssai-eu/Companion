import { useEffect, useState } from "react";

/**
 * Settings → Traces (admin, v2.0 δ).
 *
 * Observability over the agent runtime: per-agent aggregates
 * (llm/tool/task spans, tokens, durations, errors) and the recent task
 * runs. Data window = 30 days (telemetry purge); the durable record of
 * any task stays in its sub-conversation, reachable from its task card.
 */

type AgentAgg = {
  agent: string;
  type: "llm" | "tool" | "task";
  count: number;
  tokensIn: number;
  tokensOut: number;
  avgDurationMs: number;
  errors: number;
};

type RecentTask = {
  spanId: string;
  agent: string;
  status: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  conversationId: string;
  conversationTitle: string | null;
};

export default function TracesPage() {
  const [byAgent, setByAgent] = useState<AgentAgg[]>([]);
  const [recent, setRecent] = useState<RecentTask[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/agent-traces", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as { byAgent: AgentAgg[]; recentTasks: RecentTask[] };
      })
      .then((d) => {
        setByAgent(d.byAgent);
        setRecent(d.recentTasks);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h2 className="font-display text-[28px] font-light text-navy">
          Agent traces
        </h2>
        <p className="mt-1 max-w-xl text-[13px] text-gray-600">
          Runtime telemetry, 30-day window. The durable transcript of any
          task lives in its sub-conversation (open it from the task card).
        </p>
      </header>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <section>
        <h3 className="mb-2 font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
          Per-agent aggregates
        </h3>
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-[13px]">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-medium tracking-[0.06em] text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-2">Agent</th>
                <th className="px-4 py-2">Span</th>
                <th className="px-4 py-2 text-right">Count</th>
                <th className="px-4 py-2 text-right">Tokens in</th>
                <th className="px-4 py-2 text-right">Tokens out</th>
                <th className="px-4 py-2 text-right">Avg ms</th>
                <th className="px-4 py-2 text-right">Errors</th>
              </tr>
            </thead>
            <tbody>
              {byAgent.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                    No spans yet — run a task.
                  </td>
                </tr>
              )}
              {byAgent.map((a) => (
                <tr key={`${a.agent}-${a.type}`} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-mono text-[12px]">{a.agent}</td>
                  <td className="px-4 py-2 text-gray-500">{a.type}</td>
                  <td className="px-4 py-2 text-right">{a.count}</td>
                  <td className="px-4 py-2 text-right">{a.tokensIn.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">{a.tokensOut.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">{a.avgDurationMs.toLocaleString()}</td>
                  <td className={`px-4 py-2 text-right ${a.errors > 0 ? "text-red-600" : "text-gray-400"}`}>
                    {a.errors}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="mb-2 font-sans text-[11px] font-medium tracking-[0.08em] text-gray-400 uppercase">
          Recent tasks
        </h3>
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-[13px]">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-[11px] font-medium tracking-[0.06em] text-gray-500 uppercase">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Agent</th>
                <th className="px-4 py-2">Conversation</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Steps</th>
                <th className="px-4 py-2 text-right">Tokens</th>
                <th className="px-4 py-2 text-right">Duration</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-gray-400">
                    No task runs in the window.
                  </td>
                </tr>
              )}
              {recent.map((t) => (
                <tr key={t.spanId} className="border-t border-gray-100">
                  <td className="px-4 py-2 whitespace-nowrap text-gray-500">
                    {new Date(t.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-[12px]">{t.agent}</td>
                  <td className="max-w-[220px] truncate px-4 py-2 text-gray-700">
                    {t.conversationTitle ?? t.conversationId.slice(0, 8)}
                  </td>
                  <td
                    className={`px-4 py-2 ${
                      t.status === "ok" || t.status === "done"
                        ? "text-emerald-600"
                        : t.status === "truncated"
                          ? "text-amber-600"
                          : "text-red-600"
                    }`}
                  >
                    {t.status}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {String((t.payload as { steps?: number })?.steps ?? "—")}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {((t.tokensIn ?? 0) + (t.tokensOut ?? 0)).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {t.durationMs != null ? `${(t.durationMs / 1000).toFixed(1)}s` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
