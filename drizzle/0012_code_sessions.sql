-- Code sessions: read-only preflight first, later Hermes/runner execution.

CREATE TABLE "code_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_path" text NOT NULL,
	"repo_name" text NOT NULL,
	"task" text NOT NULL,
	"model" text,
	"status" text DEFAULT 'preflight' NOT NULL,
	"risk" text DEFAULT 'medium' NOT NULL,
	"preflight" jsonb,
	"blockers" jsonb,
	"hermes_session_id" text,
	"hermes_status" text,
	"hermes_output" text,
	"hermes_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "code_sessions" ADD CONSTRAINT "code_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "code_sessions_user_created_idx" ON "code_sessions" USING btree ("user_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "code_sessions_status_idx" ON "code_sessions" USING btree ("status");
