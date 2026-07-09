-- Companion Memory connection state, one row per memory-consumer app (keyed by
-- app URN). Backs the memory-connect flow: `state` drives the wrapper
-- interstitial, `encrypted_key` holds the AES-256-GCM-encrypted CI-Server key
-- the Hub re-emits into the app's env on every restart (CI-Server reveals the
-- raw key only once), and `server_url` is the Companion Memory URL captured at
-- connect time.
--
-- key_expires_at is timestamptz (NOT a zoneless `timestamp`): CI-Server issues
-- the expiry as a UTC instant, and a zoneless column would drop the offset and
-- get re-parsed as local time downstream, drifting the rotation age-gate by the
-- container's UTC offset. The rotation sweep refreshes the key well before this.
CREATE TABLE IF NOT EXISTS "memory_connection" (
  "id" serial PRIMARY KEY NOT NULL,
  "app_urn" varchar NOT NULL,
  "state" varchar DEFAULT 'unconfigured' NOT NULL,
  "encrypted_key" text,
  "server_url" varchar,
  "key_expires_at" timestamptz,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "memory_connection_app_urn_unique" UNIQUE("app_urn")
);
