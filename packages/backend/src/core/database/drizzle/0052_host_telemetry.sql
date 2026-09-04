CREATE TABLE IF NOT EXISTS "host_telemetry_sample" (
	"id" serial PRIMARY KEY NOT NULL,
	"sampled_at" timestamp DEFAULT now() NOT NULL,
	"cpu_load" integer,
	"cpu_cores" integer,
	"memory_used" integer,
	"memory_total" integer,
	"disk_used" integer,
	"disk_total" integer,
	"percent_used_memory" integer,
	"docker_available" boolean,
	"docker_info" jsonb,
	"apps" jsonb,
	"source" varchar DEFAULT 'collector' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_telemetry_sample_sampled_at_idx" ON "host_telemetry_sample" ("sampled_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "host_event_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"level" varchar NOT NULL,
	"source" varchar NOT NULL,
	"message" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_event_log_created_at_idx" ON "host_event_log" ("created_at");
