-- One api_key row can now open several surfaces: `scopes` replaces the single-valued `audience`
-- ('mcp' tools access, 'app' app→Hub callback access). A companion app that consumes both holds a
-- single key with both scopes, so granting a scope never rotates a credential an app already holds.
-- `audience` is kept and dual-written (as scopes[0]) for one release so a rolled-back Hub still
-- reads the table correctly; it is dropped in a follow-up migration.
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
UPDATE "api_key" SET "scopes" = ARRAY["audience"] WHERE "scopes" = '{}';
