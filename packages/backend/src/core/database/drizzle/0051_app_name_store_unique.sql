-- Deduplicate before unique index; prefer running/stopped over stranded installing, then lowest id.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY app_name, app_store_slug
      ORDER BY
        CASE status
          WHEN 'running' THEN 0
          WHEN 'stopped' THEN 1
          WHEN 'missing' THEN 2
          WHEN 'install_failed' THEN 3
          WHEN 'installing' THEN 4
          ELSE 5
        END,
        id ASC
    ) AS rn
  FROM
    app
)
DELETE FROM app
WHERE id IN (
    SELECT
      id
    FROM
      ranked
    WHERE
      rn > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_name_store_slug_uidx" ON "app" ("app_name", "app_store_slug");
