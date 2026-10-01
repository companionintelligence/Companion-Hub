-- A stable id for every Hub person, and an id for the directory of people they belong to.
--
-- Apps behind Traefik learn who is calling from the signed `X-CI-Hub-User` header, which carries
-- the username. A username is the person's to change (`PATCH /api/auth/username`), so an app that
-- keys its accounts on it loses them at the first rename: Companion Memory signed a renamed person
-- into a new, empty account and left their memories behind an address the Hub never named again.
-- Forward auth now also signs `X-CI-Hub-User-Id` (this column) and `X-CI-Hub-User-Issuer`
-- (`urn:ci-hub:<directory_id>`), so an app can key on something that never changes.
-- CI-Engineering architecture/identity/hub-memory-account-link.md has the whole contract.
--
-- `user.id` is not that key: a factory reset restarts its sequence, and a restored backup
-- re-issues every id minted after it, so the next person to get id 2 would inherit whatever an app
-- linked to the previous one. A random uuid per row never comes back. The DEFAULT is volatile, so
-- every existing row gets its own value as the column is added.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "public_id" uuid DEFAULT gen_random_uuid() NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_public_id_idx" ON "user" USING btree ("public_id");
--> statement-breakpoint

-- One row, for the life of this database. An app that links accounts to Hub people scopes "is
-- this account already somebody else's?" to a directory: within it, a username handed on after a
-- rename must not inherit the previous holder's account; across directories (an app's backup
-- restored onto a fresh Hub), the new Hub's people must be able to claim their accounts again.
CREATE TABLE IF NOT EXISTS "user_directory" (
	"id" varchar DEFAULT 'self' PRIMARY KEY NOT NULL,
	"directory_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_directory_singleton" CHECK ("user_directory"."id" = 'self')
);
--> statement-breakpoint
INSERT INTO "user_directory" ("id") VALUES ('self') ON CONFLICT ("id") DO NOTHING;
