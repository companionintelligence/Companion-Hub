# Freeze the in-tree KERI module

## Meta

| Field | Value                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slug  | `hub-keri-freeze`                                                                                                                                       |
| Date  | 2026-10-30                                                                                                                                              |
| Agent | Claude                                                                                                                                                  |
| Model | Sonnet 5.5                                                                                                                                              |
| Task  | Freeze the in-tree KERI module, stop emitting label-derived `did:keri:` strings in forward auth, and delete a visitor's AID headers at the Traefik edge |

## Goal

Stop presenting hashes of public text labels as if they were key-derived identifiers. Mark the in-tree KERI module as not interoperable, keep it, and record the published reference-vector result in a test so the claim stays checked. Keep true, in a sentence and a test, that the Hub has no authority over identity bindings.

## Steps taken

1. Read `AGENTS.md`, the agent workflow, `docs/system/backend.md`, the module, the forward-auth resolver and signing helper, and the three copies of the Traefik header list.
2. Recorded the baseline at `origin/dev` f950628aa before the first edit: the set of files with Biome diagnostics, `tsc`, the unit, CLI, and entrypoint tests, `check:openapi`, and `knip`.
3. Re-derived the published example for code `B` with an independent encoder of the published rule, and confirmed the module's encoder gives a different string for the same key.
4. Made `stableIdFor` return the issuer and the id only, and rewrote the doc comments on the reserved AID fields and header names.
5. Listed the three reserved AID header names in both compose copies and `dynamic.yml`, extended `EXPECTED_HEADERS`, regenerated the desktop compose copy, then regenerated the bundled assets module last.
6. Added a banner to each of the seven module files, `FROZEN.md`, the reference-vector test, and the import guard, and renamed the test title and script banner so they say what they assert.
7. Added the identity-binding invariant test and the two documentation sentences.
8. Planted each defect the new checks exist to catch, saw the check fail, removed the plant, and saw it pass.

## Decisions

| Decision                                                                                                       | Rationale                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the three header constants and the optional `userAid`, `hubAid`, and `kelDigest` fields, marked reserved  | Nothing that builds or verifies headers breaks, and a later change that has a real key event log has a place to put the values.                                                                                     |
| List the reserved names in `authResponseHeaders`                                                               | On a route with the `ci-hub` middleware, Traefik deletes each listed name from the forwarded request before copying the reply's values, so a visitor's copy does not reach the app. Not run against Traefik.        |
| The controller cases run the real resolver on a fake directory                                                 | The controller's resolver is a mock everywhere else in that file, and a mock only echoes what a test hands it, so it could never fail when the resolver starts deriving an AID again.                               |
| The import guard also flags relative paths into the module, with one named exception that must still import it | A guard that only looks for the package path is sidestepped by a `../` import. The exception is a standalone script that exercises the module itself, and the stale-entry check keeps the list honest.              |
| `FROZEN.md` tags only the code `B` example as verified                                                         | The other differences (digest code, signature code, event field order, version string size meaning) come from the published specification text and were not exercised by a test here, so they carry a `[docs]` tag. |
| Do not regenerate `docs/agent/TEST_INVENTORY.md`                                                               | It is already about 100 rows stale at the base, so regenerating would pull unrelated rows into this change.                                                                                                         |
| Leave the OOBI controller and the "KERI / Trust Over IP" Swagger tag alone                                     | The controller is already honest, and renaming the tag regenerates the client for no gain.                                                                                                                          |

## Files touched

- `packages/backend/src/modules/auth/`: the resolver, the signing helper (comments only), and their tests, including the new controller cases and the renamed titles in `keri-toip.test.ts`.
- `packages/backend/src/tests/`: `traefik-forward-auth-config.test.ts` and the integration expectation in `integration/forward-auth-identity.test.ts`.
- `packages/common/src/keri/`: a banner in each of the seven files, a corrected header comment in `cesr.ts`, `FROZEN.md`, and `__tests__/reference-vector.test.ts`.
- `scripts/`: `__tests__/keri-import-guard.test.ts`, `__tests__/hub-binding-authority.test.ts`, the banner in `verify-keri-toip.ts`, and the regenerated `lib/bundled-hub-assets.generated.ts`.
- `docker-compose.prod.yml`, its regenerated desktop copy, and `packages/backend/assets/traefik/dynamic/dynamic.yml`.
- `docs/system/backend.md` and `docs/security/hub-portal-trust.md`.
- `docs/agent/sessions/`, `docs/agent/WORKFLOW_FEEDBACK.md`, and `TODO.md`.

## Tests run

- [x] `pnpm run lint:ci`: red before and after, for reasons outside this change. The set of files with diagnostics is identical to the base (143 files, 142 errors and 6 warnings), and every changed file outside that set has zero diagnostics.
- [x] `pnpm run tsc`: 3 tasks successful, none from cache.
- [x] `pnpm run test`: `common` 479 passed, `backend` 10528 passed and 2 skipped, `frontend` 3641 passed and 2 skipped, `openclaw-plugin` 44 passed, `test:cli` 3187 passed and 32 skipped with 1 failed. The failure, `qa-stream-compose-retry.test.ts`, is the same one that fails at the base.
- [x] `pnpm run test:entrypoint`: 17 passed. `pnpm run test` does not reach it while `test:cli` fails, so it ran on its own.
- [x] `pnpm run check:openapi`: passed.
- [x] `pnpm run knip:ci`: exit 0.
- [x] `pnpm exec tsx scripts/generate-bundled-hub-assets.ts --check`: current.
- [x] `pnpm exec tsx scripts/verify-keri-toip.ts`: all seven round trips passed.
- [ ] `bin/agent-validate-shift`: not run as one command. Its first step is `lint:ci`, which is red at the base, so it would stop there. Its four component commands were run separately and compared against the base as sets.
- [ ] App run (`pnpm run local`): not run. There is no Docker or GUI session here.
- [ ] `pnpm run test:integration`: not run, for the same reason. The integration expectation was edited by reading.

## Open items / handoff

- The change touches the forward-auth response headers, so it needs the Hub security reviewer before merge.
- Whether `@ci-hub/common` is published to a registry is UNKNOWN. If it is, the banners ship in the compiled output. `FROZEN.md` would not, because the package `files` list holds only `dist`.
- `docs/agent/TEST_INVENTORY.md` is stale at the base and was not regenerated.
- Traefik was not run. That it deletes a listed name from the forwarded request is taken from the repository's own documentation of the label.

## Reviews run

| Phase | Persona  | Model   | Notes                                                                                                                        |
| ----- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Wrap  | Security | Not run | The prompt from `bin/agent-review --phase wrap --persona security` is in the PR text, to run in a different model's session. |
