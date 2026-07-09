-- Convert memory_connection.key_expires_at to timestamptz so the UTC instant
-- issued by CI-Server survives the round-trip (a zoneless `timestamp` drops the
-- offset and gets re-parsed as local time downstream). 0048 added the column as
-- `timestamp`; this is the forward fix rather than an in-place edit, so DBs that
-- already ran 0048 are corrected too. Guarded on the current type so it is a
-- no-op on databases where the column already landed as timestamptz.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_connection'
      AND column_name = 'key_expires_at'
      AND data_type = 'timestamp without time zone'
  ) THEN
    ALTER TABLE "memory_connection"
      ALTER COLUMN "key_expires_at" TYPE timestamptz
      USING "key_expires_at" AT TIME ZONE 'UTC';
  END IF;
END $$;
