/**
 * Per-project memory corpus reader.
 *
 * Used by the chat route when `projects.dedicatedMemoryEnabled` is true:
 * it concatenates the project's files (size-capped) and returns a single
 * markdown block to prepend to the system prompt.
 *
 * Phase 1 (this module) does raw concatenation. Phase 2 will swap to RAG
 * retrieval — the public function signature stays the same so the chat
 * route doesn't need to know.
 *
 * Cap defaults: 200 KB of corpus per turn. Files are concatenated in
 * lexical path order so the prefix stays byte-stable across turns (KV
 * cache friendly) as long as the underlying files don't change.
 */

import { asc, eq } from "drizzle-orm";
import { db } from "../db/index";
import { projectMemoryFiles } from "../db/schema";

const MAX_CONTEXT_BYTES = 200 * 1024;

export async function getProjectMemoryContext(
  projectId: string,
): Promise<string> {
  const rows = await db
    .select({
      path: projectMemoryFiles.path,
      content: projectMemoryFiles.content,
      sizeBytes: projectMemoryFiles.sizeBytes,
    })
    .from(projectMemoryFiles)
    .where(eq(projectMemoryFiles.projectId, projectId))
    .orderBy(asc(projectMemoryFiles.path));

  if (rows.length === 0) return "";

  // Greedy fill up to the cap, deterministic order.
  const parts: string[] = ["# Project memory\n"];
  let totalBytes = parts[0].length;
  let truncated = 0;
  for (const r of rows) {
    const block = `\n## \`${r.path}\`\n\n${r.content}\n`;
    if (totalBytes + block.length > MAX_CONTEXT_BYTES) {
      truncated++;
      continue;
    }
    parts.push(block);
    totalBytes += block.length;
  }
  if (truncated > 0) {
    parts.push(
      `\n_(${truncated} file${truncated === 1 ? "" : "s"} omitted — corpus exceeds the ${Math.round(
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
