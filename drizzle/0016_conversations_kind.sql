-- Voice-first conversations get kind='talk'; everything pre-existing stays
-- 'chat'. The TalkLayout swap (no model picker, big-mic input) is keyed off
-- this column. Idempotent; default backfills cleanly.
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'chat';

-- Lightweight check so the column stays a closed enum without the cost of
-- a Postgres ENUM type (which Drizzle handles awkwardly).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_kind_check'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_kind_check
      CHECK (kind IN ('chat', 'talk'));
  END IF;
END $$;
