/**
 * Deployment-wide settings (singleton row id=1 in `global_settings`).
 *
 * Read on the chat hot path, so we cache the row for a few seconds rather
 * than hitting Postgres every turn; the cache is invalidated immediately on
 * write so admin edits take effect at once.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/index";
import { globalSettings } from "../db/schema";

export type MemoryBackend = "lightrag" | "wiki";
export type GlobalSettingsView = {
  memoryBackend: MemoryBackend;
  companyRagUrl: string;
};

const CACHE_TTL_MS = 30_000;
let cache: { value: GlobalSettingsView; at: number } | null = null;

/** Read-through cache of the singleton row, seeding it if missing. */
async function load(): Promise<GlobalSettingsView> {
  let [row] = await db
    .select({
      backend: globalSettings.memoryBackend,
      companyUrl: globalSettings.companyRagUrl,
    })
    .from(globalSettings)
    .where(eq(globalSettings.id, 1))
    .limit(1);
  if (!row) {
    await db.insert(globalSettings).values({ id: 1 }).onConflictDoNothing();
    [row] = await db
      .select({
        backend: globalSettings.memoryBackend,
        companyUrl: globalSettings.companyRagUrl,
      })
      .from(globalSettings)
      .where(eq(globalSettings.id, 1))
      .limit(1);
  }
  return {
    memoryBackend: (row?.backend as MemoryBackend) ?? "lightrag",
    companyRagUrl: (row?.companyUrl ?? "").replace(/\/+$/, ""),
  };
}

/** The full settings view, cached ~30s. */
export async function getSettings(): Promise<GlobalSettingsView> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  const value = await load();
  cache = { value, at: now };
  return value;
}

/** Which memory backend is active deployment-wide. */
export async function getMemoryBackend(): Promise<MemoryBackend> {
  return (await getSettings()).memoryBackend;
}

/** The company LightRAG URL (standard API, shared company graph). "" = off. */
export async function getCompanyRagUrl(): Promise<string> {
  return (await getSettings()).companyRagUrl;
}

function invalidate(next: Partial<GlobalSettingsView>): void {
  if (cache) cache = { value: { ...cache.value, ...next }, at: Date.now() };
  else cache = null;
}

export async function setMemoryBackend(backend: MemoryBackend): Promise<void> {
  await db
    .insert(globalSettings)
    .values({ id: 1, memoryBackend: backend, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: globalSettings.id,
      set: { memoryBackend: backend, updatedAt: new Date() },
    });
  invalidate({ memoryBackend: backend });
}

export async function setCompanyRagUrl(url: string): Promise<void> {
  const clean = url.replace(/\/+$/, "");
  await db
    .insert(globalSettings)
    .values({ id: 1, companyRagUrl: clean, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: globalSettings.id,
      set: { companyRagUrl: clean, updatedAt: new Date() },
    });
  invalidate({ companyRagUrl: clean });
}
