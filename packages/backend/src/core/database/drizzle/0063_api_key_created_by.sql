-- Record which Hub person created each API key, so an unmanaged key acts with that person's grants and role.
-- Keys that already exist have no recorded creator and stay NULL, as does a managed app key.
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "created_by_user_id" integer;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
