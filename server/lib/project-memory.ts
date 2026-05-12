/**
 * Per-project memory corpus reader.
 *
 * Returns the markdown block to prepend to the system prompt when
 * `projects.dedicatedMemoryEnabled` is true. Two sources are merged:
 *
 *   1. `project_memory_files` — files COPIED into the DB (ZIP upload).
 *   2. `projects.external_vault_path` — absolute path on the gateway
 *      filesystem, read LIVE every turn (no copy, no sync — disk edits
 *      surface immediately).
 *
 * Both are size-capped together at MAX_CONTEXT_BYTES so a huge external
 * vault can't blow up the prompt. Files are emitted in lexical path
 * order across both sources so the prefix stays byte-stable across
 * turns when no source files changed (KV cache friendly).
 *
 * Phase 2 will swap the raw-concat path for RAG retrieval — the public
 * function signature stays the same so the chat route doesn't need to
 * know.
 */

import { promises as fs } from "node:fs";
import { join, normalize } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { projectMemoryFiles, projects } from "../db/schema";

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
  /** Origin tag for the header label, helps the model distinguish a
   *  live mount from a snapshot. Purely cosmetic. */
  origin: "imported" | "vault";
};

async function readDbFiles(projectId: string): Promise<CorpusEntry[]> {
  const rows = await db
    .select({
      path: projectMemoryFiles.path,
      content: projectMemoryFiles.content,
    })
    .from(projectMemoryFiles)
    .where(eq(projectMemoryFiles.projectId, projectId));
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    origin: "imported" as const,
  }));
}

async function readVaultFiles(rootPath: string): Promise<CorpusEntry[]> {
  const out: CorpusEntry[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // unreadable directory — surface as empty and continue.
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      const relPath = normalize(rel ? `${rel}/${entry.name}` : entry.name).replace(
        /\\/g,
        "/",
      );
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
 * Build the project-memory markdown block. Combines DB-imported files
 * with live external vault files when both are configured. Returns ""
 * when neither source has content.
 */
export async function getProjectMemoryContext(
  projectId: string,
): Promise<string> {
  const [proj] = await db
    .select({ externalVaultPath: projects.externalVaultPath })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const dbFiles = await readDbFiles(projectId);
  const vaultFiles = proj?.externalVaultPath
    ? await readVaultFiles(proj.externalVaultPath)
    : [];

  if (dbFiles.length === 0 && vaultFiles.length === 0) return "";

  // Merge + sort lexically so the prefix stays byte-stable across turns.
  // If both sources contain the same path, the imported one wins — gives
  // the user an explicit override path: copy + edit a file in the DB to
  // shadow what the vault says.
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

  const header = "# Project memory";
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

export type ProjectMemoryStats = {
  fileCount: number;
  bytesUsed: number;
};

export async function getProjectMemoryStats(
  projectId: string,
): Promise<ProjectMemoryStats> {
  const rows = await db
    .select({ sizeBytes: projectMemoryFiles.sizeBytes })
    .from(projectMemoryFiles)
    .where(eq(projectMemoryFiles.projectId, projectId));
  return {
    fileCount: rows.length,
    bytesUsed: rows.reduce((s, r) => s + r.sizeBytes, 0),
  };
}
