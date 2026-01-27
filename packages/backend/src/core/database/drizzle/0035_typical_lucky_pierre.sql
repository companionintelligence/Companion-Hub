ALTER TABLE "device_registration" ADD COLUMN "slug" varchar;--> statement-breakpoint
UPDATE "device_registration" SET "slug" = "name";--> statement-breakpoint
ALTER TABLE "device_registration" ALTER COLUMN "slug" SET NOT NULL;