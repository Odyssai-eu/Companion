CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL UNIQUE,
  "name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "servers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "hint" text,
  "url" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "servers_user_name_idx" ON "servers" ("user_id", "name");

CREATE TABLE IF NOT EXISTS "endpoints" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "role" text NOT NULL CHECK ("role" IN ('primary', 'secondary')),
  "node" text,
  "ip" text NOT NULL,
  "port" integer NOT NULL,
  "healthy" boolean DEFAULT true NOT NULL,
  "latency_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
