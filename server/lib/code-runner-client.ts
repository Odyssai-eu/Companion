import { runCodePreflight, type CodePreflightInput } from "./code-preflight";

export async function runConfiguredCodePreflight(input: CodePreflightInput) {
  const url = (process.env.CODE_RUNNER_URL ?? "").replace(/\/+$/, "");
  const token = process.env.CODE_RUNNER_TOKEN ?? "";
  if (!url) {
    return runCodePreflight(input);
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
  return data.preflight as Awaited<ReturnType<typeof runCodePreflight>>;
}

