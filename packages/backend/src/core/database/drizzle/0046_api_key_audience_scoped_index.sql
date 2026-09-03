-- SEC-MCP-8: uniqueness of a key hash is per audience, not global. Every lookup is audience-scoped,
-- so the same secret may legitimately exist under two surfaces; a cross-surface collision must never
-- abort an insert/seed for an unrelated surface.
DROP INDEX IF EXISTS "api_key_hashed_key_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_key_audience_hashed_key_idx" ON "api_key" ("audience", "hashed_key");
