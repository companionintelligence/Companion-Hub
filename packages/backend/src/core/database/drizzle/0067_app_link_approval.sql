-- An operator's leave for one app to reach another directly. Each app is on a Docker network of its
-- own now, and an app reaches another only over a network the Hub makes for the two of them, when both
-- manifests name each other (`hub_integration.links`). Two apps of the same store that do are linked
-- by themselves; any other link waits for the operator, and this is where their answer is kept.
-- `service` and `alias` are what was allowed: a manifest that later names another service asks again.
CREATE TABLE IF NOT EXISTS "app_link_approval" (
	"id" serial PRIMARY KEY NOT NULL,
	"consumer_urn" varchar NOT NULL,
	"provider_urn" varchar NOT NULL,
	"service" varchar NOT NULL,
	"alias" varchar NOT NULL,
	"approved_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_link_approval_pair_idx" ON "app_link_approval" USING btree ("consumer_urn","provider_urn");
