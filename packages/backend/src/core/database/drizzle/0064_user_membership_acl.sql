-- Appliance ACL on the local operator row. Portal still decides who may be created and who is
-- still in the org; Hub uses these columns to admit an already-created person when WAN is down
-- and to refuse someone Portal has removed without deleting the federated binding.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "access_status" varchar DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "org_role" varchar;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "membership_checked_at" timestamp;
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "local_password_set_at" timestamp;
