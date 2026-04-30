/**
 * Guest auth middleware — parallel to `requireUser` for token-based
 * (revocable, budgeted, expiring) access.
 *
 * Auth sources, in priority order:
 *   1. `Authorization: Bearer g_<…>` header
 *   2. `?g=<token>` query param (used by the public /g/<token> URL)
 *   3. `tcg` cookie (set client-side after the first hit)
 *
 * On a valid token, sets:
 *   - c.set('guest', GuestTokenContext)
 *   - c.set('userId', guest.createdBy) — IMPORTANT: a guest acts on behalf
 *     of the admin who minted them. All existing user-scoped handlers
 *     (models, conversations, memory) read `userId` from the context, so
 *     populating it with the inviter's id makes the guest see the inviter's
 *     world without any handler changes. The `guest` variable is the
 *     escape hatch for handlers that must distinguish (chat budget, audit).
 */

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import {
  GUEST_TOKEN_PREFIX,
  type GuestTokenContext,
  validateGuestToken,
} from "../lib/guest-token";

export const GUEST_COOKIE = "tcg";

declare module "hono" {
  interface ContextVariableMap {
    guest: GuestTokenContext;
  }
}

function extractGuestToken(c: Parameters<MiddlewareHandler>[0]): string | null {
  const auth = c.req.header("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (m && m[1].startsWith(GUEST_TOKEN_PREFIX)) return m[1];
  }
  const q = c.req.query("g");
  if (q && q.startsWith(GUEST_TOKEN_PREFIX)) return q;
  const cookie = getCookie(c, GUEST_COOKIE);
  if (cookie && cookie.startsWith(GUEST_TOKEN_PREFIX)) return cookie;
  return null;
}

/**
 * Resolve a guest token if present. Silent on missing / invalid — downstream
 * code (requireUserOrGuest) decides whether to 401. Does NOT clobber an
 * already-set `userId` from the regular session loader.
 */
export const guestSessionLoader: MiddlewareHandler = async (c, next) => {
  // Regular session beats guest. If a real user is already authed, ignore
  // any guest token on the request — keeps audit trails clean.
  if (c.get("userId")) {
    await next();
    return;
  }
  const token = extractGuestToken(c);
  if (token) {
    const ctx = await validateGuestToken(token);
    if (ctx) {
      c.set("guest", ctx);
      c.set("userId", ctx.createdBy);
    }
  }
  await next();
};

/**
 * Pass when the request has a real session OR a valid guest token. Otherwise
 * 401. Note `userId` is set by both paths (guest's `userId` is the inviting
 * admin), so handlers that scope by user keep working as-is.
 */
export const requireUserOrGuest: MiddlewareHandler = async (c, next) => {
  if (!c.get("userId") && !c.get("guest")) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  await next();
};
