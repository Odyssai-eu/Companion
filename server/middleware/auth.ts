import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifySessionToken } from "../auth/jwt";

export const SESSION_COOKIE = "thecompai_session";

declare module "hono" {
  interface ContextVariableMap {
    userId: string;
    userEmail: string;
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

export function userIdFrom(c: Context): string {
  const id = c.get("userId");
  if (!id) throw new Error("no authenticated user on this request");
  return id;
}
