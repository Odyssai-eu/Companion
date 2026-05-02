-- The rollbacked Hermes Code experiment left an older code_sessions table in
-- dev DBs while _migrations already contained 0012. Bring that table to the
-- read-only preflight shape expected by v0.1.39 without dropping old columns.

CREATE TABLE IF NOT EXISTS "code_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "repo_path" text;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "repo_name" text;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "model" text;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "risk" text DEFAULT 'medium' NOT NULL;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "preflight" jsonb;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "blockers" jsonb;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "hermes_session_id" text;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "hermes_status" text;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "hermes_output" text;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "hermes_error" text;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "code_sessions" ALTER COLUMN "repo" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "code_sessions" ALTER COLUMN "autonomous" DROP NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'code_sessions' AND column_name = 'repo'
	) THEN
		UPDATE "code_sessions"
		SET
			"repo_path" = COALESCE("repo_path", "repo"),
			"repo_name" = COALESCE(
				"repo_name",
				split_part(COALESCE("repo", 'unknown'), '/', array_length(string_to_array(COALESCE("repo", 'unknown'), '/'), 1))
			)
		WHERE "repo_path" IS NULL OR "repo_name" IS NULL;
	END IF;

	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_name = 'code_sessions' AND column_name = 'started_at'
	) THEN
		UPDATE "code_sessions"
		SET
			"created_at" = COALESCE("created_at", "started_at"),
			"updated_at" = COALESCE("updated_at", COALESCE("finished_at", "started_at", now()));
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_sessions_user_created_idx" ON "code_sessions" USING btree ("user_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "code_sessions_status_idx" ON "code_sessions" USING btree ("status");
