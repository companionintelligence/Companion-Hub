CREATE TABLE IF NOT EXISTS "api_key" (
  "id" serial PRIMARY KEY NOT NULL,
  "audience" varchar(16) DEFAULT 'mcp' NOT NULL,
  "name" varchar NOT NULL,
  "prefix" varchar(12) NOT NULL,
  "hashed_key" varchar NOT NULL,
  "managed" boolean DEFAULT false NOT NULL,
  "owner_app_urn" varchar,
  "expires_at" timestamp,
  "last_used_at" timestamp,
  "createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_key_hashed_key_idx" ON "api_key" ("hashed_key");
