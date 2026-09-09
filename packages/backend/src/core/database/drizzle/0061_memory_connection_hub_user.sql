-- Persist Companion Memory connect keys per Hub person, not per app install.
-- Existing rows inherit the first operator so the running token keeps an owner.
ALTER TABLE "memory_connection" ADD COLUMN IF NOT EXISTS "hub_user_id" integer;
--> statement-breakpoint
UPDATE "memory_connection"
SET "hub_user_id" = (SELECT "id" FROM "user" WHERE "operator" = true ORDER BY "id" ASC LIMIT 1)
WHERE "hub_user_id" IS NULL;
--> statement-breakpoint
UPDATE "memory_connection" SET "hub_user_id" = 0 WHERE "hub_user_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "memory_connection" ALTER COLUMN "hub_user_id" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "memory_connection" ALTER COLUMN "hub_user_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "memory_connection" DROP CONSTRAINT IF EXISTS "memory_connection_app_urn_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memory_connection_app_urn_hub_user_idx" ON "memory_connection" ("app_urn", "hub_user_id");
