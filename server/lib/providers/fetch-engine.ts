/**
 * Authenticated fetch against an OdyssAI-X engine that detects crew-token
 * revocation.
 *
 * Per the gateway contract, the engine can revoke a Companion's crew
 * token from its side (operator clicks "Revoke" in the Crew tab). When
 * Companion hits the engine afterwards, the response carries the header
 *
 *     x-odyssai-crew-revoked: true
 *
 * on whatever request was in flight. We treat that as a hard signal:
 * wipe the engine_url / engine_token / engine_meta columns on the user
 * row and propagate a `crew_revoked` error so the caller can surface
 * the re-pair banner.
 *
 * The bare engine_url / engine_token survives the wipe only via fresh
 * pair flow. We deliberately don't keep them around — a revoked token
 * is useless and keeping it stale just confuses the UI.
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";

export class CrewRevokedError extends Error {
  constructor() {
    super("crew_revoked");
    this.name = "CrewRevokedError";
  }
}

export async function fetchFromEngine(
  userId: string,
  engineUrl: string,
  engineToken: string | null,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = engineUrl.replace(/\/+$/, "");
  const headers = new Headers(init.headers);
  if (engineToken) {
    headers.set("authorization", `Bearer ${engineToken}`);
  }
  const r = await fetch(`${base}${path}`, { ...init, headers });

  if (r.headers.get("x-odyssai-crew-revoked") === "true") {
    // Wipe the engine link — token is dead, no point keeping it. We
    // reset to a clean legacy state so the UI shows the Join CTA again.
    await db
      .update(users)
      .set({
        engineUrl: null,
        engineToken: null,
        engineMeta: null,
        engineMode: "legacy",
      })
      .where(eq(users.id, userId));
    throw new CrewRevokedError();
  }

  return r;
}
