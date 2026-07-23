-- One api_key row can open several surfaces: `scopes` ('mcp' tools access, 'app' app→Hub callback
-- access) replaces the single-valued `audience`. A companion app that consumes both holds a single
-- key carrying both scopes, so granting a scope never rotates a credential an app already holds.
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
UPDATE "api_key" SET "scopes" = ARRAY["audience"] WHERE "scopes" = '{}';
--> statement-breakpoint
-- Uniqueness follows the lookup: keys resolve by hash alone now (scope membership is checked on the
-- resolved row), so a hash must be globally unique rather than unique per audience. Existing rows
-- cannot collide — hashes are of 256-bit random keys.
DROP INDEX IF EXISTS "api_key_audience_hashed_key_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_key_hashed_key_idx" ON "api_key" ("hashed_key");
--> statement-breakpoint
ALTER TABLE "api_key" DROP COLUMN IF EXISTS "audience";
