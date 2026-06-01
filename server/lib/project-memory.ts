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
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index";
import { logAuthEvent } from "./auth-log";
import { decisions, projectMemoryFiles, projects } from "../db/schema";

/**
 * URL scheme for cross-project vault links. A project pastes
 * `tcai://project/<uuid>` into its Linked external path and we resolve
 * to that project's DB-backed corpus (project_memory_files), scoped to
 * the same owner for safety. Single-level — we don't recurse through
 * the target's own linked paths.
 */
const TCAI_PROJECT_PREFIX = "tcai://project/";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
   *  sources. Purely cosmetic but useful when the model needs to cite. */
  origin: "imported" | "vault" | "shared";
};

async function readDbFiles(projectId: string): Promise<CorpusEntry[]> {
  // Two-phase byte-budgeted fetch — same shape as user-memory.readDbFiles (#7):
  // metadata first, pick up to the per-turn byte cap in path order, then fetch
  // content only for those rows instead of streaming the whole project corpus.
  const metas = await db
    .select({
      path: projectMemoryFiles.path,
      sizeBytes: projectMemoryFiles.sizeBytes,
    })
    .from(projectMemoryFiles)
    .where(eq(projectMemoryFiles.projectId, projectId))
    .orderBy(projectMemoryFiles.path);
  const wanted: string[] = [];
  let budget = 0;
  for (const m of metas) {
    wanted.push(m.path);
    budget += m.sizeBytes ?? 0;
    if (budget > MAX_CONTEXT_BYTES) break;
  }
  if (wanted.length === 0) return [];
  const rows = await db
    .select({
      path: projectMemoryFiles.path,
      content: projectMemoryFiles.content,
    })
    .from(projectMemoryFiles)
    .where(
      and(
        eq(projectMemoryFiles.projectId, projectId),
        inArray(projectMemoryFiles.path, wanted),
      ),
    );
  const byPath = new Map(rows.map((r) => [r.path, r.content]));
  return wanted
    .filter((p) => byPath.has(p))
    .map((p) => ({
      path: p,
      content: byPath.get(p) as string,
      origin: "imported" as const,
    }));
}

/**
 * Resolve a `tcai://project/<uuid>` link to the target project's DB
 * corpus. Returns [] when:
 *   - the URL is malformed (bad UUID)
 *   - the target project doesn't exist
 *   - the target belongs to a different user than the caller (same-user
 *     scoping — defence in depth even though Companion is single-tenant)
 *   - the target IS the calling project (self-link makes no sense)
 *
 * Single-level only: we don't follow the target's own external_vault_path.
 * Prevents recursion loops and keeps the resolution cheap.
 */
async function readTcaiLink(
  rawPath: string,
  ownerUserId: string,
  callingProjectId: string,
): Promise<CorpusEntry[]> {
  const id = rawPath.slice(TCAI_PROJECT_PREFIX.length).trim();
  if (!UUID_RE.test(id)) return [];
  if (id === callingProjectId) return [];
  const [target] = await db
    .select({
      id: projects.id,
      userId: projects.userId,
      sharingEnabled: projects.sharingEnabled,
    })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, ownerUserId)))
    .limit(1);
  if (!target) return [];
  // Source project must have explicitly opted in to being a hub.
  // Without this consent flag, the tcai:// link silently resolves to
  // empty — same UX as a non-existent target.
  if (!target.sharingEnabled) return [];
  // Use the same DB reader to enumerate the target's corpus, then tag
  // every entry as 'shared' so the model sees provenance.
  const rows = await db
    .select({
      path: projectMemoryFiles.path,
      content: projectMemoryFiles.content,
    })
    .from(projectMemoryFiles)
    .where(eq(projectMemoryFiles.projectId, target.id));
  return rows.map((r) => ({
    path: r.path,
    content: r.content,
    origin: "shared" as const,
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
 * Build the project-memory markdown block. Sources merged:
 *   - project_memory_files (DB) for the calling project
 *   - the linked external path, which can be:
 *       - an absolute filesystem path → live readdir
 *       - a tcai://project/<uuid> link → target project's DB corpus
 *   - the project's own external vault (the same path field also works
 *     for filesystem mounts)
 *
 * Returns "" when nothing is configured / readable.
 */
export async function getProjectMemoryContext(
  projectId: string,
  /** userId for audit log — optional, omit for system calls */
  callerUserId?: string,
): Promise<string> {
  const [proj] = await db
    .select({
      userId: projects.userId,
      externalVaultPath: projects.externalVaultPath,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const dbFiles = await readDbFiles(projectId);
  let vaultFiles: CorpusEntry[] = [];
  if (proj?.externalVaultPath) {
    if (proj.externalVaultPath.startsWith(TCAI_PROJECT_PREFIX)) {
      vaultFiles = await readTcaiLink(
        proj.externalVaultPath,
        proj.userId,
        projectId,
      );
    } else {
      vaultFiles = await readVaultFiles(proj.externalVaultPath);
    }
  }

  // Decision log — always included when available (compact, always relevant).
  const decisionRows = await db
    .select()
    .from(decisions)
    .where(and(eq(decisions.projectId, projectId), isNull(decisions.deletedAt)))
    .orderBy(decisions.createdAt);

  if (dbFiles.length === 0 && vaultFiles.length === 0 && decisionRows.length === 0) return "";

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
  // Append decision log as a compact block after the corpus.
  // Kept short intentionally — each decision is ~4 fields, no preamble.
  if (decisionRows.length > 0) {
    parts.push("\n\n# Project decisions\n");
    for (const d of decisionRows) {
      parts.push(`\n## ${d.title}\n`);
      if (d.context) parts.push(`**Context:** ${d.context}\n`);
      if (d.choice) parts.push(`**Decision:** ${d.choice}\n`);
      if (d.rationale) parts.push(`**Rationale:** ${d.rationale}\n`);
      if (d.revisitBy) parts.push(`**Revisit by:** ${d.revisitBy}\n`);
    }
  }

  const result = parts.join("");

  // Audit: log memory access when context is non-empty and caller is known.
  if (result && callerUserId) {
    logAuthEvent({
      userId: callerUserId,
      event: "memory.read",
      projectId,
      resourceType: "memory",
      resourceId: projectId,
    });
  }

  return result;
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
