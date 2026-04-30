import { runSsh, type SshNode } from "./ssh";

/**
 * Per-node "models" listing helper backing the matrix view.
 *
 * Strategy: any direct subdirectory of `modelPath` counts as a "model".
 * That covers HuggingFace cache layouts (`models--mlx-community--*`),
 * exo's `~/.exo/models` flat dirs, and Ollama-ish blob roots equally.
 *
 * Cache TTL: 30 s per node to keep the matrix snappy without hammering SSH.
 */

export interface ModelEntry {
  name: string;
  sizeBytes?: number;
}

interface CacheEntry {
  at: number;
  models: ModelEntry[];
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export interface ListNodeModelsTarget extends SshNode {
  id: string;
  modelPath: string;
}

/**
 * SSH-list models on a node. Returns [] for offline / unreachable nodes
 * rather than throwing — the matrix endpoint must degrade gracefully.
 */
export async function listNodeModels(
  node: ListNodeModelsTarget,
): Promise<ModelEntry[]> {
  const now = Date.now();
  const cached = cache.get(node.id);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.models;
  }

  // `find -maxdepth 1` for top-level subdirs, then a separate `du -sb` would
  // be expensive on big caches. Skip sizes by default — UI can lazy-load.
  // Quote the modelPath via single-quotes; rely on the remote shell to
  // expand `~`. We don't escape '~' on purpose.
  const cmd =
    `set -e; P=${shellQuote(node.modelPath)}; ` +
    `if [ ! -d "$P" ]; then echo "__missing__"; exit 0; fi; ` +
    `find "$P" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null || ` +
    `ls -1 "$P" 2>/dev/null`;

  let result;
  try {
    result = await runSsh(node, cmd, { timeoutMs: 15_000 });
  } catch {
    cache.set(node.id, { at: now, models: [] });
    return [];
  }

  if (result.code !== 0) {
    cache.set(node.id, { at: now, models: [] });
    return [];
  }
  const out = result.stdout.trim();
  if (out === "__missing__" || out === "") {
    cache.set(node.id, { at: now, models: [] });
    return [];
  }

  const models: ModelEntry[] = out
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "__missing__")
    .map((name) => ({ name }));

  cache.set(node.id, { at: now, models });
  return models;
}

export function clearListingCache(nodeId?: string): void {
  if (nodeId) cache.delete(nodeId);
  else cache.clear();
}

function shellQuote(s: string): string {
  // Minimal single-quote escape: 'foo'"'"'bar' for foo'bar.
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
