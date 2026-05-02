import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
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
  const [writeBusy, setWriteBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [fullFlowBusy, setFullFlowBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiCodePreflight | null>(null);
  const [selectedSession, setSelectedSession] = useState<ApiCodeSession | null>(null);
  const [sessions, setSessions] = useState<ApiCodeSession[]>([]);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [testCommand, setTestCommand] = useState("node --test");
  const [searchParams] = useSearchParams();

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

  useEffect(() => {
    const id = searchParams.get("session");
    if (!id) return;
    api
      .getCodeSession(id)
      .then(({ session }) => selectSession(session))
      .catch((e) => setError((e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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

  async function runHermesWriteTests() {
    if (!selectedSession) return;
    setWriteBusy(true);
    setError(null);
    try {
      const r = await api.codeHermesWriteTests(selectedSession.id, { model });
      setSelectedSession(r.session);
      if (r.session.preflight) setResult(r.session.preflight);
      await refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWriteBusy(false);
    }
  }

  async function runTests() {
    if (!selectedSession) return;
    setTestBusy(true);
    setError(null);
    try {
      const r = await api.codeRunTests(selectedSession.id, {
        command: testCommand.trim() || undefined,
      });
      setSelectedSession(r.session);
      if (r.session.preflight) setResult(r.session.preflight);
      await refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTestBusy(false);
    }
  }

  async function runFullFlow() {
    setFullFlowBusy(true);
    setError(null);
    try {
      const pre = selectedSession
        ? { session: selectedSession, preflight: selectedSession.preflight }
        : await api.codePreflight({ repoPath, task, model });
      if (!pre.session.preflight) throw new Error("missing_preflight");
      setResult(pre.session.preflight);
      setSelectedSession(pre.session);
      await refreshSessions();
      if ((pre.session.blockers ?? []).length > 0) return;

      const written = await api.codeHermesWriteTests(pre.session.id, { model });
      setSelectedSession(written.session);
      if (written.session.preflight) setResult(written.session.preflight);
      await refreshSessions();
      if (written.session.status !== "write_done") return;

      const tested = await api.codeRunTests(written.session.id, {
        command: testCommand.trim() || undefined,
      });
      setSelectedSession(tested.session);
      if (tested.session.preflight) setResult(tested.session.preflight);
      await refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFullFlowBusy(false);
    }
  }

  function selectSession(session: ApiCodeSession) {
    if (session.preflight) setResult(session.preflight);
    setSelectedSession(session);
    setRepoPath(session.repoPath);
    setTask(session.task);
    setModel(session.model ?? DEFAULT_MODEL);
    setTestCommand(defaultTestCommand(session));
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
        <Field label="Test command">
          <input
            value={testCommand}
            onChange={(e) => setTestCommand(e.target.value)}
            placeholder="node --test"
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-[12px] text-ink outline-none focus:border-cyan"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={runFullFlow}
            disabled={
              fullFlowBusy ||
              !repoPath.trim() ||
              !task.trim() ||
              !model.trim()
            }
            className="rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {fullFlowBusy ? "Running full flow…" : "Run full flow"}
          </button>
          <button
            type="button"
            onClick={runPreflight}
            disabled={busy || !repoPath.trim() || !task.trim()}
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] font-medium text-ink hover:bg-gray-50 disabled:opacity-50"
          >
            {busy ? "Running…" : "Run preflight"}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-3">
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
            Uses the selected LiteLLM model.
          </span>
          <button
            type="button"
            onClick={runHermesWriteTests}
            disabled={
              writeBusy ||
              !selectedSession ||
              selectedSession.blockers?.length !== 0 ||
              !model.trim()
            }
            className="rounded-md bg-cyan px-4 py-2 text-[13px] font-medium text-white hover:opacity-95 disabled:opacity-50"
          >
            {writeBusy ? "Hermes writing…" : "Hermes write tests"}
          </button>
          <span className="font-mono text-[11px] text-gray-400">
            Test files only. No commits, installs, or deploy.
          </span>
          <button
            type="button"
            onClick={runTests}
            disabled={testBusy || !selectedSession}
            className="rounded-md border border-gray-200 bg-white px-4 py-2 text-[13px] font-medium text-ink hover:bg-gray-50 disabled:opacity-50"
          >
            {testBusy ? "Testing…" : "Run tests"}
          </button>
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
        onSelect={selectSession}
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
  const parsed = parseCodeSessionOutput(session?.hermesOutput ?? "");
  const blockers = result.blockers ?? [];
  const docsRead = result.docsRead ?? [];
  const memorySources = result.memorySources ?? [];
  const factsUsed = result.factsUsed ?? [];
  const forbiddenMoves = result.forbiddenMoves ?? [];
  const manifests = result.manifests ?? [];
  return (
    <section className="flex flex-col gap-5">
      {session && (
        <Panel title="Session">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label={statusLabel(session.status)}
              tone={statusTone(session.status)}
            />
            <StatusBadge label={`Risk ${result.risk}`} tone={riskTone(result.risk)} />
            <StatusBadge label={result.gitRepo ? "Git repo" : "Plain folder"} />
            {result.dirtyTree === true && <StatusBadge label="Dirty tree" tone="amber" />}
            {result.dirtyTree === false && <StatusBadge label="Clean tree" tone="green" />}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <KeyValue label="Model" value={session.model ?? "default"} mono />
            <KeyValue label="Updated" value={new Date(session.updatedAt).toLocaleString()} />
          </div>
        </Panel>
      )}

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

      <Panel title="Preflight">
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

      {parsed.proposal && (
        <Panel title="Hermes proposal">
          {parsed.proposal.summary && (
            <p className="text-[13px] leading-[20px] text-gray-700">
              {parsed.proposal.summary}
            </p>
          )}
          {parsed.proposal.blockers.length > 0 && (
            <List items={parsed.proposal.blockers} tone="red" />
          )}
          {parsed.proposal.files.length > 0 && (
            <div className="flex flex-col gap-2">
              {parsed.proposal.files.map((file) => (
                <div
                  key={file.path}
                  className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2"
                >
                  <div className="mb-2 font-mono text-[11px] text-gray-500">
                    {file.path}
                  </div>
                  <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[18px] text-gray-700">
                    {file.content}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {parsed.write && (
        <Panel title="Files written">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label={parsed.write.ok ? "write ok" : "write blocked"}
              tone={parsed.write.ok ? "green" : "red"}
            />
            {parsed.write.gitRepo !== undefined && (
              <StatusBadge label={parsed.write.gitRepo ? "Git repo" : "Plain folder"} />
            )}
          </div>
          <List items={parsed.write.filesWritten} empty="No files written." />
          {parsed.write.blockers.length > 0 && (
            <List items={parsed.write.blockers} tone="red" />
          )}
          {parsed.write.diffStat && (
            <pre className="overflow-auto rounded-lg bg-gray-50 px-4 py-3 font-mono text-[12px] leading-[18px] text-gray-700">
              {parsed.write.diffStat}
            </pre>
          )}
        </Panel>
      )}

      {parsed.write?.diff && (
        <Panel title="Diff">
          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 px-4 py-3 font-mono text-[12px] leading-[18px] text-gray-700">
            {parsed.write.diff}
          </pre>
        </Panel>
      )}

      {parsed.test && (
        <Panel title="Test logs">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              label={parsed.test.ok ? "tests passed" : "tests failed"}
              tone={parsed.test.ok ? "green" : "red"}
            />
            <StatusBadge label={parsed.test.command || "default command"} />
            {parsed.test.exitCode !== null && (
              <StatusBadge label={`exit ${parsed.test.exitCode}`} />
            )}
          </div>
          {parsed.test.blockers.length > 0 && (
            <List items={parsed.test.blockers} tone="red" />
          )}
          {parsed.test.stdout && (
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-lg bg-gray-50 px-4 py-3 font-mono text-[12px] leading-[18px] text-gray-700">
              {parsed.test.stdout}
            </pre>
          )}
          {parsed.test.stderr && (
            <pre className="max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg bg-red-50 px-4 py-3 font-mono text-[12px] leading-[18px] text-red-700">
              {parsed.test.stderr}
            </pre>
          )}
        </Panel>
      )}

      {session && (
        <Panel title="Next action">
          <span className="text-[13px] leading-[20px] text-gray-700">
            {nextAction(session.status)}
          </span>
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

function statusTone(status: string): "gray" | "green" | "red" | "amber" {
  if (["tests_passed", "write_done", "hermes_done", "preflight"].includes(status)) {
    return "green";
  }
  if (["blocked", "write_blocked", "tests_failed", "hermes_failed", "failed"].includes(status)) {
    return "red";
  }
  if (["testing", "hermes_writing", "hermes_preflight", "running"].includes(status)) {
    return "amber";
  }
  return "gray";
}

function statusLabel(status: string) {
  return status.replaceAll("_", " ");
}

function nextAction(status: string) {
  if (status === "preflight") return "Run Hermes write tests, then run tests.";
  if (status === "write_done") return "Run tests with the selected allowlisted command.";
  if (status === "tests_passed") return "Review files and diff. For a git repo, the next step is commit/review.";
  if (status === "tests_failed") return "Inspect logs, adjust the task or test command, then rerun.";
  if (status === "blocked" || status === "write_blocked") return "Resolve blockers before continuing.";
  if (status === "hermes_failed") return "Inspect Hermes error and rerun with a better model if needed.";
  return "Continue with the next available action.";
}

type ParsedProposal = {
  files: Array<{ path: string; content: string }>;
  blockers: string[];
  summary?: string;
};

type ParsedWrite = {
  ok: boolean;
  filesWritten: string[];
  blockers: string[];
  gitRepo?: boolean;
  diffStat: string;
  diff: string;
};

type ParsedTest = {
  ok: boolean;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  blockers: string[];
  elapsedMs: number;
};

function parseCodeSessionOutput(output: string): {
  proposal: ParsedProposal | null;
  write: ParsedWrite | null;
  test: ParsedTest | null;
} {
  return {
    proposal: parseProposal(output),
    write: parseJsonAfter<ParsedWrite>(output, "TheCompAI runner write result:"),
    test: parseJsonAfter<ParsedTest>(output, "TheCompAI runner test result:"),
  };
}

function parseProposal(output: string): ParsedProposal | null {
  const fenced = output.match(/```json\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ParsedProposal>;
    return {
      files: Array.isArray(parsed.files)
        ? parsed.files.map((f) => ({
            path: String(f.path ?? ""),
            content: String(f.content ?? ""),
          }))
        : [],
      blockers: Array.isArray(parsed.blockers)
        ? parsed.blockers.map((b) => String(b))
        : [],
      summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    };
  } catch {
    return null;
  }
}

function parseJsonAfter<T>(output: string, marker: string): T | null {
  const idx = output.indexOf(marker);
  if (idx < 0) return null;
  const rest = output.slice(idx + marker.length).trim();
  const start = rest.indexOf("{");
  if (start < 0) return null;
  const json = extractBalancedJson(rest.slice(start));
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function extractBalancedJson(text: string) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

function defaultTestCommand(session: ApiCodeSession) {
  const manifests = session.preflight?.manifests ?? [];
  if (manifests.includes("package.json")) return "npm test";
  if (manifests.includes("pnpm-lock.yaml")) return "pnpm test";
  if (manifests.includes("bun.lock")) return "bun test";
  if (manifests.includes("deno.json")) return "deno test";
  if (manifests.includes("Cargo.toml")) return "cargo test";
  if (manifests.includes("go.mod")) return "go test ./...";
  if (manifests.includes("pyproject.toml")) return "python -m pytest";
  return "node --test";
}
