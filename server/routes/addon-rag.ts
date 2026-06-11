/**
 * RAG (LightRAG) add-on. Holds the connection details for the LightRAG /
 * nemo-memory service so the URL is editable from the UI instead of being
 * hardcoded as the NEMO_MEMORY_URL env var.
 *
 *   GET  /api/addons/rag/info     → status + config
 *   PUT  /api/addons/rag/config   → set url, topK, timeoutMs, enabled
 *   POST /api/addons/rag/probe    → GET <url>/health, return result
 *
 * Resolution order for the live URL (resolveRagConfig): the user's enabled
 * add-on wins; otherwise the NEMO_MEMORY_URL env var is the global fallback
 * (so operators who hardcoded it keep working). The memory backend toggle
 * (Admin → Memory backend) decides whether LightRAG is consulted at all;
 * this add-on only supplies the connection.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";

import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const ragRoute = new Hono<Env>();

const ADDON_NAME = "RAG";

export type RagAddonConfig = {
  url?: string;
  topK?: number;
  timeoutMs?: number;
};

// Env fallback — what was hardcoded before the add-on existed.
const ENV_URL = (process.env.NEMO_MEMORY_URL || "").replace(/\/+$/, "");
const ENV_TOP_K = Number(process.env.NEMO_TOP_K ?? "5");
const ENV_TIMEOUT_MS = Number(process.env.NEMO_TIMEOUT_MS ?? "3000");

export async function findOrInitRagAddon(userId: string) {
  const [existing] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (existing) return existing;
  const [created] = await db
    .insert(addons)
    .values({
      userId,
      name: ADDON_NAME,
      kind: "plugin",
      description:
        "Semantic memory retrieval via a LightRAG / nemo-memory service. " +
        "Enter the service URL here instead of hardcoding it. Active only " +
        "when the memory backend (Admin → Memory backend) is set to LightRAG.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

/** Live connection config for chat-side code: the user's enabled add-on,
 *  else the env fallback. Returns null when no URL is configured anywhere. */
export async function resolveRagConfig(
  userId: string,
): Promise<{ url: string; topK: number; timeoutMs: number } | null> {
  const [row] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  const cfg = (row?.config ?? {}) as RagAddonConfig;
  const fromAddon = row?.enabled && cfg.url ? cfg.url.replace(/\/+$/, "") : "";
  const url = fromAddon || ENV_URL;
  if (!url) return null;
  return {
    url,
    topK: (fromAddon && cfg.topK) || ENV_TOP_K,
    timeoutMs: (fromAddon && cfg.timeoutMs) || ENV_TIMEOUT_MS,
  };
}

ragRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitRagAddon(userId);
  const cfg = (addon.config ?? {}) as RagAddonConfig;
  const url = (cfg.url || ENV_URL || "").replace(/\/+$/, "");
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    configured: Boolean(url),
    url,
    topK: cfg.topK ?? ENV_TOP_K,
    timeoutMs: cfg.timeoutMs ?? ENV_TIMEOUT_MS,
    envFallback: Boolean(ENV_URL), // UI hint: a global default exists
  });
});

const configSchema = z.object({
  enabled: z.boolean().optional(),
  url: z.string().url().max(300).optional(),
  topK: z.number().int().min(1).max(50).optional(),
  timeoutMs: z.number().int().min(200).max(60_000).optional(),
});

ragRoute.put("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const data = c.req.valid("json");
  const addon = await findOrInitRagAddon(userId);
  const cfg = { ...((addon.config ?? {}) as RagAddonConfig) };
  if (data.url !== undefined) cfg.url = data.url;
  if (data.topK !== undefined) cfg.topK = data.topK;
  if (data.timeoutMs !== undefined) cfg.timeoutMs = data.timeoutMs;

  const patch: {
    config: Record<string, unknown>;
    updatedAt: Date;
    enabled?: boolean;
  } = {
    config: cfg as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  };
  if (typeof data.enabled === "boolean") patch.enabled = data.enabled;

  const [updated] = await db
    .update(addons)
    .set(patch)
    .where(eq(addons.id, addon.id))
    .returning();
  const out = (updated.config ?? {}) as RagAddonConfig;
  return c.json({
    ok: true,
    enabled: updated.enabled,
    configured: Boolean(out.url || ENV_URL),
    url: (out.url || ENV_URL || "").replace(/\/+$/, ""),
    topK: out.topK ?? ENV_TOP_K,
    timeoutMs: out.timeoutMs ?? ENV_TIMEOUT_MS,
  });
});

ragRoute.post("/probe", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInitRagAddon(userId);
  const cfg = (addon.config ?? {}) as RagAddonConfig;
  const base = (cfg.url || ENV_URL || "").replace(/\/+$/, "");
  if (!base) return c.json({ error: "not_configured" }, 400);
  try {
    const res = await fetch(`${base}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return c.json({ ok: false, status: res.status }, 502);
    const body = await res.json();
    return c.json({ ok: true, health: body });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 502);
  }
});

export default ragRoute;
