/**
 * Hermes-token auth middleware — resolves `Authorization: Bearer hms_<…>`
 * into a real userId before `requireUser` runs. Used by the thecompai-mcp
 * MCP server (Hermes Agent on .50, Cowork dispatch) to call back into
 * Companion on behalf of the user.
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
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (m && m[1].startsWith(HERMES_TOKEN_PREFIX)) return m[1];
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
