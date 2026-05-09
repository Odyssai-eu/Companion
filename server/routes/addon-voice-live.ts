/**
 * Voice (Gemini Live) add-on settings.
 *
 *   GET   /api/addons/voice-live/info     → enabled, hasApiKey, model, voice
 *   PATCH /api/addons/voice-live/config   → set apiKey, model, voice
 *
 * Talks directly to the Gemini Live API
 * (wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent)
 * for full-duplex real-time voice. Audio: PCM 16-bit 16 kHz LE in,
 * 24 kHz out (per the live-api spec). Auth = API key query string in v1;
 * we'll switch to ephemeral tokens (AuthTokenService) once the GA flow is
 * stable client-side.
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const voiceLiveRoute = new Hono<Env>();

const ADDON_NAME = "Voice (Gemini Live)";

type Config = {
  apiKey?: string;
  model?: string;
  voice?: string;
  systemInstruction?: string;
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
        "Real-time bidirectional voice via Gemini Live API. PCM streaming over WebSocket. Replaces local TTS/ASR pipelines while Voxtral/Kokoro mature.",
      version: "0.1.0",
      enabled: false,
    })
    .returning();
  return created;
}

// Gemini 3.1 Flash Live (preview) — newest Live model as of 2026-05.
// Native speech↔speech, claims 70+ languages, lower latency, and
// drastically better non-English transcription than the 2.5 native-audio
// dialog model that mis-transcribes FR speech as EN-phonetic words.
const DEFAULT_MODEL = "models/gemini-3.1-flash-live-preview";
const DEFAULT_VOICE = "Aoede";

voiceLiveRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    hasApiKey: Boolean(cfg.apiKey),
    model: cfg.model ?? DEFAULT_MODEL,
    voice: cfg.voice ?? DEFAULT_VOICE,
    systemInstruction: cfg.systemInstruction ?? "",
  });
});

const configSchema = z.object({
  apiKey: z.string().min(1).max(256).nullish(),
  model: z.string().max(200).optional(),
  voice: z.string().max(80).optional(),
  systemInstruction: z.string().max(8000).optional(),
});

voiceLiveRoute.patch("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const data = c.req.valid("json");
  if (data.apiKey !== undefined) cfg.apiKey = data.apiKey ?? undefined;
  if (data.model !== undefined) cfg.model = data.model;
  if (data.voice !== undefined) cfg.voice = data.voice;
  if (data.systemInstruction !== undefined)
    cfg.systemInstruction = data.systemInstruction;
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, addon.id));
  return c.json({ ok: true });
});

/**
 * Mint an ephemeral session payload for the frontend so the browser can
 * open the WebSocket without leaking the long-lived API key into client
 * code. v1: returns the API key directly (browser → Google). v2 will
 * exchange for an ephemeral access_token via Google's AuthTokenService.
 */
voiceLiveRoute.post("/session", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  if (!addon.enabled) return c.json({ error: "addon_disabled" }, 400);
  const cfg = (addon.config ?? {}) as Config;
  if (!cfg.apiKey) return c.json({ error: "missing_api_key" }, 400);
  return c.json({
    apiKey: cfg.apiKey, // TODO v0.3: replace with ephemeral access_token
    model: cfg.model ?? DEFAULT_MODEL,
    voice: cfg.voice ?? DEFAULT_VOICE,
    systemInstruction: cfg.systemInstruction ?? "",
    wsUrl:
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
  });
});

export default voiceLiveRoute;
