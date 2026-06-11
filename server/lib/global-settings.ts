/**
 * Deployment-wide settings (singleton row id=1 in `global_settings`).
 *
 * Read on the chat hot path, so we cache the row for a few seconds rather
 * than hitting Postgres every turn; the cache is invalidated immediately on
 * write so the admin toggle takes effect at once.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/index";
import { globalSettings } from "../db/schema";

export type MemoryBackend = "lightrag" | "wiki";

const CACHE_TTL_MS = 30_000;
let cache: { backend: MemoryBackend; at: number } | null = null;

/** Read-through cache of the singleton row, seeding it if missing. */
async function load(): Promise<MemoryBackend> {
  let [row] = await db
    .select({ backend: globalSettings.memoryBackend })
    .from(globalSettings)
    .where(eq(globalSettings.id, 1))
    .limit(1);
  if (!row) {
    // First boot after the migration: seed the singleton.
    await db
      .insert(globalSettings)
      .values({ id: 1 })
      .onConflictDoNothing();
    [row] = await db
      .select({ backend: globalSettings.memoryBackend })
      .from(globalSettings)
      .where(eq(globalSettings.id, 1))
      .limit(1);
  }
  return (row?.backend as MemoryBackend) ?? "lightrag";
}

/** Which memory backend is active deployment-wide. Cached ~30s. */
export async function getMemoryBackend(): Promise<MemoryBackend> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.backend;
  const backend = await load();
  cache = { backend, at: now };
  return backend;
}

/** Persist the backend choice and invalidate the cache immediately. */
export async function setMemoryBackend(backend: MemoryBackend): Promise<void> {
  await db
    .insert(globalSettings)
    .values({ id: 1, memoryBackend: backend, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: globalSettings.id,
      set: { memoryBackend: backend, updatedAt: new Date() },
    });
  cache = { backend, at: Date.now() };
}
