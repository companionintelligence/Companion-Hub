ALTER TABLE "app" ADD COLUMN IF NOT EXISTS "auto_restart_on_domain_change" boolean DEFAULT false NOT NULL;
