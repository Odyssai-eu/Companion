import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "./index";
import { users } from "./schema";

/**
 * Seed first-boot data on an empty DB.
 *
 * We DO NOT auto-create a user any more — that path required fishing a
 * random password out of `docker logs`, which is friction nobody asked
 * for. Instead, the first visitor to /api/auth/signup (when the users
 * table is empty) is allowed through regardless of ALLOW_SIGNUP and
 * lands as `role=admin`. See server/routes/auth.ts.
 *
 * This hook is kept as a no-op placeholder so the existing call from
 * server/index.ts still resolves, and so future first-boot tasks
 * (default skills catalog, sample MCP servers, etc.) have a home.
 */
export async function seedIfEmpty() {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);

  if (count === 0) {
    console.log(
      "→ empty DB — first visitor to http://<host>:3000/ creates the " +
        "operator account (no seed user, no random password to copy from logs).",
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
