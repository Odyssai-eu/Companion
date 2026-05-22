/**
 * Hermes tokens — scoped service credentials issued to the Hermes Agent
 * (auto-minted per Hermes conv) and Cowork dispatch (manually minted by
 * the user). Used as Bearer auth by the companion-mcp MCP server when it
 * calls back into Companion on behalf of the user.
 *
 * Mint flow:
 *   1. Companion calls `mintHermesToken(userId, …)`. We generate a random
 *      `hms_<base64url>` token, sha256 it, store the hash; the plain token
 *      is returned ONCE.
 *   2. The token is transmitted to the MCP server (env var on launch).
 *   3. MCP hits Companion routes with `Authorization: Bearer hms_<…>`.
 *      `hermesBearerLoader` middleware hashes the header, looks up the row,
 *      sets `userId` on the request context.
 *
 * Scope is per-user (large): the token can act on any conv / project owned
 * by the user. `convId` is metadata for audit only.
 */

import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index";
import { hermesTokens, type HermesToken } from "../db/schema";

export const HERMES_TOKEN_PREFIX = "hms_";

export interface HermesTokenContext {
  id: string;
  userId: string;
  source: "hermes" | "cowork";
  expiresAt: Date | null;
}

export interface MintOpts {
  userId: string;
  label?: string | null;
  convId?: string | null;
  source?: "hermes" | "cowork";
  ttlMs?: number | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a new hermes token. The plain token is returned ONCE — only the
 * sha256 is persisted. Caller must forward the plain token to the consumer
 * (env var to the MCP server, or display to the user for manual config).
 */
export async function mintHermesToken(
  opts: MintOpts,
): Promise<{ token: string; row: HermesToken }> {
  const token = HERMES_TOKEN_PREFIX + randomBytes(24).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt =
    opts.ttlMs && opts.ttlMs > 0 ? new Date(Date.now() + opts.ttlMs) : null;

  const [row] = await db
    .insert(hermesTokens)
    .values({
      userId: opts.userId,
      tokenHash,
      label: opts.label ?? null,
      convId: opts.convId ?? null,
      source: opts.source ?? "hermes",
      expiresAt,
    })
    .returning();

  return { token, row };
}

/**
 * Look up a hermes token by its plain text. Returns null when the token
 * is unknown, revoked, or expired. On hit, bumps `last_used_at` (best
 * effort — failure to bump doesn't fail the auth).
 */
export async function validateHermesToken(
  token: string,
): Promise<HermesTokenContext | null> {
  if (!token || !token.startsWith(HERMES_TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);

  const [row] = await db
    .select({
      id: hermesTokens.id,
      userId: hermesTokens.userId,
      source: hermesTokens.source,
      expiresAt: hermesTokens.expiresAt,
      revokedAt: hermesTokens.revokedAt,
    })
    .from(hermesTokens)
    .where(eq(hermesTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

  void db
    .update(hermesTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(hermesTokens.id, row.id))
    .catch(() => {});

  return {
    id: row.id,
    userId: row.userId,
    source: row.source as "hermes" | "cowork",
    expiresAt: row.expiresAt,
  };
}

/**
 * Soft-delete a hermes token. Verifies the caller owns the token.
 */
export async function revokeHermesToken(
  id: string,
  byUserId: string,
): Promise<{ ok: boolean }> {
  const result = await db
    .update(hermesTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(hermesTokens.id, id), eq(hermesTokens.userId, byUserId)))
    .returning({ id: hermesTokens.id });
  return { ok: result.length > 0 };
}

/**
 * List the user's active (non-revoked) tokens. Hash is never returned.
 */
export async function listHermesTokens(userId: string) {
  return db
    .select({
      id: hermesTokens.id,
      label: hermesTokens.label,
      convId: hermesTokens.convId,
      source: hermesTokens.source,
      expiresAt: hermesTokens.expiresAt,
      revokedAt: hermesTokens.revokedAt,
      lastUsedAt: hermesTokens.lastUsedAt,
      createdAt: hermesTokens.createdAt,
    })
    .from(hermesTokens)
    .where(eq(hermesTokens.userId, userId))
    .orderBy(sql`${hermesTokens.createdAt} DESC`);
}
