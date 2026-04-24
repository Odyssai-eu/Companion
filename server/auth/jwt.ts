import { SignJWT, jwtVerify } from "jose";

const SESSION_TTL = "30d";

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "AUTH_JWT_SECRET must be set and at least 32 chars long. Set it in the environment.",
    );
  }
  return new TextEncoder().encode(raw);
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
