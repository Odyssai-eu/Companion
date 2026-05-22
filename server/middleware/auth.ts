import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifySessionToken } from "../auth/jwt";
import { db } from "../db/index";
import { users } from "../db/schema";

export const SESSION_COOKIE = "companion_session";

export type Role = "admin" | "organiser" | "user" | "guest";

export interface UserContext {
  id: string;
  role: Role;
  active: boolean;
}

declare module "hono" {
  interface ContextVariableMap {
    userId: string;
    userEmail: string;
    user: UserContext;
  }
}

/**
 * Populate c.get('userId') if the request has a valid session cookie.
 * Silent on invalid / missing — downstream middleware decides whether to 401.
 */
export const sessionLoader: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await verifySessionToken(token);
    if (session) {
      c.set("userId", session.userId);
      c.set("userEmail", session.email);
    }
  }
  await next();
};

/**
 * Require an authenticated user. Returns 401 with { error: 'unauthenticated' }
 * if no session. Does NOT run for dev-mode bypass — the license gate handles
 * that separately.
 */
export const requireUser: MiddlewareHandler = async (c, next) => {
  if (!c.get("userId")) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  await next();
};

/**
 * Require the authenticated user to have one of the given roles AND be active.
 * Loads the user row, sets c.set('user', { id, role, active }), 403s otherwise.
 *
 * Must run after `requireUser`.
 */
export function requireRole(...roles: Role[]): MiddlewareHandler {
  return async (c, next) => {
    const userId = c.get("userId");
    if (!userId) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    const [row] = await db
      .select({
        id: users.id,
        role: users.role,
        active: users.active,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row || !row.active) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!roles.includes(row.role as Role)) {
      return c.json({ error: "forbidden" }, 403);
    }
    c.set("user", {
      id: row.id,
      role: row.role as Role,
      active: row.active,
    });
    await next();
  };
}

export function userIdFrom(c: Context): string {
  const id = c.get("userId");
  if (!id) throw new Error("no authenticated user on this request");
  return id;
}
