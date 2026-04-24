CREATE TABLE IF NOT EXISTS "addons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'plugin'
    CHECK ("kind" IN ('core', 'plugin', 'mcp')),
  "description" text,
  "version" text,
  "enabled" boolean NOT NULL DEFAULT false,
  "config" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "addons_user_kind_idx"
  ON "addons" ("user_id", "kind");
