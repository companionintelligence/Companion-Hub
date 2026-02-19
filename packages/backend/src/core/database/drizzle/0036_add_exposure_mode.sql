ALTER TABLE "app" ADD COLUMN "exposure_mode" varchar DEFAULT 'local' NOT NULL;--> statement-breakpoint
UPDATE "app" SET "exposure_mode" = 'cloudflare' WHERE "exposed_local" = true;--> statement-breakpoint
UPDATE "app" SET "exposure_mode" = 'local' WHERE "exposed_local" = false;
