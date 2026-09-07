-- Hub Pool peer v2: the per-peer kill switch, plus the peer-identity columns and the singleton
-- identity table the signed-request work needs.
--
-- Deliberately ONE migration for four features' columns. `drizzle-kit generate` needs a TTY and
-- cannot run here, so every migration in this repo is hand-written and hand-registered in
-- meta/_journal.json — and two hand-written files claiming the same `when` is a silent no-op, not
-- an error. Landing every `hub_pool_peer` column at once removes that race entirely.
--
-- Every added column is either nullable or carries a DEFAULT, so an existing row migrates to
-- exactly today's behaviour and a rollback loses nothing but the new state.
ALTER TABLE "hub_pool_peer" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "hub_pool_peer" ADD COLUMN IF NOT EXISTS "peer_node_uuid" text;--> statement-breakpoint
ALTER TABLE "hub_pool_peer" ADD COLUMN IF NOT EXISTS "peer_public_key" text;--> statement-breakpoint
ALTER TABLE "hub_pool_peer" ADD COLUMN IF NOT EXISTS "bearer_grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hub_pool_peer" ADD COLUMN IF NOT EXISTS "signed_seen_at" timestamp with time zone;--> statement-breakpoint
-- Partial, so "no UUID yet" never collides with itself and the column can stay nullable.
CREATE UNIQUE INDEX IF NOT EXISTS "hub_pool_peer_node_uuid_uidx" ON "hub_pool_peer" ("peer_node_uuid") WHERE "peer_node_uuid" IS NOT NULL;--> statement-breakpoint
-- Retire the dead `status = 'rejected'` value. Nothing has ever written it (rejecting a pairing
-- deletes the row), so this normalizes at most a hand-edited row rather than real state; it runs so
-- that "not in play" has exactly one meaning from here on — `enabled = false` — instead of two.
UPDATE "hub_pool_peer" SET "status" = 'unreachable' WHERE "status" = 'rejected';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hub_pool_identity" (
	"id" varchar PRIMARY KEY DEFAULT 'self' NOT NULL,
	"node_uuid" uuid NOT NULL,
	"public_key" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"algorithm" varchar DEFAULT 'ed25519' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"rotated_at" timestamp,
	CONSTRAINT "hub_pool_identity_node_uuid_unique" UNIQUE("node_uuid"),
	CONSTRAINT "hub_pool_identity_singleton" CHECK ("id" = 'self')
);
