import { runCodePreflight, type CodePreflightInput } from "./code-preflight";

export async function runConfiguredCodePreflight(input: CodePreflightInput) {
  const url = (process.env.CODE_RUNNER_URL ?? "").replace(/\/+$/, "");
  const token = process.env.CODE_RUNNER_TOKEN ?? "";
  if (!url) {
    return normalizePreflight(await runCodePreflight(input));
  }
  const r = await fetch(`${url}/preflight`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`code_runner_${r.status}: ${text.slice(0, 500)}`);
  }
  const data = (await r.json()) as { preflight: unknown };
  return normalizePreflight(
    data.preflight as Partial<Awaited<ReturnType<typeof runCodePreflight>>>,
  );
}

function normalizePreflight(
  preflight: Partial<Awaited<ReturnType<typeof runCodePreflight>>>,
): Awaited<ReturnType<typeof runCodePreflight>> {
  return {
    repoPath: preflight.repoPath ?? "",
    repoName: preflight.repoName ?? "unknown",
    repoExists: preflight.repoExists ?? false,
    allowed: preflight.allowed ?? false,
    gitRepo: preflight.gitRepo ?? false,
    dirtyTree: preflight.dirtyTree ?? null,
    docsRead: preflight.docsRead ?? [],
    manifests: preflight.manifests ?? [],
    memorySources: preflight.memorySources ?? [],
    factsUsed: preflight.factsUsed ?? [],
    forbiddenMoves: preflight.forbiddenMoves ?? [],
    blockers: preflight.blockers ?? [],
    risk: preflight.risk ?? "medium",
  };
}
