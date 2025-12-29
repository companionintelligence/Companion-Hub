ALTER TABLE "app_store" ADD COLUMN "type" text DEFAULT 'git';--> statement-breakpoint
ALTER TABLE "app_store" ADD COLUMN "authorization_key" text;--> statement-breakpoint

INSERT INTO
  "app_store" ("slug", "hash", "name", "url", "branch", "type")
VALUES
  (
    'ci-app-store',
    'ci-app-store',
    'CI App Store',
    'http://host.docker.internal:3001/download',
    'main',
    'http_zip'
  )
ON CONFLICT ("slug") DO UPDATE SET
  "url" = EXCLUDED."url",
  "type" = EXCLUDED."type";
