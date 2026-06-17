-- 2026-06-17: Drop the user-level memory master (#36). It shadowed the
-- existing per-conversation memory toggle (the green header switch) — the
-- toggle could be green while memory stayed off. The conversation-level
-- toggle is now THE control, defaulting OFF. Remove the redundant column
-- added in 0053.
ALTER TABLE users
  DROP COLUMN IF EXISTS memory_enabled;
