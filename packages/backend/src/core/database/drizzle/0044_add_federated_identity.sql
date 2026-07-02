CREATE TABLE IF NOT EXISTS "federated_identity" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "issuer" varchar NOT NULL,
  "subject" varchar NOT NULL,
  "email" varchar,
  "email_verified" boolean DEFAULT false NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "federated_identity" ADD CONSTRAINT "federated_identity_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "federated_identity_issuer_subject_idx" ON "federated_identity" ("issuer", "subject");
