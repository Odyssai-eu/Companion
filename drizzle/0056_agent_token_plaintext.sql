-- 2026-06-18: Agent tokens re-copyable (#37). Store the plaintext token so the
-- user can copy it from the active tokens list instead of minting a new one.
-- Nullable: rows minted before this stay hash-only (no plaintext to show).
ALTER TABLE "hermes_tokens" ADD COLUMN IF NOT EXISTS "token" text;
