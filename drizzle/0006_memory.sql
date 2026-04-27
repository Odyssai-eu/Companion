-- Memory (LLM wiki) — compiled by the thecompai-memory Python service.

CREATE TABLE IF NOT EXISTS "memory_articles" (
    "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id"         uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "project_id"      uuid REFERENCES "projects"("id") ON DELETE CASCADE,
    "path"            text NOT NULL,
    "title"           text NOT NULL,
    "summary"         text NOT NULL,
    "body"            text NOT NULL,
    "hash"            text NOT NULL,
    "edited_by_user"  boolean NOT NULL DEFAULT false,
    "created_at"      timestamptz NOT NULL DEFAULT now(),
    "updated_at"      timestamptz NOT NULL DEFAULT now()
);

-- Postgres treats NULLs as distinct, so two partial unique indexes:
-- one for project-scoped articles, one for global (project_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS "memory_articles_user_project_path_idx"
    ON "memory_articles" ("user_id", "project_id", "path")
    WHERE "project_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "memory_articles_user_global_path_idx"
    ON "memory_articles" ("user_id", "path")
    WHERE "project_id" IS NULL;

CREATE INDEX IF NOT EXISTS "memory_articles_user_updated_idx"
    ON "memory_articles" ("user_id", "updated_at" DESC);


CREATE TABLE IF NOT EXISTS "memory_compile_state" (
    "user_id"           uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "conversation_id"   uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
    "last_compiled_at"  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY ("user_id", "conversation_id")
);
