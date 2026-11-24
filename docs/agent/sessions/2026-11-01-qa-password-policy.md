# QA password policy for Marketplace app runs

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `qa-password-policy` |
| **Date** | 2026-11-01 |
| **Agent** | Codex |
| **Model** | GPT-6 |
| **Task** | Make fleet Marketplace QA generate passwords that satisfy app form policies |

## Goal

Generate fresh QA passwords that satisfy common uppercase, lowercase, and digit complexity rules while honoring each Marketplace field's declared minimum and maximum lengths. Keep the generator inline because fleet controllers copy `qa-stream.ts` as a single file.

## Steps taken

1. Reproduced the SQL Server QA setup issue: the old generator emitted only lowercase hexadecimal for password fields.
2. Added an inline cryptographic generator using `randomInt`, randomized positions for required character classes, alphanumeric output, and declared bounds (with a 4096-character default maximum when omitted).
3. Added tests for complexity, allowed characters, bounds, infeasible schemas, fresh output, and field wiring; documented the form-field contract.
4. Ran the targeted checks and full shift validation; requested a separate-model review.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Keep password generation inline in `qa-stream.ts` | Fleet nodes receive that file directly; a helper import would fail remotely. |
| Leave non-password secrets on opaque random hex | Only app password fields need complexity rules; other secret formats should not change. |
| Keep punctuation out of generated passwords | Avoid Compose and shell interpolation hazards in the QA path. |

## Files touched

- `scripts/qa-stream.ts`
- `scripts/__tests__/qa-password.test.ts`
- `docs/system/agent-qa.md`
- `docs/agent/sessions/2026-11-01-qa-password-policy.md`
- `docs/agent/sessions/2026-11-01-qa-password-policy-feedback.md`
- `docs/agent/WORKFLOW_FEEDBACK.md`

## Tests run

- [x] Targeted Biome check and 40 tests across password generation, compose retry, and registry failure.
- [x] `pnpm run agent:validate --skip-visual --skip-benchmark` — lint, typecheck, unit/CLI tests, and OpenAPI drift passed.
- [ ] App run — script-only change; full validation plus exact generator tests exercised the changed path without starting a local Hub stack.
- [ ] `bin/agent-validate-shift` — equivalent full gate passed with visual and benchmark checks skipped.

## Open items / handoff

- Add the PR and post-merge targeted fleet QA evidence after deployment.
- Very short password field maxima can only produce low-entropy QA values; keep those app instances isolated to QA.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| wrap | security and code quality | independent subagent | No blocking correctness issue. Flagged short maxima as low strength and suggested broader wiring coverage; source wiring and exact inline generator behavior are tested. |
