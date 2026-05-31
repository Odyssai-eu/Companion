import { and, asc, eq, sql } from "drizzle-orm";
import { hashPassword } from "../auth/password";
import { db } from "./index";
import { users } from "./schema";

/**
 * Default credentials for the seeded admin user on a fresh install.
 *
 * On an empty DB, the first boot creates this admin user with a DOCUMENTED
 * generic default password ("itak1234"). It's known, it's in the docs, and
 * the operator is expected to change it on first login (Settings → Profile)
 * — the same pattern self-hosted products ship with. A known default the
 * operator can log in with immediately beats a per-install random they'd
 * have to dig out of the logs (deliberate product decision 2026-05-31).
 * Override via `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` env vars.
 *
 * The seed runs ONCE on an empty DB. After it lands, future boots skip the
 * seed regardless of these constants — existing deploys are never affected.
 */
const SEED_ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL || "admin@odyssai.local").toLowerCase();
const SEED_ADMIN_NAME = process.env.SEED_ADMIN_NAME || "Admin";
const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || "itak1234";

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
    console.log(
      `→ seeded admin '${SEED_ADMIN_EMAIL}'. ` +
        `Using the documented default password — change it on first login ` +
        `(Settings → Profile).`,
    );
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
