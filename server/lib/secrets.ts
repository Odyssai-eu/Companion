import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

/**
 * Symmetric encryption for secrets at rest (e.g. node SSH passwords).
 *
 * Format: `aesgcm/v1:<base64(iv|tag|ciphertext)>`
 *   - iv: 12 bytes
 *   - tag: 16 bytes (GCM auth tag)
 *   - ciphertext: variable
 *
 * Key source:
 *   - Preferred: env `THECOMPAI_SECRETS_KEY` (32-byte hex string).
 *   - Fallback (dev-only, NOT for production): sha256 of AUTH_JWT_SECRET so
 *     existing dev DBs keep working without new env wiring.
 */

const FORMAT_PREFIX = "aesgcm/v1:";
const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

let warned = false;

function getKey(): Buffer {
  const hex = process.env.THECOMPAI_SECRETS_KEY;
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) {
    return Buffer.from(hex, "hex");
  }
  if (!warned) {
    warned = true;
    console.warn(
      "[secrets] THECOMPAI_SECRETS_KEY missing or invalid — deriving a dev " +
        "fallback from AUTH_JWT_SECRET. This is dev-only, NOT for production.",
    );
  }
  // Dev-only fallback. Production must set THECOMPAI_SECRETS_KEY.
  const seed = process.env.AUTH_JWT_SECRET ?? "thecompai-dev-secret";
  return createHash("sha256").update(seed).digest();
}

export function encryptSecret(plain: string): string {
  if (typeof plain !== "string") {
    throw new Error("encryptSecret: plain must be a string");
  }
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, ciphertext]).toString("base64");
  return FORMAT_PREFIX + payload;
}

export function decryptSecret(payload: string): string {
  if (typeof payload !== "string" || !payload.startsWith(FORMAT_PREFIX)) {
    throw new Error("decryptSecret: unknown or missing format prefix");
  }
  const b64 = payload.slice(FORMAT_PREFIX.length);
  const buf = Buffer.from(b64, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("decryptSecret: payload too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = buf.subarray(IV_LEN + TAG_LEN);
  const key = getKey();
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
