/**
 * Hermes Agent add-on settings — adapted to the native Hermes Gateway
 * (NousResearch hermes-agent v0.12+) which exposes an OpenAI-compatible
 * API on `:8642` with mandatory Bearer auth.
 *
 *   GET   /api/addons/hermes/info     → enabled, gateway URL, available models, hasApiKey
 *   PATCH /api/addons/hermes/config   → set apiUrl, apiKey (Bearer), defaultModel
 *
 * The previous bridge (thecompai-hermes-bridge FastAPI on :8002) is gone.
 * No more /skills, /sessions, mode quick/deep, or yolo flag — those don't
 * exist in the native gateway. The agent is queried as a regular OpenAI
 * chat completion; Hermes injects its own tools/skills server-side.
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
  apiKey?: string;
  defaultModel?: string;
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
        "Delegate tasks to the Hermes Agent gateway (NousResearch hermes-agent). " +
        "OpenAI-compatible chat completions; tools/skills are managed inside Hermes itself.",
      version: "0.2.0",
      enabled: false,
    })
    .returning();
  return created;
}

const DEFAULT_GATEWAY = "http://192.168.86.50:8642";

function gatewayUrl(cfg: Config): string {
  return (cfg.apiUrl ?? process.env.HERMES_GATEWAY_URL ?? DEFAULT_GATEWAY).replace(
    /\/+$/,
    "",
  );
}

// ── /info ──────────────────────────────────────────────────────────────────

hermesRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const url = gatewayUrl(cfg);

  // Probe /v1/models to confirm reachability + auth. Bearer is mandatory
  // on the native gateway; without a key we still return reachable=false
  // so the UI shows the user they need to configure.
  let availableModels: Array<{ id: string }> = [];
  let gatewayOk = false;
  let lastError: string | null = null;
  if (cfg.apiKey) {
    try {
      const r = await fetch(`${url}/v1/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const data = (await r.json()) as { data?: Array<{ id: string }> };
        availableModels = data.data ?? [];
        gatewayOk = true;
      } else {
        lastError = `gateway ${r.status}`;
      }
    } catch (e) {
      lastError = (e as Error).message;
    }
  } else {
    lastError = "missing api key";
  }

  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    apiUrl: cfg.apiUrl ?? null,
    gatewayUrl: url,
    gatewayOk,
    hasApiKey: Boolean(cfg.apiKey),
    defaultModel: cfg.defaultModel ?? "hermes-agent",
    availableModels,
    lastError,
  });
});

// ── /config ────────────────────────────────────────────────────────────────

const configSchema = z.object({
  apiUrl: z.string().url().nullish(),
  apiKey: z.string().min(1).max(256).nullish(),
  defaultModel: z.string().max(120).optional(),
});

hermesRoute.patch("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const data = c.req.valid("json");
  if (data.apiUrl !== undefined) cfg.apiUrl = data.apiUrl ?? undefined;
  if (data.apiKey !== undefined) cfg.apiKey = data.apiKey ?? undefined;
  if (data.defaultModel !== undefined) cfg.defaultModel = data.defaultModel;
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, addon.id));
  return c.json({ ok: true });
});

export default hermesRoute;
