ALTER TABLE "device_registration" ADD COLUMN "provisioning_phase" varchar DEFAULT 'locally_ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_registration" ADD COLUMN "degraded_reasons" text DEFAULT '[]' NOT NULL;
