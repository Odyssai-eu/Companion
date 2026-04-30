ALTER TABLE "projects" ADD COLUMN "memory_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "memory_enabled" boolean DEFAULT true NOT NULL;
