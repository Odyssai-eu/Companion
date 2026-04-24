-- Add engine_kind + auth_bearer on servers (so we know how to talk to it)
ALTER TABLE "servers"
  ADD COLUMN IF NOT EXISTS "engine_kind" text NOT NULL DEFAULT 'openai-compat',
  ADD COLUMN IF NOT EXISTS "auth_bearer" text;

ALTER TABLE "servers"
  DROP CONSTRAINT IF EXISTS "servers_engine_kind_check",
  ADD CONSTRAINT "servers_engine_kind_check"
    CHECK ("engine_kind" IN ('openai-compat', 'anthropic'));

-- Conversations + messages
CREATE TABLE IF NOT EXISTS "conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "server_id" uuid REFERENCES "servers"("id") ON DELETE SET NULL,
  "title" text NOT NULL DEFAULT 'New conversation',
  "model" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "conversations_user_updated_idx"
  ON "conversations" ("user_id", "updated_at");

CREATE TABLE IF NOT EXISTS "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('user', 'assistant', 'system')),
  "content" text NOT NULL DEFAULT '',
  "reasoning" text,
  "stats" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "messages_conversation_idx"
  ON "messages" ("conversation_id", "created_at");
