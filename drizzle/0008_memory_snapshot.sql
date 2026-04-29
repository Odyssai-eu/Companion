ALTER TABLE "conversations" ADD COLUMN "memory_snapshot" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory_snapshot_at" timestamp with time zone;