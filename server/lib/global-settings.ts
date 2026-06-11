/**
 * Deployment-wide settings (singleton row id=1 in `global_settings`).
 *
 * Memory is always RAG now, so the only live setting is the company LightRAG
 * URL. (The `memory_backend` column stays in the table but is dormant — the
 * wiki backend toggle was retired.) Read on the chat hot path, so cached a few
 * seconds; invalidated immediately on write.
 */
import { eq } from "drizzle-orm";

import { db } from "../db/index";
import { globalSettings } from "../db/schema";

const CACHE_TTL_MS = 30_000;
let cache: { companyRagUrl: string; at: number } | null = null;

/** Read-through load of the singleton's company URL, seeding the row if absent. */
async function load(): Promise<string> {
  let [row] = await db
    .select({ companyUrl: globalSettings.companyRagUrl })
    .from(globalSettings)
    .where(eq(globalSettings.id, 1))
    .limit(1);
  if (!row) {
    await db.insert(globalSettings).values({ id: 1 }).onConflictDoNothing();
    [row] = await db
      .select({ companyUrl: globalSettings.companyRagUrl })
      .from(globalSettings)
      .where(eq(globalSettings.id, 1))
      .limit(1);
  }
  return (row?.companyUrl ?? "").replace(/\/+$/, "");
}

/** The company LightRAG URL (standard API, shared company graph). "" = off. */
export async function getCompanyRagUrl(): Promise<string> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.companyRagUrl;
  const companyRagUrl = await load();
  cache = { companyRagUrl, at: now };
  return companyRagUrl;
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
  cache = { companyRagUrl: clean, at: Date.now() };
}
