ALTER TABLE "organization" ALTER COLUMN "tunnel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "tunnel_token" varchar;