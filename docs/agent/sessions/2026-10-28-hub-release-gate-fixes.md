# Hub release-gate fixes

## Meta

| Field | Value |
|---|---|
| Slug | `hub-release-gate-fixes` |
| Date | 2026-10-28 |
| Agent | Codex |
| Task | Repair Hub CI blockers and validate the release candidate |

## Goal

Make the current Hub `dev` branch pass its local release gates, correct the CI and package-export failures, and validate the changed API contract before opening a PR.

## Steps taken

1. Built shared workspace packages before backend, frontend, and integration tests that import their generated output.
2. Replaced KERI barrel imports with explicit package subpaths and added wildcard package exports; aligned stable-identity expectations with the CESR digest implementation.
3. Kept the settled custom-domain transfer assertion and added separate coverage for duplicate stored bindings.
4. Corrected the OOBI API contract, then disabled publication and resolution until the Hub can serve a persisted KERI key event log; regenerated Swagger and the frontend API client.
5. Ran the end-of-shift validation and requested independent security and code-quality reviews.
6. The first remote integration run exposed two stale identity expectations; updated the database-backed integration tests to assert the same CESR-derived fields as the unit tests.
7. Added controller coverage to ensure OOBI endpoints fail closed instead of returning fabricated identity data.

## Decisions

| Decision | Rationale |
|---|---|
| Import KERI modules through explicit subpaths | The repository lint rules reject barrel files, while consumers still need stable package exports. |
| Keep transfer and duplicate-binding cases separate | A settled transfer clears the previous binding; a transient duplicate must remain attributable to both target hosts. |
| Do not publish an OOBI without a persisted, verifiable KERI log | Placeholder keys, digests, and AIDs could be mistaken for cryptographic trust evidence. |

## Files touched

- Hub workspace test dependency ordering, KERI package exports/imports, and tests.
- OOBI endpoints, tests, Swagger response, and generated frontend API client.
- `docs/agent/sessions/` and `docs/agent/WORKFLOW_FEEDBACK.md`.

## Tests run

- [x] `bin/agent-validate-shift --skip-visual --skip-benchmark` — passed lint, typecheck, unit/CLI/entrypoint tests, and OpenAPI drift validation.
- [x] `pnpm run check:openapi` — passed after regenerating Swagger and the frontend API client.
- [x] `pnpm run tsc` in `packages/backend` — passed after the OOBI fail-closed change.
- [x] `pnpm exec vitest run src/modules/auth/__tests__/oobi.controller.test.ts` — two tests passed.
- [x] `pnpm run lint:ci` — passed after formatting the OOBI controller.
- [x] `pnpm --filter @ci-hub/common check-exports` — passed.
- [x] `pnpm tsx scripts/verify-keri-toip.ts` — all seven checks passed.
- [x] `pnpm run knip:ci` — completed without errors; reported seven configuration hints.
- [ ] Local app run — unavailable because the local Colima Docker socket is absent; GitHub Actions image boot succeeded on the prior PR commit and must be repeated on this follow-up commit.
- [x] Container-backed integration tests — passed in GitHub Actions after correcting the stale database-backed identity expectations.

## Open items / handoff

- Wait for PR CI, image boot, desktop, and mobile workflows on the latest follow-up commit.
- Store-signed Android AAB and iOS IPA builds require signing credentials that were absent from the latest mobile build.
- OOBI endpoints now return HTTP 503 until the Hub can persist, verify, and serve real KERI key event logs; peer discovery remains unavailable until that implementation exists.

## Reviews run

| Phase | Persona | Model | Notes |
|---|---|---|---|
| Wrap | Security | Independent agent | No actionable findings. |
| Wrap | Code quality | Independent agent | Two findings were addressed; follow-up review found no new actionable issues. |
