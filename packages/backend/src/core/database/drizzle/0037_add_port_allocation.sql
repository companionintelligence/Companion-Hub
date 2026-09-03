CREATE TABLE IF NOT EXISTS "port_allocation" (
  "id" serial PRIMARY KEY NOT NULL,
  "app_urn" varchar NOT NULL,
  "host_port" integer NOT NULL,
  "container_port" integer NOT NULL,
  "protocol" varchar(3) DEFAULT 'tcp' NOT NULL,
  "label" varchar(64) DEFAULT 'main' NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "port_protocol_idx" ON "port_allocation" ("host_port", "protocol");
