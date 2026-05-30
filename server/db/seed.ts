import { randomBytes } from "crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { db } from "./index";
import { users } from "./schema";

/**
 * Default credentials for the seeded admin user on a fresh install.
 *
 * On an empty DB, the first boot creates this user with `role=admin`.
 * Override via env vars `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.
 * When SEED_ADMIN_PASSWORD is unset a random password is generated and
 * printed ONCE to stdout — retrieve it from docker logs.
 *
 * The seed runs ONCE on an empty DB. After the seed lands, future
 * boots skip the seed regardless of these constants — existing
 * deploys are never affected.
 */
const SEED_ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@odyssai.local").toLowerCase();
const SEED_ADMIN_NAME = process.env.SEED_ADMIN_NAME || "Admin";
const _seedPasswordGenerated = !process.env.SEED_ADMIN_PASSWORD;
const SEED_ADMIN_PASSWORD =
  process.env.SEED_ADMIN_PASSWORD || randomBytes(12).toString("base64url");

/**
 * Seed first-boot data on an empty DB.
 *
 * On an empty users table : create the default admin so the operator
 * can log in immediately. After this lands once, the function becomes
 * a no-op on subsequent boots (idempotent guard on user count).
 */
export async function seedIfEmpty() {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);

  if (count > 0) return;

  try {
    const passwordHash = await hashPassword(SEED_ADMIN_PASSWORD);
    await db.insert(users).values({
      email: SEED_ADMIN_EMAIL,
      name: SEED_ADMIN_NAME,
      passwordHash,
      role: "admin" as const,
    });
    if (_seedPasswordGenerated) {
      console.log(
        `→ seeded admin '${SEED_ADMIN_EMAIL}'. ` +
          `Generated one-time password (shown once): ${SEED_ADMIN_PASSWORD} — ` +
          `change it in Settings → Profile.`,
      );
    } else {
      console.log(`→ seeded admin '${SEED_ADMIN_EMAIL}'. Using SEED_ADMIN_PASSWORD from env.`);
    }
  } catch (err) {
    console.warn(
      `→ seed admin failed: ${(err as Error).message}. ` +
        `You can still sign up via the UI (ALLOW_SIGNUP=1 OR empty DB allows bootstrap).`,
    );
  }
}

/**
 * Promote the oldest active user to admin if no active admin exists.
 * Runs on every startup; idempotent. Useful when an operator imports a
 * DB from somewhere else, or when the bootstrap signup happens before
 * this hook in a race (unlikely but cheap to defend against).
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
    // No users yet — the next /api/auth/signup will create one and
    // mark it admin. Nothing to do here.
    return;
  }

  await db
    .update(users)
    .set({ role: "admin" })
    .where(eq(users.id, oldest.id));

  console.log(`→ promoted ${oldest.email} to admin (no admin existed)`);
}
