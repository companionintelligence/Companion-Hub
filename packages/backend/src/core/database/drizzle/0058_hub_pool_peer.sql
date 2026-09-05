CREATE TABLE IF NOT EXISTS "hub_pool_peer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tailscale_device_id" varchar,
	"node_fqdn" varchar NOT NULL,
	"display_name" varchar,
	"direction" varchar NOT NULL,
	"status" varchar DEFAULT 'pending' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp,
	"last_capabilities" jsonb,
	"verify_token_hash" varchar,
	"present_token_encrypted" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "hub_pool_peer_node_fqdn_unique" UNIQUE("node_fqdn")
);
