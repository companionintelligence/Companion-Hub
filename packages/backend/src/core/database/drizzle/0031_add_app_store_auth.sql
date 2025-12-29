ALTER TABLE "app_store" ADD COLUMN "type" text DEFAULT 'git';
ALTER TABLE "app_store" ADD COLUMN "authorization_key" text;

UPDATE "app_store" SET "type" = 'http_zip', "url" = 'http://localhost:3001/download' WHERE "slug" = 'ci-app-store';
