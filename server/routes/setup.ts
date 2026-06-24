/**
 * First-run setup routes.
 *
 * GET  /api/setup/status   → { needed: boolean }
 * POST /api/setup/init     → create the operator admin account
 *
 * /api/setup/* is intentionally unauthenticated so a fresh install can
 * bootstrap itself. The `init` endpoint is a one-shot: it 409s if any
 * user already exists, so it can't be used as a backdoor on a live install.
 */
import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { setCookie } from "hono/cookie";
import { createSessionToken } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { db } from "../db/index";
import { logAuthEvent } from "../lib/auth-log";
import { resolveCookieSecure } from "../lib/cookie-secure";
import { users } from "../db/schema";
import { SESSION_COOKIE } from "../middleware/auth";

// Same resolution as auth.ts — see server/lib/cookie-secure.ts. setup.ts
// previously hard-coded NODE_ENV (no override at all), so a fresh install on
// plain-HTTP LAN broke the operator's very first login.
const COOKIE_SECURE = resolveCookieSecure();

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
}

export const setupRoute = new Hono();

// ── GET /api/setup/status ─────────────────────────────────────────────────

setupRoute.get("/status", async (c) => {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  return c.json({ needed: count === 0 });
});

// ── POST /api/setup/init ──────────────────────────────────────────────────

const initSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
});

setupRoute.post("/init", zValidator("json", initSchema), async (c) => {
  // Guard: only runs on an empty DB.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);

  if (count > 0) {
    return c.json(
      {
        error: "already_initialized",
        detail:
          "This install already has users. Use Settings → Admin to add accounts.",
      },
      409,
    );
  }

  const { name, email, password } = c.req.valid("json");
  const normalized = email.toLowerCase().trim();
  const passwordHash = await hashPassword(password);
  const now = new Date();

  const [user] = await db
    .insert(users)
    .values({
      name,
      email: normalized,
      passwordHash,
      passwordChangedAt: now,
      role: "admin" as const,
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      passwordChangedAt: users.passwordChangedAt,
    });

  console.log(`→ setup: operator account created for ${normalized}`);
  logAuthEvent({ userId: user.id, event: "setup.init", meta: { email: normalized } });

  const token = await createSessionToken(
    { userId: user.id, email: user.email },
    user.passwordChangedAt ?? now,
  );
  setSessionCookie(c, token);

  return c.json({ ok: true, user: { id: user.id, email: user.email, name: user.name } }, 201);
});
