/**
 * Project memory corpus routes — the per-project vault that backs the
 * `dedicatedMemoryEnabled` toggle on `projects`. Files live in the
 * `project_memory_files` table (DB-backed, not on disk, for portability
 * across container rebuilds and multi-host deploys).
 *
 *   GET    /api/projects/:id/memory                list files + stats
 *   POST   /api/projects/:id/memory/files          upload a single text file
 *   POST   /api/projects/:id/memory/import         multipart zip — unpacked
 *                                                  into the corpus
 *   POST   /api/projects/:id/memory/external       set/import from an
 *                                                  absolute path on the
 *                                                  server filesystem
 *   DELETE /api/projects/:id/memory/file?path=…    remove one file
 *   DELETE /api/projects/:id/memory                wipe the whole corpus
 *
 * All routes are auth-gated (project ownership) and accept text content
 * up to 1 MB per file, with a 10 MB corpus cap per project. These match
 * the workspace_files quotas.
 */

import { promises as fs } from "node:fs";
import { join, normalize, resolve as pathResolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { projectMemoryFiles, projects } from "../db/schema";
import { getProjectMemoryStats } from "../lib/project-memory";

type Env = { Variables: { userId: string } };
const projectMemoryRoute = new Hono<Env>();

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_CORPUS_BYTES = 10 * 1024 * 1024;
/** File extensions we accept for vault import. Anything else is skipped. */
const ACCEPTED_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
]);

async function ownProject(userId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: projects.userId })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  return !!row && row.userId === userId;
}

projectMemoryRoute.get("/:id/memory", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownProject(userId, id))) {
    return c.json({ error: "not_found" }, 404);
  }
  const rows = await db
    .select({
      path: projectMemoryFiles.path,
      mimeType: projectMemoryFiles.mimeType,
      sizeBytes: projectMemoryFiles.sizeBytes,
      updatedAt: projectMemoryFiles.updatedAt,
    })
    .from(projectMemoryFiles)
    .where(eq(projectMemoryFiles.projectId, id))
    .orderBy(projectMemoryFiles.path);
  const stats = await getProjectMemoryStats(id);
  return c.json({
    files: rows,
    stats: {
      ...stats,
      bytesQuota: MAX_CORPUS_BYTES,
    },
  });
});

const fileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(MAX_FILE_BYTES),
  mimeType: z.string().max(80).optional(),
});

/** Normalize a vault-relative path: strip leading slashes, drop ../,
 *  reject empty / absolute. Returns null on rejection. */
function safePath(raw: string): string | null {
  const trimmed = raw.replace(/^[/\\]+/, "");
  const norm = normalize(trimmed).replace(/\\/g, "/");
  if (!norm || norm.startsWith("..") || norm.includes("/../")) return null;
  return norm;
}

projectMemoryRoute.post(
  "/:id/memory/files",
  zValidator("json", fileSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (!(await ownProject(userId, id))) {
      return c.json({ error: "not_found" }, 404);
    }
    const data = c.req.valid("json");
    const path = safePath(data.path);
    if (!path) return c.json({ error: "invalid_path" }, 400);
    const sizeBytes = new TextEncoder().encode(data.content).length;
    if (sizeBytes > MAX_FILE_BYTES) {
      return c.json({ error: "file_too_large" }, 413);
    }
    const stats = await getProjectMemoryStats(id);
    if (stats.bytesUsed + sizeBytes > MAX_CORPUS_BYTES) {
      return c.json({ error: "corpus_quota_exceeded" }, 413);
    }
    // Upsert by (project_id, path) — Drizzle's onConflictDoUpdate is the
    // direct path.
    await db
      .insert(projectMemoryFiles)
      .values({
        projectId: id,
        path,
        mimeType: data.mimeType ?? "text/markdown",
        sizeBytes,
        content: data.content,
      })
      .onConflictDoUpdate({
        target: [projectMemoryFiles.projectId, projectMemoryFiles.path],
        set: {
          content: data.content,
          sizeBytes,
          mimeType: data.mimeType ?? "text/markdown",
          updatedAt: new Date(),
        },
      });
    return c.json({ ok: true, path });
  },
);

/**
 * Multipart zip import. The zip is decoded server-side and each entry
 * matching ACCEPTED_EXTS is upserted. Skipped entries are reported in
 * the response.
 */
projectMemoryRoute.post("/:id/memory/import", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownProject(userId, id))) {
    return c.json({ error: "not_found" }, 404);
  }
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "missing_file" }, 400);
  }
  if (file.size > 50 * 1024 * 1024) {
    return c.json({ error: "zip_too_large" }, 413);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  try {
    const result = await importZipIntoProject(id, buf);
    return c.json(result);
  } catch (e) {
    return c.json({ error: "import_failed", detail: (e as Error).message }, 400);
  }
});

const externalSchema = z.object({
  path: z.string().min(1).max(1000),
});

/**
 * Import from an absolute filesystem path on the server. Walks the
 * directory recursively, picks up files matching ACCEPTED_EXTS, upserts
 * them. Useful when the user keeps a vault on the same host (or a
 * mounted volume) and wants TheCompAI to mirror it into the project
 * corpus.
 *
 * SECURITY: path must be absolute. We don't sandbox to any subtree —
 * the user is admin/organiser on the server, this is fine for v1. If
 * we ever expose this beyond trusted users, add a configurable
 * allowlist.
 */
projectMemoryRoute.post(
  "/:id/memory/external",
  zValidator("json", externalSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    if (!(await ownProject(userId, id))) {
      return c.json({ error: "not_found" }, 404);
    }
    const { path: rawPath } = c.req.valid("json");
    const resolved = pathResolve(rawPath);
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory()) {
        return c.json({ error: "not_a_directory", path: resolved }, 400);
      }
    } catch {
      return c.json({ error: "path_not_found", path: resolved }, 400);
    }
    try {
      const result = await importDirIntoProject(id, resolved);
      return c.json(result);
    } catch (e) {
      return c.json(
        { error: "import_failed", detail: (e as Error).message },
        500,
      );
    }
  },
);

projectMemoryRoute.delete("/:id/memory/file", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownProject(userId, id))) {
    return c.json({ error: "not_found" }, 404);
  }
  const path = c.req.query("path");
  if (!path) return c.json({ error: "missing_path" }, 400);
  const safe = safePath(path);
  if (!safe) return c.json({ error: "invalid_path" }, 400);
  await db
    .delete(projectMemoryFiles)
    .where(
      and(
        eq(projectMemoryFiles.projectId, id),
        eq(projectMemoryFiles.path, safe),
      ),
    );
  return c.body(null, 204);
});

projectMemoryRoute.delete("/:id/memory", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  if (!(await ownProject(userId, id))) {
    return c.json({ error: "not_found" }, 404);
  }
  await db
    .delete(projectMemoryFiles)
    .where(eq(projectMemoryFiles.projectId, id));
  return c.body(null, 204);
});

// ── Import helpers ───────────────────────────────────────────────────────

type ImportResult = {
  imported: Array<{ path: string; bytes: number }>;
  skipped: Array<{ path: string; reason: string }>;
  bytesUsed: number;
  bytesQuota: number;
};

/**
 * Minimal in-process ZIP reader. We avoid pulling in a heavy dep and
 * implement just what we need: scan the central directory and inflate
 * stored / deflate entries to text. Uses the Web CompressionStream API
 * (DecompressionStream) which is in Bun + modern Node 22.
 */
async function importZipIntoProject(
  projectId: string,
  zipBytes: Uint8Array,
): Promise<ImportResult> {
  const entries = parseZipEntries(zipBytes);
  return importEntries(
    projectId,
    entries.map((e) => ({
      path: e.path,
      load: async () => decodeZipEntry(zipBytes, e),
    })),
  );
}

async function importDirIntoProject(
  projectId: string,
  rootDir: string,
): Promise<ImportResult> {
  const files: Array<{ path: string; abs: string }> = [];
  async function walk(dir: string, rel: string) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, relPath);
      } else if (entry.isFile()) {
        files.push({ path: relPath, abs });
      }
    }
  }
  await walk(rootDir, "");
  return importEntries(
    projectId,
    files.map((f) => ({
      path: f.path,
      load: async () => fs.readFile(f.abs, "utf8"),
    })),
  );
}

async function importEntries(
  projectId: string,
  entries: Array<{ path: string; load: () => Promise<string> }>,
): Promise<ImportResult> {
  const imported: ImportResult["imported"] = [];
  const skipped: ImportResult["skipped"] = [];
  let bytesUsed = (await getProjectMemoryStats(projectId)).bytesUsed;

  for (const e of entries) {
    const safe = safePath(e.path);
    if (!safe) {
      skipped.push({ path: e.path, reason: "invalid_path" });
      continue;
    }
    const dot = safe.lastIndexOf(".");
    const ext = dot >= 0 ? safe.slice(dot).toLowerCase() : "";
    if (!ACCEPTED_EXTS.has(ext)) {
      skipped.push({ path: safe, reason: "unsupported_extension" });
      continue;
    }
    let content: string;
    try {
      content = await e.load();
    } catch (err) {
      skipped.push({
        path: safe,
        reason: `read_failed: ${(err as Error).message.slice(0, 80)}`,
      });
      continue;
    }
    const sizeBytes = new TextEncoder().encode(content).length;
    if (sizeBytes > MAX_FILE_BYTES) {
      skipped.push({ path: safe, reason: "file_too_large" });
      continue;
    }
    if (bytesUsed + sizeBytes > MAX_CORPUS_BYTES) {
      skipped.push({ path: safe, reason: "corpus_quota_exceeded" });
      continue;
    }
    const mimeType =
      ext === ".md" || ext === ".markdown" ? "text/markdown" : "text/plain";
    await db
      .insert(projectMemoryFiles)
      .values({
        projectId,
        path: safe,
        mimeType,
        sizeBytes,
        content,
      })
      .onConflictDoUpdate({
        target: [projectMemoryFiles.projectId, projectMemoryFiles.path],
        set: { content, sizeBytes, mimeType, updatedAt: new Date() },
      });
    imported.push({ path: safe, bytes: sizeBytes });
    bytesUsed += sizeBytes;
  }
  return {
    imported,
    skipped,
    bytesUsed,
    bytesQuota: MAX_CORPUS_BYTES,
  };
}

// ── ZIP parsing (central directory walk + inflate) ───────────────────────

type ZipEntry = {
  path: string;
  /** offset of the local file header in the zip */
  localHeaderOffset: number;
  /** raw compressed size from central dir */
  compressedSize: number;
  /** raw uncompressed size from central dir */
  uncompressedSize: number;
  /** 0 = stored, 8 = deflate */
  method: number;
};

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function readU16(b: Uint8Array, off: number): number {
  return b[off] | (b[off + 1] << 8);
}
function readU32(b: Uint8Array, off: number): number {
  return (
    (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] * 0x1000000)) >>>
    0
  );
}

function parseZipEntries(buf: Uint8Array): ZipEntry[] {
  // Walk from the end to find EOCD (End Of Central Directory).
  let eocdOff = -1;
  const start = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= start; i--) {
    if (readU32(buf, i) === EOCD_SIG) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error("invalid_zip: no EOCD");
  const cdOff = readU32(buf, eocdOff + 16);
  const cdEntries = readU16(buf, eocdOff + 10);

  const out: ZipEntry[] = [];
  let p = cdOff;
  for (let i = 0; i < cdEntries; i++) {
    if (readU32(buf, p) !== CDIR_SIG) throw new Error("invalid_zip: bad CDH");
    const method = readU16(buf, p + 10);
    const compressedSize = readU32(buf, p + 20);
    const uncompressedSize = readU32(buf, p + 24);
    const nameLen = readU16(buf, p + 28);
    const extraLen = readU16(buf, p + 30);
    const commentLen = readU16(buf, p + 32);
    const localHeaderOffset = readU32(buf, p + 42);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    if (!name.endsWith("/")) {
      out.push({
        path: name,
        localHeaderOffset,
        compressedSize,
        uncompressedSize,
        method,
      });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function decodeZipEntry(
  buf: Uint8Array,
  entry: ZipEntry,
): Promise<string> {
  const lh = entry.localHeaderOffset;
  if (readU32(buf, lh) !== LFH_SIG) throw new Error("invalid_zip: bad LFH");
  const nameLen = readU16(buf, lh + 26);
  const extraLen = readU16(buf, lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) {
    return new TextDecoder().decode(compressed);
  }
  if (entry.method === 8) {
    // raw deflate (no zlib wrapper) — use DecompressionStream.
    // Wrap the compressed slice in a Blob so Response accepts it as a
    // BodyInit across runtimes (Bun's lib types reject Uint8Array
    // directly otherwise).
    const ds = new DecompressionStream("deflate-raw");
    const blob = new Blob([new Uint8Array(compressed)]);
    const stream = new Response(blob).body!.pipeThrough(ds);
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    return new TextDecoder().decode(merged);
  }
  throw new Error(`unsupported zip compression method: ${entry.method}`);
}

export default projectMemoryRoute;
