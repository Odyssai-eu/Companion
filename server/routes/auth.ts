import { zValidator } from "@hono/zod-validator";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { createSessionToken } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { db } from "../db/index";
import { users } from "../db/schema";
import { logAuthEvent, reqMeta } from "../lib/auth-log";
import { SESSION_COOKIE } from "../middleware/auth";

const authRoute = new Hono();

const signupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "Lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

authRoute.post("/signup", zValidator("json", signupSchema), async (c) => {
  // Signup is gated except on a fresh install: the very first user who
  // signs up on an empty DB becomes the operator (role=admin). After
  // that, /api/auth/signup is closed unless ALLOW_SIGNUP=1.
  //
  // This avoids the docker-logs password fishing of the seed approach —
  // the user just opens http://<host>:3000/, sees "Create your operator
  // account", and registers normally.
  const [{ count: userCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  const isBootstrap = userCount === 0;

  if (!isBootstrap && process.env.ALLOW_SIGNUP !== "1") {
    return c.json(
      {
        error: "signup_disabled",
        detail:
          "Public sign-up is disabled on this install. Ask the operator " +
          "to add your account, or set ALLOW_SIGNUP=1 to enable self-serve.",
      },
      403,
    );
  }

  const { email, password, name } = c.req.valid("json");
  const normalized = email.toLowerCase().trim();

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);
  if (existing) {
    return c.json(
      { error: "email_taken", detail: "Email is already registered." },
      409,
    );
  }

  const passwordHash = await hashPassword(password);
  const [user] = await db
    .insert(users)
    .values({
      email: normalized,
      name,
      passwordHash,
      // First user on an empty DB becomes the operator (admin).
      ...(isBootstrap ? { role: "admin" as const } : {}),
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      active: users.active,
    });

  if (isBootstrap) {
    console.log(
      `→ first-boot signup: promoted ${normalized} to admin (no operator existed).`,
    );
  }

  const token = await createSessionToken({
    userId: user.id,
    email: user.email,
  });
  setSessionCookie(c, token);

  return c.json({ user }, 201);
});

authRoute.post("/login", zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const normalized = email.toLowerCase().trim();

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);

  // Fake a hash compare on non-existent users to avoid email-enumeration timing.
  const hashForCompare =
    user?.passwordHash ??
    "$2a$10$CwTycUXWue0Thq9StjUM0uJ8gZ4m1C0Zn5e1bIdV5C5yJ3g5wLn6u"; // placeholder

  const ok = await verifyPassword(password, hashForCompare);
  const meta = reqMeta(c);
  if (!user || !ok) {
    logAuthEvent({
      userId: user?.id ?? null,
      event: "login.fail",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { email_attempted: normalized },
    });
    return c.json(
      { error: "invalid_credentials", detail: "Wrong email or password." },
      401,
    );
  }

  if (!user.active) {
    logAuthEvent({
      userId: user.id,
      event: "login.fail",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { email_attempted: normalized, reason: "inactive" },
    });
    return c.json(
      { error: "invalid_credentials", detail: "Wrong email or password." },
      401,
    );
  }

  const token = await createSessionToken({
    userId: user.id,
    email: user.email,
  });
  setSessionCookie(c, token);

  logAuthEvent({
    userId: user.id,
    event: "login.success",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { method: "password" },
  });

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      active: user.active,
    },
  });
});

authRoute.post("/logout", (c) => {
  const userId = c.get("userId");
  const meta = reqMeta(c);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  if (userId) {
    logAuthEvent({
      userId,
      event: "logout",
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  }
  return c.body(null, 204);
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});

authRoute.post(
  "/change-password",
  zValidator("json", changePasswordSchema),
  async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "unauthenticated" }, 401);
    const { currentPassword, newPassword } = c.req.valid("json");

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || !user.passwordHash) {
      return c.json({ error: "unauthenticated" }, 401);
    }

    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) {
      return c.json(
        { error: "invalid_current_password" },
        401,
      );
    }

    const newHash = await hashPassword(newPassword);
    await db
      .update(users)
      .set({ passwordHash: newHash })
      .where(eq(users.id, userId));

    const meta = reqMeta(c);
    logAuthEvent({
      userId,
      event: "password.change",
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return c.json({ ok: true });
  },
);

const updateProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
});

authRoute.patch(
  "/me",
  zValidator("json", updateProfileSchema),
  async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "unauthenticated" }, 401);
    const data = c.req.valid("json");
    const [updated] = await db
      .update(users)
      .set({ name: data.name })
      .where(eq(users.id, userId))
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        active: users.active,
      });
    return c.json({ user: updated });
  },
);

authRoute.get("/me", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ user: null });
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      active: users.active,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return c.json({ user: user ?? null });
});

export default authRoute;
