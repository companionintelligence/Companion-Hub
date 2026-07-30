-- Pin `api_key.capability` to the three values the code understands, matching the constraint
-- CI-Server carries on its own capability column. Reads already fail closed — coerceApiKeyCapability
-- narrows an unrecognised value to 'read' rather than to the default — but that turns a bad write
-- into a key that silently behaves as read-only, which reads as a permissions bug rather than as the
-- data error it is. Refusing the write says so at the point it happens.
--
-- A separate migration rather than an edit to 0049: that one is `ADD COLUMN IF NOT EXISTS` and has
-- already run on appliances and developer machines, so amending it would be a no-op exactly where the
-- constraint is missing.
--
-- Guarded because Postgres has no ADD CONSTRAINT IF NOT EXISTS, and this must be re-runnable on a box
-- that already has it. No data is rewritten: every row is written through the typed enum, so an
-- existing value outside the set is a real defect and failing here is the correct way to surface it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_key_capability_check'
  ) THEN
    ALTER TABLE "api_key"
      ADD CONSTRAINT "api_key_capability_check"
      CHECK ("capability" IN ('read', 'write', 'full'));
  END IF;
END $$;
