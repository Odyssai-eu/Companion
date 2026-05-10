/**
 * Client for the thecompai-hermes-bridge service running on the Hermes
 * host (.50:8002). The bridge exposes git status / diff / skills / session
 * management on top of the Hermes CLI — surface area we use to enrich
 * kind='hermes' conversations beyond what the bare OpenAI-compat gateway
 * offers (which is just keepalive + final text).
 *
 * Failures are non-fatal — the chat itself goes through the gateway, the
 * bridge is auxiliary. The frontend renders a degraded experience when
 * status calls 5xx (no git chip, etc.).
 */

const BRIDGE_BASE_URL =
  process.env.HERMES_BRIDGE_URL ?? "http://192.168.86.50:8002";

export type BridgeGitStatus = {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
  dirty: boolean;
};

export type BridgeGitDiff = {
  diff: string;
};

async function bridgeFetch<T>(
  path: string,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await fetch(`${BRIDGE_BASE_URL}${path}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`bridge ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function bridgeGitStatus(
  repoPath: string,
): Promise<BridgeGitStatus> {
  const qs = new URLSearchParams({ repo_path: repoPath });
  return bridgeFetch<BridgeGitStatus>(`/git/status?${qs.toString()}`);
}

export async function bridgeGitDiff(
  repoPath: string,
  opts: { staged?: boolean; path?: string } = {},
): Promise<BridgeGitDiff> {
  const qs = new URLSearchParams({ repo_path: repoPath });
  if (opts.staged) qs.set("staged", "true");
  if (opts.path) qs.set("path", opts.path);
  return bridgeFetch<BridgeGitDiff>(`/git/diff?${qs.toString()}`, {
    timeoutMs: 30_000,
  });
}

/** Cheap health probe for the bridge — used to decide whether to render
 *  git chips in the UI or hide them silently. */
export async function bridgeHealth(): Promise<{ ok: boolean; bin?: string }> {
  try {
    return await bridgeFetch<{ ok: boolean; bin?: string }>("/health", {
      timeoutMs: 2000,
    });
  } catch {
    return { ok: false };
  }
}
