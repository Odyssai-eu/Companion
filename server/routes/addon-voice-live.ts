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
import { addons, conversations } from "../db/schema";
import { getMemoryContext } from "../lib/memory";

type Env = { Variables: { userId: string } };
const voiceLiveRoute = new Hono<Env>();

const ADDON_NAME = "Voice";
const LEGACY_ADDON_NAME = "Voice (Gemini Live)";
const ADDON_DESCRIPTION =
  "Unified voice in/out for chat (TTS + ASR). Pick a provider — local " +
  "OpenAI-compatible audio, Gemini Live full-duplex, or Mistral/Voxtral — " +
  "and set its endpoint.";

export type VoiceProvider = "local" | "gemini" | "mistral";

type Config = {
  /** Which voice backend the chat uses. Default 'local'. */
  provider?: VoiceProvider;
  // local + mistral: OpenAI-compatible /v1/audio/* endpoints. Mistral exposes
  // Voxtral the same way (speech + transcriptions), so both just need a base URL.
  ttsEndpoint?: string;
  asrEndpoint?: string;
  ttsModel?: string;
  voice?: string;
  // gemini full-duplex (Live API over WebSocket)
  apiKey?: string;
  model?: string;
  systemInstruction?: string;
};

async function findOrInit(userId: string) {
  const [existing] = await db
    .select()
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (existing) return existing;
  // Migrate the legacy Gemini-only row in place so a saved API key / model /
  // voice survives the rename to the unified "Voice" addon (#26).
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
// install speaks without any UI config (bootstrap). Gemini Live model/voice
// keep their previous defaults.
const DEFAULT_PROVIDER: VoiceProvider = "local";
const DEFAULT_TTS_ENDPOINT = process.env.TTS_BASE_URL ?? "";
const DEFAULT_TTS_MODEL =
  process.env.TTS_DEFAULT_MODEL ?? "mlx-community/VibeVoice-Realtime-0.5B-8bit";
const DEFAULT_TTS_VOICE = process.env.TTS_DEFAULT_VOICE ?? "en-Emma_woman";
// Gemini 3.1 Flash Live (preview) — native speech↔speech, 70+ languages.
const DEFAULT_MODEL = "models/gemini-3.1-flash-live-preview";
const DEFAULT_VOICE = "Aoede";

voiceLiveRoute.get("/info", async (c) => {
  const userId = c.get("userId");
  const addon = await findOrInit(userId);
  const cfg = (addon.config ?? {}) as Config;
  const provider = cfg.provider ?? DEFAULT_PROVIDER;
  // `voice` is one field shared across providers; its sensible default depends
  // on which provider is active (Gemini voice namespace vs VibeVoice/Voxtral).
  const voiceDefault = provider === "gemini" ? DEFAULT_VOICE : DEFAULT_TTS_VOICE;
  return c.json({
    addonId: addon.id,
    enabled: addon.enabled,
    provider,
    ttsEndpoint: cfg.ttsEndpoint ?? DEFAULT_TTS_ENDPOINT,
    asrEndpoint: cfg.asrEndpoint ?? cfg.ttsEndpoint ?? DEFAULT_TTS_ENDPOINT,
    ttsModel: cfg.ttsModel ?? DEFAULT_TTS_MODEL,
    voice: cfg.voice ?? voiceDefault,
    hasApiKey: Boolean(cfg.apiKey),
    model: cfg.model ?? DEFAULT_MODEL,
    systemInstruction: cfg.systemInstruction ?? "",
  });
});

const configSchema = z.object({
  provider: z.enum(["local", "gemini", "mistral"]).optional(),
  ttsEndpoint: z.string().max(500).optional(),
  asrEndpoint: z.string().max(500).optional(),
  ttsModel: z.string().max(200).optional(),
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
  if (data.provider !== undefined) cfg.provider = data.provider;
  if (data.ttsEndpoint !== undefined) cfg.ttsEndpoint = data.ttsEndpoint;
  if (data.asrEndpoint !== undefined) cfg.asrEndpoint = data.asrEndpoint;
  if (data.ttsModel !== undefined) cfg.ttsModel = data.ttsModel;
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
const sessionSchema = z.object({
  /** Optional — when present, the conversation's frozen memorySnapshot is
   *  used (kept stable across turns); otherwise we fetch a fresh one. */
  conversationId: z.string().uuid().optional(),
});

voiceLiveRoute.post(
  "/session",
  zValidator("json", sessionSchema.optional() as never),
  async (c) => {
    const userId = c.get("userId");
    const addon = await findOrInit(userId);
    if (!addon.enabled) return c.json({ error: "addon_disabled" }, 400);
    const cfg = (addon.config ?? {}) as Config;
    if (!cfg.apiKey) return c.json({ error: "missing_api_key" }, 400);

    // Accept an optional body via either zValidator or raw json (the body
    // can legitimately be empty for a session without a conversation).
    let conversationId: string | undefined;
    try {
      const raw = await c.req.json().catch(() => null);
      if (raw && typeof raw.conversationId === "string") {
        conversationId = raw.conversationId;
      }
    } catch {
      // ignore
    }

    // Pull memory context — prefer the per-conversation snapshot for
    // byte-stability across turns, fall back to a live fetch when there
    // is no conversation yet (e.g. quick voice probe from the chat input).
    let memory = "";
    if (conversationId) {
      const [conv] = await db
        .select({
          memorySnapshot: conversations.memorySnapshot,
          memoryEnabled: conversations.memoryEnabled,
          projectId: conversations.projectId,
          userId: conversations.userId,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (conv && conv.userId === userId && conv.memoryEnabled) {
        memory = conv.memorySnapshot ?? "";
        if (!memory) {
          memory = await getMemoryContext(userId, conv.projectId ?? null);
        }
      }
    } else {
      memory = await getMemoryContext(userId, null);
    }

    const userInstr = cfg.systemInstruction ?? "";
    // Compose the system instruction: memory first (so the model has full
    // context before any persona override), then the user's saved
    // instruction. Empty sections are skipped — no awkward dangling headers.
    const parts: string[] = [];
    if (memory.trim()) {
      parts.push(`# Memory about the user\n\n${memory.trim()}`);
    }
    if (userInstr.trim()) {
      parts.push(userInstr.trim());
    }
    const systemInstruction = parts.join("\n\n---\n\n");

    return c.json({
      apiKey: cfg.apiKey, // TODO v0.3: replace with ephemeral access_token
      model: cfg.model ?? DEFAULT_MODEL,
      voice: cfg.voice ?? DEFAULT_VOICE,
      systemInstruction,
      wsUrl:
        "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
    });
  },
);

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
    // mistral/Voxtral (and any hosted OpenAI-compat endpoint) needs a Bearer
    // key; local mlx-audio doesn't. Server-side only — never sent to the client.
    apiKey: cfg.apiKey,
  };
}

export default voiceLiveRoute;
