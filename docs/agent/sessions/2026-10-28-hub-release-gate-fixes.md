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
4. Added an OOBI response DTO and regenerated Swagger plus the frontend API client.
5. Ran the end-of-shift validation and requested independent security and code-quality reviews.
6. The first remote integration run exposed two stale identity expectations; updated the database-backed integration tests to assert the same CESR-derived fields as the unit tests.

## Decisions

| Decision | Rationale |
|---|---|
| Import KERI modules through explicit subpaths | The repository lint rules reject barrel files, while consumers still need stable package exports. |
| Keep transfer and duplicate-binding cases separate | A settled transfer clears the previous binding; a transient duplicate must remain attributable to both target hosts. |
| Generate the OOBI response from a DTO | Swagger and the generated frontend client should expose the actual response shape. |

## Files touched

- Hub workspace test dependency ordering, KERI package exports/imports, and tests.
- OOBI Swagger response and generated frontend API client.
- `docs/agent/sessions/` and `docs/agent/WORKFLOW_FEEDBACK.md`.

## Tests run

- [x] `bin/agent-validate-shift --skip-visual --skip-benchmark` — passed lint, typecheck, unit/CLI/entrypoint tests, and OpenAPI drift validation.
- [x] `pnpm run check:openapi` — passed after regenerating Swagger and the frontend API client.
- [x] `pnpm --filter @ci-hub/common check-exports` — passed.
- [x] `pnpm tsx scripts/verify-keri-toip.ts` — all seven checks passed.
- [x] `pnpm run knip:ci` — completed without errors; reported seven configuration hints.
- [ ] App run — not available because the local Colima Docker socket is absent.
- [ ] Container-backed integration tests — the first GitHub Actions run found two stale integration expectations; they are fixed in a follow-up commit and need a rerun.

## Open items / handoff

- Wait for PR CI integration, image boot, desktop, and mobile workflows.
- Store-signed Android AAB and iOS IPA builds require signing credentials that were absent from the latest mobile build.
- The local OOBI controller currently returns placeholder key and KEL-digest strings; do not treat its response as cryptographic trust evidence until backed by a persisted KERI identity.

## Reviews run

| Phase | Persona | Model | Notes |
|---|---|---|---|
| Wrap | Security | Independent agent | No actionable findings. |
| Wrap | Code quality | Independent agent | Two findings were addressed; follow-up review found no new actionable issues. |
