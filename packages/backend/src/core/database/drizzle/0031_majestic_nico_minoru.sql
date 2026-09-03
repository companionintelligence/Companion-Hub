CREATE TABLE IF NOT EXISTS "organization" (
	"id" varchar PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"tunnel_id" varchar NOT NULL,
	"domain" varchar NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
