CREATE TABLE IF NOT EXISTS "projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "category" text NOT NULL DEFAULT 'general',
  "icon" text,
  "system_prompt" text,
  "instructions" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "projects_user_updated_idx"
  ON "projects" ("user_id", "updated_at");

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "project_id" uuid
    REFERENCES "projects"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "conversations_project_idx"
  ON "conversations" ("project_id");
