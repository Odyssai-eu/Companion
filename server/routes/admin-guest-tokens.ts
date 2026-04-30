/**
 * /api/admin/guest-tokens — CRUD over the calling admin's own guest tokens.
 *
 * The plain token is shown ONLY in the response to POST /. Subsequent reads
 * never include the hash or the original token.
 */

import { zValidator } from "@hono/zod-validator";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index";
import { guestTokens } from "../db/schema";
import { logAuthEvent, reqMeta } from "../lib/auth-log";
import {
  extendGuestToken,
  mintGuestToken,
  publicGuestToken,
  revokeGuestToken,
} from "../lib/guest-token";
import { requireRole } from "../middleware/auth";

const adminGuestTokensRoute = new Hono();

// Admins and organisers can mint guest tokens for their own circle.
adminGuestTokensRoute.use("*", requireRole("admin", "organiser"));

const mintSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  // 0 = unlimited. Default chosen to be enough for a casual demo session.
  tokenBudget: z.number().int().min(0).max(10_000_000).optional(),
  scope: z.enum(["chat"]).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

const extendSchema = z.object({
  days: z.number().int().min(1).max(365),
});

// GET / — list the caller's own tokens (no hash, no plain token).
adminGuestTokensRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const rows = await db
    .select()
    .from(guestTokens)
    .where(eq(guestTokens.createdBy, userId))
    .orderBy(desc(guestTokens.createdAt));
  return c.json({ tokens: rows.map(publicGuestToken) });
});

// POST / — mint. Plain token returned ONCE.
adminGuestTokensRoute.post("/", zValidator("json", mintSchema), async (c) => {
  const userId = c.get("userId");
  const body = c.req.valid("json");
  const meta = reqMeta(c);

  const tokenBudget = body.tokenBudget ?? 50_000;
  const expiresInDays = body.expiresInDays ?? 7;
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const { token, row } = await mintGuestToken({
    createdBy: userId,
    label: body.label ?? null,
    tokenBudget,
    scope: body.scope ?? "chat",
    expiresAt,
  });

  logAuthEvent({
    userId,
    event: "guest.mint",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: {
      tokenId: row.id,
      label: row.label,
      tokenBudget: row.tokenBudget,
      scope: row.scope,
      expiresAt: row.expiresAt?.toISOString() ?? null,
    },
  });

  return c.json({ token, row: publicGuestToken(row) }, 201);
});

// DELETE /:id — revoke (soft-delete; preserves usage history).
adminGuestTokensRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const meta = reqMeta(c);

  const { ok } = await revokeGuestToken(id, userId);
  if (!ok) return c.json({ error: "not_found" }, 404);

  logAuthEvent({
    userId,
    event: "guest.revoke",
    ip: meta.ip,
    userAgent: meta.userAgent,
    meta: { tokenId: id },
  });
  return c.json({ ok: true });
});

// POST /:id/extend — push expires_at forward by N days.
adminGuestTokensRoute.post(
  "/:id/extend",
  zValidator("json", extendSchema),
  async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");
    const { days } = c.req.valid("json");
    const meta = reqMeta(c);

    // Confirm the row exists AND belongs to the caller before extending.
    const [existing] = await db
      .select({ id: guestTokens.id })
      .from(guestTokens)
      .where(and(eq(guestTokens.id, id), eq(guestTokens.createdBy, userId)))
      .limit(1);
    if (!existing) return c.json({ error: "not_found" }, 404);

    const row = await extendGuestToken(id, userId, days);
    if (!row) return c.json({ error: "not_found" }, 404);

    logAuthEvent({
      userId,
      event: "guest.extend",
      ip: meta.ip,
      userAgent: meta.userAgent,
      meta: { tokenId: id, days, newExpiresAt: row.expiresAt?.toISOString() ?? null },
    });
    return c.json({ row: publicGuestToken(row) });
  },
);

export default adminGuestTokensRoute;
