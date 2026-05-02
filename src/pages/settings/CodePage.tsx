import { useEffect, useState } from "react";
import { api, type ApiCodePreflight, type ApiCodeSession } from "~/lib/api";

const DEFAULT_REPO = "/Users/admin/repos/runner-smoke";
const DEFAULT_MODEL = "claude-haiku";

export default function CodePage() {
  const [repoPath, setRepoPath] = useState(DEFAULT_REPO);
  const [task, setTask] = useState(
    "Prepare a coding session for Hermes/Codex runner work.",
  );
  const [busy, setBusy] = useState(false);
  const [hermesBusy, setHermesBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiCodePreflight | null>(null);
  const [selectedSession, setSelectedSession] = useState<ApiCodeSession | null>(null);
  const [sessions, setSessions] = useState<ApiCodeSession[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);

  async function refreshSessions() {
    try {
      const r = await api.listCodeSessions();
      setSessions(r.sessions);
    } catch {
      // Non-critical for the preflight form.
    }
  }

  useEffect(() => {
    refreshSessions();
  }, []);

  async function runPreflight() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.codePreflight({ repoPath, task, model });
      setResult(r.preflight);
      setSelectedSession(r.session);
      await refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runHermesPreflight() {
    if (!selectedSession) return;
    setHermesBusy(true);
    setError(null);
    try {
      const r = await api.codeHermesPreflight(selectedSession.id, { model });
      setSelectedSession(r.session);
      if (r.session.preflight) setResult(r.session.preflight);
      await refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setHermesBusy(false);
    }
  }

  async function deleteSession(id: string) {
    setError(null);
    try {
      await api.deleteCodeSession(id);
      if (selectedSession?.id === id) {
        setSelectedSession(null);
        setResult(null);
      }
      await refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function clearSessions(scope: "terminal" | "all") {
    setError(null);
    try {
      await api.clearCodeSessions(scope);
      setSelectedSession(null);
      setResult(null);
      await refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <span className="font-sans text-[13px] font-medium tracking-[0.08em] text-cyan uppercase">
          Coding
        </span>
        <h1 className="font-display text-[40px] leading-[48px] font-light text-navy">
          Code sessions.
        </h1>
        <p className="max-w-[720px] text-[15px] leading-[24px] text-gray-600">
          Read-only preflight. It loads repository instructions, local docs,
          memory, and infrastructure facts before any coding agent is allowed to
          write.
        </p>
      </header>

      <section className="flex flex-col gap-4 rounded-xl border border-gray-200 bg-white px-5 py-5">
        <Field label="Repository path">
          <input
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
          />
        </Field>
        <Field label="Task">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={4}
            className="w-full resize-none rounded-md border border-gray-200 bg-white px-3 py-2 text-[13px] leading-[20px] text-ink outline-none focus:border-cyan"
          />
        </Field>
        <Field label="Hermes / LiteLLM model">
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="claude-haiku"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
          />
        </Field>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={runPreflight}
            disabled={busy || !repoPath.trim() || !task.trim()}
            className="rounded-md bg-navy px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {busy ? "Running…" : "Run preflight"}
          </button>
          <span className="font-mono text-[11px] text-gray-400">
            No files are written.
          </span>
        </div>
        <div className="flex items-center gap-3 border-t border-gray-100 pt-3">
          <button
            type="button"
            onClick={runHermesPreflight}
            disabled={
              hermesBusy ||
              !selectedSession ||
              selectedSession.blockers?.length !== 0 ||
              !model.trim()
            }
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] font-medium text-ink hover:bg-gray-50 disabled:opacity-50"
          >
            {hermesBusy ? "Hermes running…" : "Run Hermes read-only"}
          </button>
          <span className="font-mono text-[11px] text-gray-400">
            Uses the selected LiteLLM model. Write mode is still disabled.
          </span>
        </div>
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 font-mono text-[11px] text-red-700">
            {error}
          </div>
        )}
      </section>

      {result && (
        <PreflightReport result={result} session={selectedSession} />
      )}

      <SessionsList
        sessions={sessions}
        onDelete={deleteSession}
        onClear={clearSessions}
        onSelect={(session) => {
          if (session.preflight) setResult(session.preflight);
          setSelectedSession(session);
          setRepoPath(session.repoPath);
          setTask(session.task);
          setModel(session.model ?? DEFAULT_MODEL);
        }}
      />
    </div>
  );
}

function SessionsList({
  sessions,
  onSelect,
  onDelete,
  onClear,
}: {
  sessions: ApiCodeSession[];
  onSelect: (session: ApiCodeSession) => void;
  onDelete: (id: string) => void;
  onClear: (scope: "terminal" | "all") => void;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 className="font-display text-[24px] font-light text-navy">
          Recent sessions
        </h2>
        <span className="text-[12px] text-gray-400">
          Stored preflights, still read-only.
        </span>
        {sessions.length > 0 && (
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => onClear("terminal")}
              className="rounded-md border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50"
            >
              Clear failed
            </button>
            <button
              type="button"
              onClick={() => onClear("all")}
              className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-[12px] text-red-700 hover:bg-red-100"
            >
              Clear all
            </button>
          </div>
        )}
      </div>
      {sessions.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white px-5 py-4 text-[13px] text-gray-500">
          No code sessions yet.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4"
            >
              <button
                type="button"
                onClick={() => onSelect(s)}
                className="flex min-w-0 flex-1 items-center gap-4 text-left"
              >
                <StatusBadge
                  label={s.status}
                  tone={s.status === "blocked" ? "red" : "green"}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-[14px] font-medium text-ink">
                  {s.task}
                </span>
                  <span className="truncate font-mono text-[11px] text-gray-400">
                    {s.repoName} · {s.repoPath}
                  </span>
                </div>
              </button>
              <span className="font-mono text-[11px] text-gray-400">
                {new Date(s.createdAt).toLocaleString()}
              </span>
              <button
                type="button"
                onClick={() => onDelete(s.id)}
                className="rounded-md px-2 py-1 text-[12px] text-gray-400 hover:bg-red-50 hover:text-red-700"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PreflightReport({
  result,
  session,
}: {
  result: ApiCodePreflight;
  session: ApiCodeSession | null;
}) {
  const blockers = result.blockers ?? [];
  const docsRead = result.docsRead ?? [];
  const memorySources = result.memorySources ?? [];
  const factsUsed = result.factsUsed ?? [];
  const forbiddenMoves = result.forbiddenMoves ?? [];
  const manifests = result.manifests ?? [];
  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          label={blockers.length === 0 ? "Ready" : "Blocked"}
          tone={blockers.length === 0 ? "green" : "red"}
        />
        <StatusBadge label={`Risk ${result.risk}`} tone={riskTone(result.risk)} />
        <StatusBadge label={result.gitRepo ? "Git repo" : "Plain folder"} />
        {result.dirtyTree === true && <StatusBadge label="Dirty tree" tone="amber" />}
        {result.dirtyTree === false && <StatusBadge label="Clean tree" tone="green" />}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Repository">
          <KeyValue label="Name" value={result.repoName} />
          <KeyValue label="Path" value={result.repoPath} mono />
          <KeyValue label="Allowed" value={result.allowed ? "yes" : "no"} />
          <KeyValue label="Exists" value={result.repoExists ? "yes" : "no"} />
        </Panel>

        <Panel title="Blockers">
          {blockers.length === 0 ? (
            <span className="text-[13px] text-gray-500">None.</span>
          ) : (
            <List items={blockers} tone="red" />
          )}
        </Panel>
      </div>

      <Panel title="Context loaded">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-[11px] tracking-[0.04em] text-gray-400 uppercase">
              Docs read
            </span>
            <List
              items={docsRead.map(
                (d) => `${d.path} (${d.bytes.toLocaleString()} bytes)`,
              )}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[11px] tracking-[0.04em] text-gray-400 uppercase">
              Memory / RAG sources
            </span>
            <List items={memorySources} empty="No memory source loaded." />
          </div>
        </div>
      </Panel>

      <Panel title="Facts used">
        <List items={factsUsed} empty="No external facts used." />
      </Panel>

      <Panel title="Forbidden moves">
        <List items={forbiddenMoves} />
      </Panel>

      {manifests.length > 0 && (
        <Panel title="Detected stack">
          <div className="flex flex-wrap gap-2">
            {manifests.map((m) => (
              <span
                key={m}
                className="rounded-md border border-gray-200 bg-gray-50 px-2 py-1 font-mono text-[11px] text-gray-600"
              >
                {m}
              </span>
            ))}
          </div>
        </Panel>
      )}

      {session?.hermesOutput && (
        <Panel title="Hermes report">
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 px-4 py-3 font-mono text-[12px] leading-[18px] text-gray-700">
            {session.hermesOutput}
          </pre>
        </Panel>
      )}

      {session?.hermesError && (
        <Panel title="Hermes error">
          <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap rounded-lg bg-red-50 px-4 py-3 font-mono text-[12px] leading-[18px] text-red-700">
            {session.hermesError}
          </pre>
        </Panel>
      )}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] tracking-[0.04em] text-gray-500 uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4">
      <h2 className="font-display text-[22px] font-light text-navy">{title}</h2>
      {children}
    </div>
  );
}

function KeyValue({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[90px_1fr] gap-3 text-[13px]">
      <span className="text-gray-400">{label}</span>
      <span className={mono ? "break-all font-mono text-[12px] text-ink" : "text-ink"}>
        {value}
      </span>
    </div>
  );
}

function List({
  items,
  empty = "None.",
  tone,
}: {
  items: string[];
  empty?: string;
  tone?: "red";
}) {
  if (items.length === 0) {
    return <span className="text-[13px] text-gray-500">{empty}</span>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((item) => (
        <li
          key={item}
          className={`text-[13px] leading-[20px] ${
            tone === "red" ? "text-red-700" : "text-gray-700"
          }`}
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

function StatusBadge({
  label,
  tone = "gray",
}: {
  label: string;
  tone?: "gray" | "green" | "red" | "amber";
}) {
  const styles = {
    gray: "border-gray-200 bg-white text-gray-600",
    green: "border-emerald-200 bg-emerald-50 text-emerald-700",
    red: "border-red-200 bg-red-50 text-red-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
  }[tone];
  return (
    <span className={`rounded-full border px-3 py-1 text-[12px] font-medium ${styles}`}>
      {label}
    </span>
  );
}

function riskTone(risk: ApiCodePreflight["risk"]) {
  if (risk === "low") return "green";
  if (risk === "medium") return "amber";
  return "red";
}
