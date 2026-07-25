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
import {
  materializeUserAddon,
  pruneInheritedEchoes,
  readOwnAddonConfig,
  resolveKnownAddon,
} from "../lib/instance-rows";

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

/**
 * Rename any surviving "Voice (Gemini Live)" row of THIS USER in place, so
 * a saved endpoint / model / voice survives the rename to the unified
 * "Voice" add-on (#26).
 *
 * Two changes from the pre-0060 version, both load-bearing:
 *
 *  - it is scoped to the caller's own rows, `user_id = :userId`. Before,
 *    the same query with a nullable user_id could have matched the
 *    INSTANCE row and renamed the add-on for the entire deployment from a
 *    plain user's GET /info.
 *  - it no longer creates anything when there is no legacy row. Creation
 *    was the auto-provision bug; resolution handles the absence.
 *
 * Called ONLY from the two settings handlers, never from
 * `resolveVoiceConfig`. It used to sit inside findOrInit and therefore ran
 * on every TTS and ASR request; keeping it there would now cost an extra
 * SELECT per audio call forever, for every account that inherits the
 * add-on and has no legacy row to find. The values this rescues are only
 * visible and only editable in the panel, so migrating when the panel is
 * opened loses nothing.
 */
async function migrateLegacyVoiceRow(userId: string): Promise<void> {
  const [own] = await db
    .select({ id: addons.id })
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, ADDON_NAME)))
    .limit(1);
  if (own) return;
  const [legacy] = await db
    .select({ id: addons.id })
    .from(addons)
    .where(and(eq(addons.userId, userId), eq(addons.name, LEGACY_ADDON_NAME)))
    .limit(1);
  if (!legacy) return;
  await db
    .update(addons)
    .set({
      name: ADDON_NAME,
      description: ADDON_DESCRIPTION,
      updatedAt: new Date(),
    })
    .where(eq(addons.id, legacy.id));
}

/** Own row over instance row, key by key. Replaces findOrInit(): a pure
 *  read, one indexed query plus the cached instance list. */
async function loadVoiceAddon(userId: string) {
  return resolveKnownAddon(userId, ADDON_NAME);
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
  await migrateLegacyVoiceRow(userId);
  const addon = await loadVoiceAddon(userId);
  const cfg = addon.config as Config;
  const provider = cfg.provider ?? DEFAULT_PROVIDER;
  return c.json({
    addonId: addon.id,
    inherited: addon.inherited,
    inheritedConfigKeys: addon.inheritedConfigKeys,
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
  await migrateLegacyVoiceRow(userId);
  // Copy-on-write + delta write — see the note in addon-parser.ts.
  const ownId = await materializeUserAddon(userId, ADDON_NAME);
  const cfg = (await readOwnAddonConfig(userId, ADDON_NAME)) as Config;
  // Own keys before this request — see pruneInheritedEchoes.
  const before = { ...cfg } as Record<string, unknown>;
  const data = c.req.valid("json");
  if (data.provider !== undefined) cfg.provider = data.provider;
  if (data.ttsEndpoint !== undefined) cfg.ttsEndpoint = data.ttsEndpoint;
  if (data.asrEndpoint !== undefined) cfg.asrEndpoint = data.asrEndpoint;
  if (data.ttsModel !== undefined) cfg.ttsModel = data.ttsModel;
  if (data.voice !== undefined) cfg.voice = data.voice;
  await db
    .update(addons)
    .set({
      config: await pruneInheritedEchoes(
        ADDON_NAME,
        before,
        cfg as unknown as Record<string, unknown>,
      ),
      updatedAt: new Date(),
    })
    .where(eq(addons.id, ownId));
  return c.json({ ok: true });
});

/**
 * Resolve the user's effective voice config (provider + endpoints + model +
 * voice) with env bootstrap defaults. Consumed by the TTS/ASR proxy so the
 * endpoint is user-configurable instead of frozen on TTS_BASE_URL (#26).
 */
export async function resolveVoiceConfig(userId: string) {
  // Called from four handlers on the audio hot path (routes/tts.ts). Before
  // 0060 each of those was an implicit INSERT through findOrInit; it is a
  // single indexed read now, and the legacy-rename lookup that used to ride
  // along has moved to the settings handlers (see migrateLegacyVoiceRow).
  const addon = await loadVoiceAddon(userId);
  const cfg = addon.config as Config;
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
