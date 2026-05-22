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
  // The user MUST change the password in Settings → Profile after first
  // login. The default below satisfies the 8-char minimum the signup
  // schema enforces (so a later user-side password reset still validates
  // against the same rule).
  const seededEmail = process.env.DEV_SEED_EMAIL ?? "admin@example.local";
  const seededPassword = process.env.DEV_SEED_PASSWORD ?? "change-me-now";
  const passwordHash = await hashPassword(seededPassword);
  const [devUser] = await db
    .insert(users)
    .values({
      email: seededEmail,
      name: process.env.DEV_SEED_NAME ?? "Operator",
      passwordHash,
      litellmUrl: process.env.LITELLM_URL ?? null,
      timezone: process.env.DEV_SEED_TIMEZONE ?? "UTC",
    })
    .returning();

  console.log(
    `→ seeded first-boot account: ${seededEmail} / ${seededPassword} — ` +
      "CHANGE THIS in Settings → Profile.",
  );

  // Seeded add-on rows. The current Hermes Agent integration (`/hermes`
  // slash command + ACP bridge) is configured per-user from
  // Settings → Add-ons; nothing to seed here. Voice Mode is reserved for
  // when the Gemini Live add-on ships — seeded disabled so the row
  // exists in the UI.
  await db.insert(addons).values([
    {
      userId: devUser.id,
      name: "Voice Mode",
      kind: "plugin",
      description:
        "Reserved for Voice Mode (Gemini Flash Live as TTS). On the roadmap; disabled until the add-on ships.",
      version: "0.0.1",
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
