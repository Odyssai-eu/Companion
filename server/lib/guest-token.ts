/**
 * Guest tokens — token-based, revocable, expiring credentials with a
 * per-token LLM-token budget.
 *
 * Mint flow:
 *   1. Admin (or organiser) calls mintGuestToken — we generate a random
 *      `g_<base64url>` token, sha256 it, store the hash; the plain token
 *      is returned ONCE for the admin to share.
 *   2. The guest hits any chat-capable route with the token (Bearer header,
 *      `?g=...` query param, or `tcg` cookie). validateGuestToken hashes
 *      it and looks up the row.
 *   3. After streaming completes, incrementGuestUsage(tokenId, completion)
 *      atomically advances tokensUsed and tells us if the budget is now
 *      exhausted.
 *
 * IMPORTANT: a guest acts on behalf of the admin who minted them. Their
 * effective `userId` is `createdBy`, so all existing user-scoped handlers
 * (models, conversations, memory wiki) work unchanged. The middleware in
 * `server/middleware/guest.ts` is what wires this up.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { guestTokens, type GuestToken } from "../db/schema";

export const GUEST_TOKEN_PREFIX = "g_";

export interface GuestTokenContext {
  id: string;
  createdBy: string;
  scope: string;
  tokenBudget: number;
  tokensUsed: number;
  expiresAt: Date | null;
}

export interface MintOpts {
  createdBy: string;
  label?: string | null;
  tokenBudget: number;
  scope?: string;
  expiresAt?: Date | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a new guest token. The plain token is returned ONCE — only the
 * sha256 is persisted. Caller must show the plain token to the admin and
 * never store it again.
 */
export async function mintGuestToken(
  opts: MintOpts,
): Promise<{ token: string; row: GuestToken }> {
  const token = GUEST_TOKEN_PREFIX + randomBytes(24).toString("base64url");
  const tokenHash = hashToken(token);

  const [row] = await db
    .insert(guestTokens)
    .values({
      createdBy: opts.createdBy,
      tokenHash,
      label: opts.label ?? null,
      tokenBudget: opts.tokenBudget,
      scope: opts.scope ?? "chat",
      expiresAt: opts.expiresAt ?? null,
    })
    .returning();

  return { token, row };
}

/**
 * Look up a guest token by its plain text. Returns null when the token
 * is unknown, revoked, expired, or budget-exhausted (non-zero budget and
 * tokensUsed >= tokenBudget). 0 budget means unlimited.
 */
export async function validateGuestToken(
  token: string,
): Promise<GuestTokenContext | null> {
  if (!token || !token.startsWith(GUEST_TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);

  const [row] = await db
    .select({
      id: guestTokens.id,
      createdBy: guestTokens.createdBy,
      scope: guestTokens.scope,
      tokenBudget: guestTokens.tokenBudget,
      tokensUsed: guestTokens.tokensUsed,
      expiresAt: guestTokens.expiresAt,
      revokedAt: guestTokens.revokedAt,
    })
    .from(guestTokens)
    .where(eq(guestTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  if (row.tokenBudget > 0 && row.tokensUsed >= row.tokenBudget) return null;

  return {
    id: row.id,
    createdBy: row.createdBy,
    scope: row.scope,
    tokenBudget: row.tokenBudget,
    tokensUsed: row.tokensUsed,
    expiresAt: row.expiresAt,
  };
}

/**
 * Atomically add `completionTokens` to tokens_used. Returns whether the
 * token is now over its budget (when budget > 0). Negative / zero deltas
 * are coerced to 0.
 */
export async function incrementGuestUsage(
  tokenId: string,
  completionTokens: number,
): Promise<{ overBudget: boolean }> {
  const delta = Math.max(0, Math.floor(completionTokens || 0));

  const [row] = await db
    .update(guestTokens)
    .set({
      tokensUsed: sql`${guestTokens.tokensUsed} + ${delta}`,
    })
    .where(eq(guestTokens.id, tokenId))
    .returning({
      tokenBudget: guestTokens.tokenBudget,
      tokensUsed: guestTokens.tokensUsed,
    });

  if (!row) return { overBudget: false };
  const overBudget = row.tokenBudget > 0 && row.tokensUsed >= row.tokenBudget;
  return { overBudget };
}

/**
 * Soft-delete a guest token by setting revoked_at = now(). The row is
 * preserved so the usage history (tokens_used, label) survives audit.
 * Verifies the caller owns the token.
 */
export async function revokeGuestToken(
  id: string,
  byUserId: string,
): Promise<{ ok: boolean }> {
  const result = await db
    .update(guestTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(guestTokens.id, id), eq(guestTokens.createdBy, byUserId)))
    .returning({ id: guestTokens.id });
  return { ok: result.length > 0 };
}

/**
 * Push expires_at forward by `days` days. If the token has no expiry yet,
 * the new value is now + days. Returns the updated row (without hash) or
 * null when not owned / not found.
 */
export async function extendGuestToken(
  id: string,
  byUserId: string,
  days: number,
): Promise<GuestToken | null> {
  const [current] = await db
    .select()
    .from(guestTokens)
    .where(and(eq(guestTokens.id, id), eq(guestTokens.createdBy, byUserId)))
    .limit(1);
  if (!current) return null;

  const base = current.expiresAt ?? new Date();
  const newExpiry = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  const [row] = await db
    .update(guestTokens)
    .set({ expiresAt: newExpiry })
    .where(eq(guestTokens.id, id))
    .returning();
  return row ?? null;
}

/**
 * Strip `tokenHash` from a guest token row before returning it to API
 * consumers. The hash never leaves the server.
 */
export function publicGuestToken(row: GuestToken) {
  return {
    id: row.id,
    label: row.label,
    tokenBudget: row.tokenBudget,
    tokensUsed: row.tokensUsed,
    scope: row.scope,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}
