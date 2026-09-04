CREATE TABLE IF NOT EXISTS "entitlement_cache" (
	"app_urn" varchar PRIMARY KEY NOT NULL,
	"entitled" boolean NOT NULL,
	"reason" varchar,
	"payment_url" varchar,
	"cached_at" timestamp DEFAULT now() NOT NULL
);
