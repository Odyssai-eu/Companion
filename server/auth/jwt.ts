import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { SignJWT, jwtVerify } from "jose";

const SESSION_TTL = "30d";

const PLACEHOLDER_LITERAL = "replace-me-with-a-real-secret-before-deploy";
const SECRET_FILE = process.env.AUTH_JWT_SECRET_FILE ?? "/app/data/jwt-secret";

let _resolvedSecret: Uint8Array | null = null;

function loadOrGenerateSecret(): string {
  // 1. Operator-provided via env wins, but reject the well-known
  //    placeholder literal so a forgotten `.env` doesn't ship a known
  //    secret to production.
  const env = process.env.AUTH_JWT_SECRET;
  if (env && env.length >= 32 && env !== PLACEHOLDER_LITERAL) {
    return env;
  }
  if (env === PLACEHOLDER_LITERAL) {
    console.warn(
      "[jwt] AUTH_JWT_SECRET is the placeholder literal — ignoring and " +
        "falling back to a persisted random secret. Set a real secret in " +
        ".env to silence this warning.",
    );
  }

  // 2. Read a persisted secret if one already exists.
  try {
    if (existsSync(SECRET_FILE)) {
      const persisted = readFileSync(SECRET_FILE, "utf8").trim();
      if (persisted.length >= 32) return persisted;
    }
  } catch (e) {
    console.warn(`[jwt] could not read ${SECRET_FILE}:`, (e as Error).message);
  }

  // 3. Generate one and persist it so it survives restarts (otherwise
  //    every container restart invalidates every session).
  const fresh = randomBytes(48).toString("base64url");
  try {
    mkdirSync(dirname(SECRET_FILE), { recursive: true });
    writeFileSync(SECRET_FILE, fresh + "\n", { mode: 0o600 });
    chmodSync(SECRET_FILE, 0o600);
    console.log(
      `[jwt] generated a fresh session secret, persisted at ${SECRET_FILE}.`,
    );
  } catch (e) {
    console.warn(
      `[jwt] could not persist secret to ${SECRET_FILE} — sessions will ` +
        "invalidate on every restart:",
      (e as Error).message,
    );
  }
  return fresh;
}

function getSecret(): Uint8Array {
  if (!_resolvedSecret) {
    _resolvedSecret = new TextEncoder().encode(loadOrGenerateSecret());
  }
  return _resolvedSecret;
}

export type SessionPayload = {
  userId: string;
  email: string;
};

export async function createSessionToken(
  payload: SessionPayload,
): Promise<string> {
  return await new SignJWT({ email: payload.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.userId)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(getSecret());
}

export async function verifySessionToken(
  token: string,
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (!payload.sub || typeof payload.email !== "string") return null;
    return { userId: payload.sub, email: payload.email };
  } catch {
    return null;
  }
}
