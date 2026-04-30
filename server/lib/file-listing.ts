import { runSsh, type SshNode } from "./ssh";

/**
 * Per-node "models" listing helper backing the matrix view.
 *
 * Returns:
 *   - freeBytes: filesystem free space at modelPath (df -k)
 *   - models[]:  each subdir of modelPath with its sizeBytes (du -sk)
 *
 * Strategy: any direct subdirectory of `modelPath` counts as a "model".
 * That covers HuggingFace cache layouts, exo's flat dirs, Ollama equally.
 *
 * Cache TTL: 30s per node to keep the matrix snappy without hammering SSH.
 * du -sk on a dir of safetensors (~10-20 files) is cheap (<1s) — the cost
 * is metadata reads, not byte scans.
 */

export interface ModelEntry {
  name: string;
  sizeBytes: number;
}

export interface NodeListing {
  freeBytes: number | null;
  models: ModelEntry[];
}

interface CacheEntry {
  at: number;
  listing: NodeListing;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, CacheEntry>();

export interface ListNodeModelsTarget extends SshNode {
  id: string;
  modelPath: string;
}

/**
 * SSH-list models + free space on a node. Returns
 * `{ freeBytes: null, models: [] }` for offline / unreachable nodes rather
 * than throwing — the matrix endpoint must degrade gracefully.
 */
export async function listNodeModels(
  node: ListNodeModelsTarget,
): Promise<NodeListing> {
  const now = Date.now();
  const cached = cache.get(node.id);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.listing;
  }

  // Single round-trip: free space + per-subdir size. `du -sk` returns kB.
  const cmd =
    `set -e; P=${shellQuote(node.modelPath)}; ` +
    `if [ ! -d "$P" ]; then echo "__missing__"; exit 0; fi; ` +
    `df -k "$P" | tail -1 | awk '{print "FREE:"$4}'; ` +
    `find "$P" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | ` +
    `while read -r d; do ` +
      `s=$(du -sk "$d" 2>/dev/null | awk '{print $1}'); ` +
      `printf 'DIR:%s\\t%s\\n' "$(basename "$d")" "$s"; ` +
    `done`;

  let result;
  try {
    result = await runSsh(node, cmd, { timeoutMs: 30_000 });
  } catch {
    const listing: NodeListing = { freeBytes: null, models: [] };
    cache.set(node.id, { at: now, listing });
    return listing;
  }

  if (result.code !== 0) {
    const listing: NodeListing = { freeBytes: null, models: [] };
    cache.set(node.id, { at: now, listing });
    return listing;
  }
  const out = result.stdout.trim();
  if (out === "__missing__" || out === "") {
    const listing: NodeListing = { freeBytes: null, models: [] };
    cache.set(node.id, { at: now, listing });
    return listing;
  }

  let freeBytes: number | null = null;
  const models: ModelEntry[] = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("FREE:")) {
      const kb = parseInt(line.slice(5), 10);
      if (!Number.isNaN(kb)) freeBytes = kb * 1024;
    } else if (line.startsWith("DIR:")) {
      const rest = line.slice(4);
      const tab = rest.lastIndexOf("\t");
      if (tab > 0) {
        const name = rest.slice(0, tab);
        const kb = parseInt(rest.slice(tab + 1), 10);
        models.push({ name, sizeBytes: Number.isNaN(kb) ? 0 : kb * 1024 });
      }
    }
  }

  const listing: NodeListing = { freeBytes, models };
  cache.set(node.id, { at: now, listing });
  return listing;
}

export function clearListingCache(nodeId?: string): void {
  if (nodeId) cache.delete(nodeId);
  else cache.clear();
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
