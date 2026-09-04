CREATE TABLE IF NOT EXISTS "whois_cache" (
	"subject" varchar NOT NULL,
	"app_id" varchar NOT NULL,
	"can_json" text NOT NULL,
	"version" integer NOT NULL,
	"cached_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "whois_cache_subject_app_id_pk" PRIMARY KEY("subject","app_id")
);
