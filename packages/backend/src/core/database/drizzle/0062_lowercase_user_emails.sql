-- Normalise stored email case so "the Hub's identity for a person is the lower-cased address" is
-- true of old rows too, not just ones written since `ensureLocalCompanionUser` started lower-casing
-- before its INSERT.
--
-- This is a repair, not just tidying. `getUserByUsername` lower-cases the value it is handed and
-- compares it to what is stored, so a row written as `Owner@Example.com` can never be matched: that
-- operator cannot use the password login form at all, and after CI-Hub#1300 a Portal address change
-- leaves them with no way in. The same split shows up at the Traefik edge, where the cookie path
-- signs `user.username` (lower-cased) and the Bearer path signs the raw Portal claim, so one person
-- arrives at an app as two users depending on the client they used.

-- `user.username` carries a UNIQUE constraint (`UQ_78a916df40e02a9deb1c4b75edb`, migration 0000), so
-- a blanket `lower()` would abort this migration — and with it Hub startup — on any appliance that
-- holds two rows differing only by case. Compare on `lower()` on BOTH sides so a row is normalised
-- only when nothing else in the table shares its folded address: that skips the row whose lower-case
-- twin already exists AND the pair that would collide with each other mid-statement. Skipped rows
-- are left exactly as they are; they are already unreachable today, so leaving them untouched is
-- strictly better than refusing to boot, and the warning below names them for an operator to merge.
UPDATE "user" AS u
SET "username" = lower(u."username")
WHERE u."username" <> lower(u."username")
  AND NOT EXISTS (
    SELECT 1
    FROM "user" AS other
    WHERE other."id" <> u."id"
      AND lower(other."username") = lower(u."username")
  );
--> statement-breakpoint

-- Audit/display only — never used for auth matching — so there is no constraint to trip and no
-- collision to dodge. Normalised anyway so the column agrees with the `user` row it describes.
UPDATE "federated_identity"
SET "email" = lower("email")
WHERE "email" IS NOT NULL
  AND "email" <> lower("email");
--> statement-breakpoint

-- Name anything the collision guard above had to skip. These need a human to decide which row is the
-- real account before they can be merged; a migration must not guess, because the rows can differ in
-- password, TOTP secret, operator flag and everything that references `user.id`.
DO $$
DECLARE
  leftover text;
BEGIN
  SELECT string_agg(DISTINCT lower("username"), ', ')
  INTO leftover
  FROM "user"
  WHERE "username" <> lower("username");

  IF leftover IS NOT NULL THEN
    RAISE WARNING 'Hub user emails left mixed-case because another row folds to the same address: %. Merge these accounts by hand; until then the mixed-case row cannot sign in.', leftover;
  END IF;
END $$;
