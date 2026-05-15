/**
 * Hermes-token auth middleware — resolves the bearer token into a real
 * userId before `requireUser` runs. Used by external MCP clients (Cowork
 * dispatch, Hermes Agent, Claude Desktop, Continue.dev) to call back into
 * Companion on behalf of the user.
 *
 * Auth sources, in priority order:
 *   1. `Authorization: Bearer hms_<…>` header
 *   2. `?token=hms_<…>` query param — fallback for MCP clients whose UI
 *      doesn't expose a custom headers field (e.g. Claude Desktop's
 *      "Custom connector" dialog only accepts a URL).
 *
 * Mirrors the obsidian / guest bearer pattern: silent on missing/invalid
 * (downstream `requireUser` will 401 if no other auth resolved). Does NOT
 * clobber an already-set `userId` from the regular session loader — a
 * real browser session always wins.
 */

import type { MiddlewareHandler } from "hono";
import {
  HERMES_TOKEN_PREFIX,
  type HermesTokenContext,
  validateHermesToken,
} from "../lib/hermes-token";

declare module "hono" {
  interface ContextVariableMap {
    hermesToken: HermesTokenContext;
  }
}

function extractToken(c: Parameters<MiddlewareHandler>[0]): string | null {
  const auth = c.req.header("authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (m && m[1].startsWith(HERMES_TOKEN_PREFIX)) return m[1];
  }
  // Fallback: `?token=hms_…` query param. Used by MCP clients that don't
  // accept custom request headers (Claude Desktop custom connector dialog).
  // SECURITY NOTE: tokens passed in URLs appear in HTTP access logs and
  // Referer headers. Acceptable here because tokens are user-revocable
  // (Companion → Settings → External agents) and scoped to one user.
  const q = c.req.query("token");
  if (q && q.startsWith(HERMES_TOKEN_PREFIX)) return q;
  return null;
}

export const hermesBearerLoader: MiddlewareHandler = async (c, next) => {
  if (c.get("userId")) {
    await next();
    return;
  }
  const token = extractToken(c);
  if (token) {
    const ctx = await validateHermesToken(token);
    if (ctx) {
      c.set("hermesToken", ctx);
      c.set("userId", ctx.userId);
    }
  }
  await next();
};
