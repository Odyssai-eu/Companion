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
 * default). The default URL points at Sophie's home cluster proxy.
 */
export async function seedIfEmpty() {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);

  if (count > 0) return;

  console.log("→ seeding empty DB with dev data");

  // Dev account — Sophie logs in with `dev` initially, can change via API.
  const passwordHash = await hashPassword("dev");
  const [sophie] = await db
    .insert(users)
    .values({
      email: "d.sophie27@gmail.com",
      name: "Sophie",
      passwordHash,
      // Personal default — falls back to env LITELLM_URL otherwise.
      litellmUrl: "http://192.168.86.44:4000",
      timezone: "Europe/Brussels",
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
      userId: sophie.id,
      name: "Voice Mode",
      kind: "plugin",
      description:
        "Full-duplex audio via VibeVoice-Realtime. EN only for now; falls back to Voxtral batch when the realtime service is down.",
      version: "0.3.2",
      enabled: false,
    },
    {
      userId: sophie.id,
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
