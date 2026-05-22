import { randomBytes } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { db } from "./index";
import { addons, users } from "./schema";

/**
 * Seed first-boot data on an empty DB. Idempotent — checks if the users
 * table is empty before inserting. Safe to call on every startup.
 *
 * One operator account lands with a *randomly-generated* password,
 * printed to stdout once. Override via env (`DEV_SEED_EMAIL`,
 * `DEV_SEED_PASSWORD`, …) for scripted installs.
 */
export async function seedIfEmpty() {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);

  if (count > 0) return;

  console.log("→ seeding empty DB with first-boot data");

  // First-boot account. Email + name + LiteLLM URL can be overridden
  // via env vars; otherwise generic defaults land. The user MUST change
  // the password in Settings → Profile after first login.
  //
  // Password: env wins, otherwise we generate a random one and print it
  // ONCE to stdout. We deliberately don't ship a deterministic default —
  // a public install with `admin@example.local / change-me-now` would
  // be a credential everyone on the internet knows.
  const seededEmail = process.env.DEV_SEED_EMAIL ?? "admin@example.local";
  const seededPassword =
    process.env.DEV_SEED_PASSWORD ?? randomBytes(12).toString("base64url");
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
    "\n────────────────────────────────────────────────────────────────\n" +
      `  Companion first-boot account\n` +
      `    email    : ${seededEmail}\n` +
      `    password : ${seededPassword}\n` +
      "  CHANGE the password in Settings → Profile after first login.\n" +
      "  This is the only time the password is printed — copy it now.\n" +
      "────────────────────────────────────────────────────────────────\n",
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
