-- 2026-05-19: Audiobook add-on retired per Sophie's UX brief.
-- Removes the row from any user that had it seeded earlier.
-- Idempotent — re-running on a fresh DB is a no-op.
DELETE FROM addons WHERE name = 'Audiobook';
