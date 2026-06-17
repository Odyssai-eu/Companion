-- 2026-06-17: Memory OFF by default (#36). Master switch on whether the chat
-- hot-path injects ANY memory for a user. Default FALSE — memory is opt-in.
-- Existing users get false too (the always-on behaviour was unmanageable —
-- Sophie: "par défaut elle est on, elle doit être off, sinon c'est ingérable").
-- Distinct from auto_memory_enabled (wiki auto-compile only, not injection).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS memory_enabled boolean NOT NULL DEFAULT false;
