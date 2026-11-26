-- The Hub login is on for every app, on every route, unless an operator switches it off
-- (`requiresHubLogin` in @ci-hub/common). Before this, `enable_auth` was NOT NULL DEFAULT false and
-- applied to the Public web route only, so a row reading `false` could be an operator's choice or an
-- install that never decided, and nothing could tell which. Every app starts this version with the
-- login on; an operator who wants an app without it switches it off again, and from here on `false`
-- only ever means that.
ALTER TABLE "app" ALTER COLUMN "enable_auth" SET DEFAULT true;
--> statement-breakpoint
UPDATE "app" SET "enable_auth" = true WHERE "enable_auth" = false;
--> statement-breakpoint
-- The stored form is what a restart, an update and the settings dialog replay; a `false` left in it
-- would switch the login back off at the next save.
UPDATE "app" SET "config" = jsonb_set("config", '{enableAuth}', 'true'::jsonb) WHERE "config"->'enableAuth' = 'false'::jsonb;
