-- Extend conversations.kind to allow 'hermes' (direct-to-Hermes-Agent
-- conversations). The previous check constraint only permitted chat/talk;
-- drop and re-add with the new triple. Idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_kind_check'
  ) THEN
    ALTER TABLE conversations DROP CONSTRAINT conversations_kind_check;
  END IF;
  ALTER TABLE conversations
    ADD CONSTRAINT conversations_kind_check
    CHECK (kind IN ('chat', 'talk', 'hermes'));
END $$;
