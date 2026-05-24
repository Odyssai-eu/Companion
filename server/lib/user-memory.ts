/**
 * Per-user global memory corpus reader — the user-scoped twin of
 * `server/lib/project-memory.ts`.
 *
 * The user can seed and pilot their global wiki manually:
 *
 *   1. ZIP import   → user_memory_files (DB-stored, 1 MB / file,
 *                                        50 MB / corpus cap).
 *   2. Linked path  → users.external_vault_path (absolute filesystem
 *                                                path on the gateway host,
 *                                                read live every turn).
 *
 * The chat route calls `getUserMemoryContext()` to get the markdown
 * block to inject into the system prompt. This coexists with the
 * Karpathy auto-wiki by default (the chat route concatenates both
 * blocks); when `users.auto_memory_enabled` is false, the chat route
 * skips the Karpathy call and only uses this corpus.
 *
 * Mirrors `project-memory.ts` for predictability — same accepted
 * extensions, same per-turn byte cap, same lexical ordering for
 * KV-cache friendliness.
 */

import { promises as fs } from "node:fs";
import { join, normalize } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { userMemoryFiles, users } from "../db/schema";

const MAX_CONTEXT_BYTES = 200 * 1024;

/** Accepted file extensions for the external vault walk. Same set as
 *  the ZIP importer — keeps the two paths consistent. */
const ACCEPTED_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
]);

type CorpusEntry = {
  path: string;
  content: string;
  /** Origin tag for the header label, helps the model distinguish
   *  sources. Cosmetic but useful when the model needs to cite. */
  origin: "imported" | "vault";
};

async function readDbFiles(userId: string): Promise<CorpusEntry[]> {
  const rows = await db
    .select({
      path: userMemoryFiles.path,
      content: userMemoryFiles.content,
    })
    .from(userMemoryFiles)
    .where(eq(userMemoryFiles.userId, userId));
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    origin: "imported" as const,
  }));
}

async function readVaultFiles(rootPath: string): Promise<CorpusEntry[]> {
  const out: CorpusEntry[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Array<{
      name: string;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      const relPath = normalize(
        rel ? `${rel}/${entry.name}` : entry.name,
      ).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf(".");
        const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : "";
        if (!ACCEPTED_EXTS.has(ext)) continue;
        try {
          const content = await fs.readFile(abs, "utf8");
          out.push({ path: relPath, content, origin: "vault" });
        } catch {
          // skip unreadable file
        }
      }
    }
  }
  await walk(rootPath, "");
  return out;
}

/**
 * Build the user-curated memory markdown block. Sources merged:
 *   - user_memory_files (DB-imported ZIP)
 *   - users.external_vault_path (filesystem live read)
 *
 * Returns "" when nothing is configured / readable. Callers concat
 * this with whatever the Karpathy memory service returns (see
 * `server/lib/memory.ts:getMemoryContext`).
 */
export async function getUserMemoryContext(userId: string): Promise<string> {
  const [u] = await db
    .select({
      externalVaultPath: users.externalVaultPath,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const dbFiles = await readDbFiles(userId);
  let vaultFiles: CorpusEntry[] = [];
  if (u?.externalVaultPath) {
    vaultFiles = await readVaultFiles(u.externalVaultPath);
  }

  if (dbFiles.length === 0 && vaultFiles.length === 0) return "";

  // Imported files win on path collision so the user has an explicit
  // override: copy + edit a file into the DB to shadow what the vault
  // says.
  const seen = new Set<string>();
  const merged: CorpusEntry[] = [];
  for (const e of dbFiles) {
    seen.add(e.path);
    merged.push(e);
  }
  for (const e of vaultFiles) {
    if (!seen.has(e.path)) merged.push(e);
  }
  merged.sort((a, b) => a.path.localeCompare(b.path));

  const header = "# User vault";
  const parts: string[] = [header];
  let totalBytes = header.length;
  let truncated = 0;
  for (const r of merged) {
    const block = `\n\n## ${r.path}\n\n${r.content}\n`;
    if (totalBytes + block.length > MAX_CONTEXT_BYTES) {
      truncated++;
      continue;
    }
    parts.push(block);
    totalBytes += block.length;
  }
  if (truncated > 0) {
    parts.push(
      `\n\n_(${truncated} file${truncated === 1 ? "" : "s"} omitted — corpus exceeds the ${Math.round(
        MAX_CONTEXT_BYTES / 1024,
      )} KB per-turn cap. Phase 2 will replace this with RAG.)_\n`,
    );
  }
  return parts.join("");
}

export type UserMemoryStats = {
  fileCount: number;
  bytesUsed: number;
};

export async function getUserMemoryStats(
  userId: string,
): Promise<UserMemoryStats> {
  const rows = await db
    .select({ sizeBytes: userMemoryFiles.sizeBytes })
    .from(userMemoryFiles)
    .where(eq(userMemoryFiles.userId, userId));
  return {
    fileCount: rows.length,
    bytesUsed: rows.reduce((s, r) => s + r.sizeBytes, 0),
  };
}
