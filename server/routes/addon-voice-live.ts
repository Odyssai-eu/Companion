/**
 * Voice add-on settings.
 *
 *   GET   /api/addons/voice-live/info     → enabled, provider, endpoints, voice
 *   PATCH /api/addons/voice-live/config   → set endpoints, ttsModel, voice
 *
 * The chat speaks replies and transcribes the mic through a local,
 * OpenAI-compatible audio server (/v1/audio/speech + /v1/audio/transcriptions).
 * The TTS/ASR proxy in routes/tts.ts consumes resolveVoiceConfig().
 */

import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db } from "../db/index";
import { addons } from "../db/schema";

type Env = { Variables: { userId: string } };
const voiceLiveRoute = new Hono<Env>();

const ADDON_NAME = "Voice";
const LEGACY_ADDON_NAME = "Voice (Gemini Live)";
const ADDON_DESCRIPTION =
  "Unified voice in/out for chat (TTS + ASR). Local OpenAI-compatible audio — set its endpoint.";

export type VoiceProvider = "local";

type Config = {
  /** Which voice backend the chat uses. Always 'local'. */
  provider?: VoiceProvider;
  // local: OpenAI-compatible /v1/audio/* endpoints (speech + transcriptions).
  ttsEndpoint?: string;
  asrEndpoint?: string;
  ttsModel?: string;
  voice?: string;
};

async function findOrInit(userId: string) {
  const [existing] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (existing) return existing;
  // Migrate the legacy "Voice (Gemini Live)" row in place so a saved endpoint /
  // model / voice survives the rename to the unified "Voice" addon (#26).
  const [legacy] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, LEGACY_ADDON_NAME)))
    .limit(1);
  if (legacy) {
    const [renamed] = await db
      .update(addons)
      .set({
        name: ADDON_NAME,
        description: ADDON_DESCRIPTION,
        updatedAt: new Date(),
      })
      .where(eq(addons.id, legacy.id))
      .returning();
    return renamed;
  }
  const [created] = await db
    .insert(addons)
    .values({
      userId,
      name: ADDON_NAME,
      kind: "plugin",
      description: ADDON_DESCRIPTION,
      version: "0.2.0",
      enabled: false,
    })
    .returning();
  return created;
}

// Defaults. TTS/ASR fall back to the env-configured local endpoint so a fresh
// install speaks without any UI config (bootstrap).
const DEFAULT_PROVIDER: VoiceProvider = "local";
const DEFAULT_TTS_ENDPOINT = process.env.TTS_BASE_URL ?? "";
const DEFAULT_TTS_MODEL =
  process.env.TTS_DEFAULT_MODEL ?? "mlx-community/VibeVoice-Realtime-0.5B-8bit";
// No imposed default voice — the user picks their own speaker in the Voice
// field. Empty falls through to the server's own fallback speaker.
const DEFAULT_TTS_VOICE = process.env.TTS_DEFAULT_VOICE ?? "";

voiceLiveRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const provider = cfg.provider ?? DEFAULT_PROVIDER;
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    provider,
    ttsEndpoint: cfg.ttsEndpoint ?? DEFAULT_TTS_ENDPOINT,
    asrEndpoint: cfg.asrEndpoint ?? cfg.ttsEndpoint ?? DEFAULT_TTS_ENDPOINT,
    ttsModel: cfg.ttsModel ?? DEFAULT_TTS_MODEL,
    voice: cfg.voice ?? DEFAULT_TTS_VOICE,
  });
});

const configSchema = z.object({
  provider: z.enum(["local"]).optional(),
  ttsEndpoint: z.string().max(500).optional(),
  asrEndpoint: z.string().max(500).optional(),
  ttsModel: z.string().max(200).optional(),
  voice: z.string().max(500).optional(),
});

voiceLiveRoute.patch("/config", zValidator("json", configSchema), async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const data = c.req.valid("json");
  if (data.provider !== undefined) cfg.provider = data.provider;
  if (data.ttsEndpoint !== undefined) cfg.ttsEndpoint = data.ttsEndpoint;
  if (data.asrEndpoint !== undefined) cfg.asrEndpoint = data.asrEndpoint;
  if (data.ttsModel !== undefined) cfg.ttsModel = data.ttsModel;
  if (data.voice !== undefined) cfg.voice = data.voice;
  await db
    .update(addons)
    .set({ config: cfg, updatedAt: new Date() })
    .where(eq(addons.id, addon.id));
  return c.json({ ok: true });
});

/**
 * Resolve the user's effective voice config (provider + endpoints + model +
 * voice) with env bootstrap defaults. Consumed by the TTS/ASR proxy so the
 * endpoint is user-configurable instead of frozen on TTS_BASE_URL (#26).
 */
export async function resolveVoiceConfig(userId: string) {
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  return {
    enabled: addon.enabled,
    provider: cfg.provider ?? DEFAULT_PROVIDER,
    ttsEndpoint: cfg.ttsEndpoint || DEFAULT_TTS_ENDPOINT,
    asrEndpoint: cfg.asrEndpoint || cfg.ttsEndpoint || DEFAULT_TTS_ENDPOINT,
    ttsModel: cfg.ttsModel || DEFAULT_TTS_MODEL,
    voice: cfg.voice || DEFAULT_TTS_VOICE,
  };
}

export default voiceLiveRoute;
