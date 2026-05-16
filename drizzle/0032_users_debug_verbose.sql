-- Per-user toggle for verbose request logging on chat.ts. When true,
-- the upstream /v1/chat/completions body is logged (truncated to 8 KiB)
-- with the `[chat:upstream]` prefix before every POST. Useful for
-- diagnosing tool-call shape issues, model id resolution, streaming
-- weirdness. Default false — produces a lot of stdout. Flip in
-- Settings → Inference → Debug.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS debug_verbose boolean NOT NULL DEFAULT false;
