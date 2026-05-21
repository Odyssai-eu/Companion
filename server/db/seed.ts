import { and, asc, eq, sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { db } from "./index";
import { addons, users } from "./schema";

/**
 * Seed dev data on an empty DB. Idempotent — checks if users table is empty
 * before inserting. Safe to call on every startup.
 *
 * v0.1.0 — no more servers/endpoints seed. Inference is now via LiteLLM,
 * configured per-user in Settings → Inference (or via the LITELLM_URL env
 * default). The default URL points at the operator's LiteLLM proxy.
 */
export async function seedIfEmpty() {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);

  if (count > 0) return;

  console.log("→ seeding empty DB with dev data");

  // Dev account — seeded only on an empty DB. Email + name + LiteLLM URL
  // can be overridden via env vars; otherwise generic dev defaults land.
  // The user can change all of these in Settings after first login.
  const passwordHash = await hashPassword(
    process.env.DEV_SEED_PASSWORD ?? "dev",
  );
  const [devUser] = await db
    .insert(users)
    .values({
      email: process.env.DEV_SEED_EMAIL ?? "dev@example.local",
      name: process.env.DEV_SEED_NAME ?? "Dev user",
      passwordHash,
      litellmUrl: process.env.LITELLM_URL ?? null,
      timezone: process.env.DEV_SEED_TIMEZONE ?? "UTC",
    })
    .returning();

  // Add-ons that remain after the cleanup pass:
  //   - Voice Mode             — kept for the upcoming voice refactor
  //   - Voice (Gemini Live)    — kept until the voice refactor lands
  // Migrated to MCP servers (dropped by migration 0036):
  //   - Notion, Obsidian, Web Search
  // Retired earlier:
  //   - Audiobook       (migration 0035)
  //   - Hermes Agent    (migration 0037, 2026-05-19) — disconnected from
  //                     Companion; the gateway CLI on .50 lives on as a
  //                     standalone tool.
  await db.insert(addons).values([
    {
      userId: devUser.id,
      name: "Voice Mode",
      kind: "plugin",
      description:
        "Full-duplex audio via VibeVoice-Realtime. EN only for now; falls back to Voxtral batch when the realtime service is down.",
      version: "0.3.2",
      enabled: false,
    },
    {
      userId: devUser.id,
      name: "Voice (Gemini Live)",
      kind: "plugin",
      description:
        "Real-time bidirectional voice via Gemini Live API. PCM streaming over WebSocket. Replaces local TTS/ASR pipelines while Voxtral/Kokoro mature.",
      version: "0.1.0",
      enabled: false,
    },
  ]);

  console.log("→ seed complete");
}

/**
 * Promote the oldest active user to admin if no active admin exists.
 * Runs on every startup; idempotent.
 */
export async function ensureAdminExists() {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.role, "admin"), eq(users.active, true)));

  if (count > 0) return;

  const [oldest] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.active, true))
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (!oldest) {
    // No users at all (yet). Nothing to do — seedIfEmpty handles the dev case.
    return;
  }

  await db
    .update(users)
    .set({ role: "admin" })
    .where(eq(users.id, oldest.id));

  console.log(`→ promoted ${oldest.email} to admin (no admin existed)`);
}
