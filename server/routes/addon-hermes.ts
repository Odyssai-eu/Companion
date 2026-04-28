/**
 * Hermes Agent add-on settings.
 *
 *   GET  /api/addons/hermes/info     → enabled, configured URL, available skills
 *   PATCH /api/addons/hermes/config  → set apiUrl, selected skills, model, autonomous
 *   GET  /api/addons/hermes/sessions → recent sessions (read-through to bridge)
 *   GET  /api/addons/hermes/sessions/:id → one session detail
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const hermesRoute = new Hono<Env>();

const ADDON_NAME = "Hermes Agent";

type Config = {
  apiUrl?: string;
  selectedSkills?: string[];
  defaultModel?: string;
  /** When true, hermes_deep runs with --yolo (bypass approvals). Off by default. */
  autonomous?: boolean;
};

async function findOrInit(userId: string) {
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
        "Delegate multi-step autonomous tasks to Hermes Agent. Quick mode for short tool-using requests, Deep mode for long-running background work.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

const DEFAULT_BRIDGE = "http://192.168.86.44:8002";

function bridgeUrl(cfg: Config): string {
  return (cfg.apiUrl ?? process.env.HERMES_BRIDGE_URL ?? DEFAULT_BRIDGE).replace(
    /\/+$/,
    "",
  );
}

// ── /info ──────────────────────────────────────────────────────────────────

hermesRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const url = bridgeUrl(cfg);

  // Try to fetch skills from the bridge — best-effort
  let skills: Array<{ name: string; description: string; kind: string }> = [];
  let bridgeOk = false;
  try {
    const r = await fetch(`${url}/skills`, {
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      const data = (await r.json()) as { skills?: typeof skills };
      skills = data.skills ?? [];
      bridgeOk = true;
    }
  } catch {
    // bridge down — surface in UI
  }

  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    apiUrl: cfg.apiUrl ?? null,
    bridgeUrl: url,
    bridgeOk,
    selectedSkills: cfg.selectedSkills ?? [],
    defaultModel: cfg.defaultModel ?? "claude-haiku",
    autonomous: cfg.autonomous ?? false,
    availableSkills: skills,
  });
});

// ── /config ────────────────────────────────────────────────────────────────

const configSchema = z.object({
  apiUrl: z.string().url().nullish(),
  selectedSkills: z.array(z.string()).optional(),
  defaultModel: z.string().max(120).optional(),
  autonomous: z.boolean().optional(),
});

hermesRoute.patch("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const data = c.req.valid("json");
  if (data.apiUrl !== undefined) cfg.apiUrl = data.apiUrl ?? undefined;
  if (data.selectedSkills !== undefined) cfg.selectedSkills = data.selectedSkills;
  if (data.defaultModel !== undefined) cfg.defaultModel = data.defaultModel;
  if (data.autonomous !== undefined) cfg.autonomous = data.autonomous;
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, addon.id));
  return c.json({ ok: true });
});

// ── /sessions (read-through proxy) ─────────────────────────────────────────

hermesRoute.get("/sessions", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  try {
    const r = await fetch(`${bridgeUrl(cfg)}/sessions`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return c.json({ sessions: [] });
    return c.json(await r.json());
  } catch (e) {
    return c.json({ sessions: [], error: String(e) });
  }
});

hermesRoute.get("/sessions/:id", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const id = c.req.param("id");
  try {
    const r = await fetch(`${bridgeUrl(cfg)}/sessions/${id}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return c.json({ error: "not_found" }, 404);
    return c.json(await r.json());
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

export default hermesRoute;
