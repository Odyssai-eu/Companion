-- Legacy Hermes Code rollback left old NOT NULL constraints on columns this
-- implementation no longer writes. Drop them so new preflight sessions insert
-- cleanly.

ALTER TABLE "code_sessions" ALTER COLUMN "repo" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "code_sessions" ALTER COLUMN "autonomous" DROP NOT NULL;

