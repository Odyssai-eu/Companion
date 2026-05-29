/**
 * Global user-memory vault routes — the user-scoped twin of
 * `server/routes/project-memory.ts`. Files live in `user_memory_files`
 * (DB-backed, ZIP-imported) and/or `users.external_vault_path` (live
 * filesystem read). Coexists with the Karpathy auto-wiki by default;
 * `users.auto_memory_enabled = false` makes this corpus the only source.
 *
 *   GET    /api/profile/vault                list files + stats + user settings
 *   POST   /api/profile/vault/files          single file upsert
 *   POST   /api/profile/vault/import         multipart zip — unpacked into the corpus
 *   POST   /api/profile/vault/external       absolute path on the server filesystem
 *                                            → walk + copy into the corpus
 *   PUT    /api/profile/vault/settings       externalVaultPath / readOnly / autoMemoryEnabled
 *   DELETE /api/profile/vault/file?path=…    remove one file
 *   DELETE /api/profile/vault                wipe the whole corpus
 *
 * Quotas mirror project-memory : 1 MB per file, 50 MB per user corpus
 * (vs 10 MB per project — the global vault is the user's real long-term
 * memory store, so we give it 5× the room).
 *
 * TODO : `parseZipEntries` / `decodeZipEntry` / `safePath` are duplicated
 * from project-memory.ts. Extract to `server/lib/zip-reader.ts` in a
 * follow-up so both vaults share the same parsing path. Kept inline here
 * for now so this PR doesn't churn project-memory.ts.
 */

import { promises as fs } from "node:fs";
import { join, normalize, resolve as pathResolve } from "node:path";
import { and, eq, like, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { userMemoryFiles, users } from "../db/schema";
import { getUserMemoryStats, isMacOsCruft } from "../lib/user-memory";

type Env = { Variables: { userId: string } };
const userMemoryRoute = new Hono<Env>();

const MAX_FILE_BYTES = 1 * 1024 * 1024;
const MAX_CORPUS_BYTES = 50 * 1024 * 1024;
const ACCEPTED_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
]);

function safePath(raw: string): string | null {
  const trimmed = raw.replace(/^[/\\]+/, "");
  const norm = normalize(trimmed).replace(/\\/g, "/");
  if (!norm || norm.startsWith("..") || norm.includes("/../")) return null;
  return norm;
}

userMemoryRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select({
      path: userMemoryFiles.path,
      mimeType: userMemoryFiles.mimeType,
      sizeBytes: userMemoryFiles.sizeBytes,
      updatedAt: userMemoryFiles.updatedAt,
    })
    .from(userMemoryFiles)
    .where(eq(userMemoryFiles.userId, userId))
    .orderBy(userMemoryFiles.path);
  const stats = await getUserMemoryStats(userId);
  const [u] = await db
    .select({
      externalVaultPath: users.externalVaultPath,
      externalVaultReadOnly: users.externalVaultReadOnly,
      autoMemoryEnabled: users.autoMemoryEnabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return c.json({
    files: rows,
    stats: {
      ...stats,
      bytesQuota: MAX_CORPUS_BYTES,
    },
    settings: {
      externalVaultPath: u?.externalVaultPath ?? null,
      externalVaultReadOnly: u?.externalVaultReadOnly ?? true,
      autoMemoryEnabled: u?.autoMemoryEnabled ?? true,
    },
  });
});

const fileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(MAX_FILE_BYTES),
  mimeType: z.string().max(80).optional(),
});

userMemoryRoute.post(
  "/files",
  zValidator("json", fileSchema),
  async (c) => {
    const userId = c.get("userId");
    const data = c.req.valid("json");
    const path = safePath(data.path);
    if (!path) return c.json({ error: "invalid_path" }, 400);
    const sizeBytes = new TextEncoder().encode(data.content).length;
    if (sizeBytes > MAX_FILE_BYTES) {
      return c.json({ error: "file_too_large" }, 413);
    }
    const stats = await getUserMemoryStats(userId);
    if (stats.bytesUsed + sizeBytes > MAX_CORPUS_BYTES) {
      return c.json({ error: "corpus_quota_exceeded" }, 413);
    }
    await db
      .insert(userMemoryFiles)
      .values({
        userId,
        path,
        mimeType: data.mimeType ?? "text/markdown",
        sizeBytes,
        content: data.content,
      })
      .onConflictDoUpdate({
        target: [userMemoryFiles.userId, userMemoryFiles.path],
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

userMemoryRoute.post("/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.parseBody();
  const file = body["file"];
  if (!(file instanceof File)) {
    return c.json({ error: "missing_file" }, 400);
  }
  // Bigger zip cap than the project vault — same logic as the corpus
  // cap: this is the user's full long-term store, often a real
  // multi-hundred-file Obsidian export.
  if (file.size > 100 * 1024 * 1024) {
    return c.json({ error: "zip_too_large" }, 413);
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  try {
    const result = await importZipIntoUser(userId, buf);
    return c.json(result);
  } catch (e) {
    return c.json(
      { error: "import_failed", detail: (e as Error).message },
      400,
    );
  }
});

const externalImportSchema = z.object({
  path: z.string().min(1).max(1000),
});

/** One-shot import : walk an absolute filesystem path and copy matching
 *  files into the DB corpus. Distinct from the LIVE external_vault_path
 *  which is read every turn — this is a snapshot. */
userMemoryRoute.post(
  "/external",
  zValidator("json", externalImportSchema),
  async (c) => {
    const userId = c.get("userId");
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
      const result = await importDirIntoUser(userId, resolved);
      return c.json(result);
    } catch (e) {
      return c.json(
        { error: "import_failed", detail: (e as Error).message },
        500,
      );
    }
  },
);

const settingsSchema = z.object({
  externalVaultPath: z.string().max(1000).nullable().optional(),
  externalVaultReadOnly: z.boolean().optional(),
  autoMemoryEnabled: z.boolean().optional(),
});

userMemoryRoute.put(
  "/settings",
  zValidator("json", settingsSchema),
  async (c) => {
    const userId = c.get("userId");
    const data = c.req.valid("json");
    const patch: Record<string, unknown> = {};
    if (data.externalVaultPath !== undefined) {
      const trimmed = data.externalVaultPath?.trim();
      patch.externalVaultPath = trimmed || null;
    }
    if (data.externalVaultReadOnly !== undefined) {
      patch.externalVaultReadOnly = data.externalVaultReadOnly;
    }
    if (data.autoMemoryEnabled !== undefined) {
      patch.autoMemoryEnabled = data.autoMemoryEnabled;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ ok: true, changed: false });
    }
    await db.update(users).set(patch).where(eq(users.id, userId));
    return c.json({ ok: true, changed: true });
  },
);

userMemoryRoute.delete("/file", async (c) => {
  const userId = c.get("userId");
  const path = c.req.query("path");
  if (!path) return c.json({ error: "missing_path" }, 400);
  const safe = safePath(path);
  if (!safe) return c.json({ error: "invalid_path" }, 400);
  await db
    .delete(userMemoryFiles)
    .where(
      and(eq(userMemoryFiles.userId, userId), eq(userMemoryFiles.path, safe)),
    );
  return c.body(null, 204);
});

userMemoryRoute.delete("/", async (c) => {
  const userId = c.get("userId");
  await db.delete(userMemoryFiles).where(eq(userMemoryFiles.userId, userId));
  return c.body(null, 204);
});

// ── Import helpers ───────────────────────────────────────────────────────

type ImportResult = {
  imported: Array<{ path: string; bytes: number }>;
  skipped: Array<{ path: string; reason: string }>;
  bytesUsed: number;
  bytesQuota: number;
};

async function importZipIntoUser(
  userId: string,
  zipBytes: Uint8Array,
): Promise<ImportResult> {
  const entries = parseZipEntries(zipBytes);
  return importEntries(
    userId,
    entries.map((e) => ({
      path: e.path,
      load: async () => decodeZipEntry(zipBytes, e),
    })),
  );
}

async function importDirIntoUser(
  userId: string,
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
    userId,
    files.map((f) => ({
      path: f.path,
      load: async () => fs.readFile(f.abs, "utf8"),
    })),
  );
}

async function importEntries(
  userId: string,
  entries: Array<{ path: string; load: () => Promise<string> }>,
): Promise<ImportResult> {
  const imported: ImportResult["imported"] = [];
  const skipped: ImportResult["skipped"] = [];

  // One-shot purge of any historical macOS resource forks the user
  // already accumulated. Re-importing a clean ZIP shouldn't leave
  // last week's `__MACOSX/._foo.md` rows wasting their 50 MB quota —
  // and more importantly, those rows are what was poisoning the
  // model's system prompt before the read-time filter shipped.
  await db
    .delete(userMemoryFiles)
    .where(
      and(
        eq(userMemoryFiles.userId, userId),
        or(
          like(userMemoryFiles.path, "__MACOSX/%"),
          like(userMemoryFiles.path, "%/._%"),
          like(userMemoryFiles.path, "._%"),
          like(userMemoryFiles.path, "%/.DS_Store"),
          eq(userMemoryFiles.path, ".DS_Store"),
        ),
      ),
    );

  let bytesUsed = (await getUserMemoryStats(userId)).bytesUsed;

  for (const e of entries) {
    const safe = safePath(e.path);
    if (!safe) {
      skipped.push({ path: e.path, reason: "invalid_path" });
      continue;
    }
    if (isMacOsCruft(safe)) {
      skipped.push({ path: safe, reason: "macos_resource_fork" });
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
    // Postgres TEXT columns reject NULL bytes (0x00). Real Markdown never
    // contains them, so they only appear when the source was binary, was
    // decoded with the wrong charset (UTF-16 read as UTF-8 produces lots
    // of nulls), or got corrupted. Strip rather than skip so one bad byte
    // doesn't lose a whole file.
    if (content.indexOf("\u0000") >= 0) {
      content = content.replace(/\u0000+/g, "");
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
    try {
      await db
        .insert(userMemoryFiles)
        .values({
          userId,
          path: safe,
          mimeType,
          sizeBytes,
          content,
        })
        .onConflictDoUpdate({
          target: [userMemoryFiles.userId, userMemoryFiles.path],
          set: { content, sizeBytes, mimeType, updatedAt: new Date() },
        });
    } catch (err) {
      // Don't let one bad row abort the whole import. Common causes:
      // residual encoding artefacts, surrogate halves in JSON strings,
      // anything else the driver chokes on. Record and continue.
      skipped.push({
        path: safe,
        reason: `db_insert_failed: ${(err as Error).message.slice(0, 80)}`,
      });
      continue;
    }
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
// Duplicated from server/routes/project-memory.ts. See TODO at top of file
// — extract to a shared lib/zip-reader.ts in a follow-up.

type ZipEntry = {
  path: string;
  localHeaderOffset: number;
  compressedSize: number;
  uncompressedSize: number;
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

export default userMemoryRoute;
