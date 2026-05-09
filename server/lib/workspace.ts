/**
 * User workspace — virtual filesystem stored in `workspace_files`.
 *
 * Every operation is scoped to `userId`. Paths are normalized and validated
 * against traversal attempts. v1 stores text content directly in Postgres;
 * binary blobs and FS-backed storage are deferred to v2.
 */

import { and, eq, like, sql } from "drizzle-orm";
import { db } from "../db/index";
import { workspaceFiles } from "../db/schema";

const MAX_FILE_BYTES = 1_000_000; // 1 MB per file
const MAX_WORKSPACE_BYTES = 10_000_000; // 10 MB per user (v1)
const MAX_PATH_LENGTH = 512;

export class WorkspaceError extends Error {
  constructor(
    public readonly code:
      | "invalid_path"
      | "file_too_large"
      | "quota_exceeded"
      | "not_found"
      | "edit_old_string_not_found"
      | "edit_old_string_not_unique",
    message: string,
  ) {
    super(message);
  }
}

/** Normalize and validate a workspace path. Returns the canonical form. */
export function normalizePath(input: string): string {
  if (typeof input !== "string") {
    throw new WorkspaceError("invalid_path", "path must be a string");
  }
  let p = input.trim().replace(/\\/g, "/");
  // Strip leading slashes — workspace paths are always relative
  p = p.replace(/^\/+/, "");
  if (p.length === 0) {
    throw new WorkspaceError("invalid_path", "path cannot be empty");
  }
  if (p.length > MAX_PATH_LENGTH) {
    throw new WorkspaceError("invalid_path", "path too long");
  }
  // Block traversal segments
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new WorkspaceError("invalid_path", "invalid path segment");
    }
    // Block control chars and null bytes
    if (/[\x00-\x1f]/.test(seg)) {
      throw new WorkspaceError("invalid_path", "path contains control chars");
    }
  }
  return segments.join("/");
}

export type WorkspaceFile = {
  path: string;
  sizeBytes: number;
  mimeType: string;
  updatedAt: Date;
};

export async function fsList(
  userId: string,
  prefix?: string,
): Promise<WorkspaceFile[]> {
  const where = prefix
    ? and(
        eq(workspaceFiles.userId, userId),
        like(workspaceFiles.path, `${normalizePath(prefix)}%`),
      )
    : eq(workspaceFiles.userId, userId);

  const rows = await db
    .select({
      path: workspaceFiles.path,
      sizeBytes: workspaceFiles.sizeBytes,
      mimeType: workspaceFiles.mimeType,
      updatedAt: workspaceFiles.updatedAt,
    })
    .from(workspaceFiles)
    .where(where)
    .orderBy(workspaceFiles.path);

  return rows;
}

export async function fsRead(
  userId: string,
  rawPath: string,
): Promise<{ path: string; content: string; mimeType: string }> {
  const path = normalizePath(rawPath);
  const [row] = await db
    .select({
      path: workspaceFiles.path,
      content: workspaceFiles.content,
      mimeType: workspaceFiles.mimeType,
    })
    .from(workspaceFiles)
    .where(
      and(eq(workspaceFiles.userId, userId), eq(workspaceFiles.path, path)),
    )
    .limit(1);

  if (!row) {
    throw new WorkspaceError("not_found", `file not found: ${path}`);
  }
  return row;
}

async function getWorkspaceUsage(userId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${workspaceFiles.sizeBytes}), 0)::int`,
    })
    .from(workspaceFiles)
    .where(eq(workspaceFiles.userId, userId));
  return row?.total ?? 0;
}

export async function fsWrite(
  userId: string,
  rawPath: string,
  content: string,
  mimeType = "text/plain",
): Promise<{ path: string; sizeBytes: number; created: boolean }> {
  const path = normalizePath(rawPath);
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_BYTES) {
    throw new WorkspaceError(
      "file_too_large",
      `file exceeds ${MAX_FILE_BYTES} bytes`,
    );
  }

  // Quota check — fetch current size of this file (if exists) to compute delta
  const [existing] = await db
    .select({ sizeBytes: workspaceFiles.sizeBytes })
    .from(workspaceFiles)
    .where(
      and(eq(workspaceFiles.userId, userId), eq(workspaceFiles.path, path)),
    )
    .limit(1);

  const usage = await getWorkspaceUsage(userId);
  const delta = size - (existing?.sizeBytes ?? 0);
  if (usage + delta > MAX_WORKSPACE_BYTES) {
    throw new WorkspaceError(
      "quota_exceeded",
      `workspace quota exceeded (${MAX_WORKSPACE_BYTES} bytes max)`,
    );
  }

  const created = !existing;

  await db
    .insert(workspaceFiles)
    .values({ userId, path, content, sizeBytes: size, mimeType })
    .onConflictDoUpdate({
      target: [workspaceFiles.userId, workspaceFiles.path],
      set: {
        content,
        sizeBytes: size,
        mimeType,
        updatedAt: sql`now()`,
      },
    });

  return { path, sizeBytes: size, created };
}

export async function fsEdit(
  userId: string,
  rawPath: string,
  oldString: string,
  newString: string,
): Promise<{ path: string; sizeBytes: number }> {
  const path = normalizePath(rawPath);
  const file = await fsRead(userId, path);

  const occurrences = file.content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new WorkspaceError(
      "edit_old_string_not_found",
      "old_string not found in file",
    );
  }
  if (occurrences > 1) {
    throw new WorkspaceError(
      "edit_old_string_not_unique",
      `old_string matches ${occurrences} locations — provide more context to make it unique`,
    );
  }

  const updated = file.content.replace(oldString, newString);
  const result = await fsWrite(userId, path, updated, file.mimeType);
  return { path: result.path, sizeBytes: result.sizeBytes };
}

export async function fsDelete(userId: string, rawPath: string): Promise<void> {
  const path = normalizePath(rawPath);
  const result = await db
    .delete(workspaceFiles)
    .where(
      and(eq(workspaceFiles.userId, userId), eq(workspaceFiles.path, path)),
    );
  if ((result as { rowCount?: number }).rowCount === 0) {
    throw new WorkspaceError("not_found", `file not found: ${path}`);
  }
}

export async function getWorkspaceStats(
  userId: string,
): Promise<{ fileCount: number; bytesUsed: number; bytesQuota: number }> {
  const [row] = await db
    .select({
      fileCount: sql<number>`count(*)::int`,
      bytesUsed: sql<number>`coalesce(sum(${workspaceFiles.sizeBytes}), 0)::int`,
    })
    .from(workspaceFiles)
    .where(eq(workspaceFiles.userId, userId));
  return {
    fileCount: row?.fileCount ?? 0,
    bytesUsed: row?.bytesUsed ?? 0,
    bytesQuota: MAX_WORKSPACE_BYTES,
  };
}
