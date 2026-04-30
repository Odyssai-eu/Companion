-- Admin Extended add-on: RBAC on users, multi-tenant remote node
-- orchestrator (rsync model distribution), guest tokens with budget caps,
-- and an append-only auth event log.

ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"ip" text NOT NULL,
	"ssh_user" text DEFAULT 'admin' NOT NULL,
	"ssh_password" text,
	"ssh_key_setup" boolean DEFAULT false NOT NULL,
	"model_path" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_group_members" (
	"node_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "node_group_members_node_id_group_id_pk" PRIMARY KEY("node_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_node_id" uuid NOT NULL,
	"target_node_ids" uuid[] NOT NULL,
	"group_id" uuid,
	"model_path" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"log" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"token_budget" integer NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"scope" text DEFAULT 'chat' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "auth_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"event" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_groups" ADD CONSTRAINT "node_groups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_group_members" ADD CONSTRAINT "node_group_members_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_group_members" ADD CONSTRAINT "node_group_members_group_id_node_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."node_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_source_node_id_nodes_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_group_id_node_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."node_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_tokens" ADD CONSTRAINT "guest_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_log" ADD CONSTRAINT "auth_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nodes_user_idx" ON "nodes" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_groups_user_name_idx" ON "node_groups" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "sync_jobs_user_created_idx" ON "sync_jobs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "guest_tokens_token_hash_idx" ON "guest_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "guest_tokens_created_by_created_idx" ON "guest_tokens" USING btree ("created_by","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_log_created_idx" ON "auth_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_log_user_created_idx" ON "auth_log" USING btree ("user_id","created_at" DESC NULLS LAST);
