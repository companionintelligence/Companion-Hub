CREATE TABLE IF NOT EXISTS "memory_connection" (
  "id" serial PRIMARY KEY NOT NULL,
  "app_urn" varchar NOT NULL,
  "state" varchar DEFAULT 'unconfigured' NOT NULL,
  "encrypted_key" text,
  "server_url" varchar,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "memory_connection_app_urn_unique" UNIQUE("app_urn")
);
