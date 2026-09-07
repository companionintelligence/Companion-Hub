CREATE TABLE IF NOT EXISTS "lifecycle_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_urn" varchar,
	"operation" varchar NOT NULL,
	"status" varchar NOT NULL,
	"progress_percent" integer,
	"error" text,
	"metadata" jsonb,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
