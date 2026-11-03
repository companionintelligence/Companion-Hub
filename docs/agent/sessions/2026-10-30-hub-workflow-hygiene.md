# Workflow hygiene for the release workflows

## Meta

| Field | Value                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slug  | `hub-workflow-hygiene`                                                                                                                                  |
| Date  | 2026-10-30                                                                                                                                              |
| Agent | Claude                                                                                                                                                  |
| Model | Sonnet 5.5                                                                                                                                              |
| Task  | Add a workflow guard that `pnpm test` runs, name the secrets each called workflow receives, give six workflows a read-only token, and add `SECURITY.md` |

## Goal

Every workflow in this repository runs only when someone dispatches it, so a check that lives in a workflow never runs on a push. Move the workflow rules into a script that the test suite runs, stop handing every secret to the workflows that the release calls, give the six workflows that declare no `permissions` a read-only token, and add a security policy.

## Steps taken

1. Read `AGENTS.md`, the agent workflow, the script-authoring guide, the 21 workflows and the composite action, `release-workflows.test.ts`, and the source of `ci-local` to see what `restore` does to an `on:` block.
2. Recorded the baseline at `origin/dev` f950628aa before the first edit: the set of files with Biome diagnostics (143), the one failing script test, and the other gates.
3. Parsed every workflow with the backend's `yaml` package in a throw-away probe, outside the diff, to confirm which workflows lack a top-level `permissions`, which jobs lack their own, and which secrets each called workflow reads.
4. Replaced the three `secrets: inherit` lines: two became named maps, one was deleted because the end-to-end workflow reads no secret. Declared the names in both callees.
5. Added `permissions: contents: read` to the six workflows after reading each for token use and registry pulls.
6. Wrote the guard as a text reader, with a fixture or an inline workflow for each shape it must read, and ran it on the real tree: four job gaps, which the allow-list covers, and 122 references by tag, which are report-only.
7. Planted 100 defects in the guard, one at a time, added tests for the ones the suite missed, and closed two ways to hide a trigger or a hand-over (an alias in the triggers, a merge key in a job).
8. Wrote `SECURITY.md` in its own commit and linked it.

## Decisions

| Decision                                                                                                           | Rationale                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The guard reads the files as text, not YAML.                                                                       | Root `scripts/` cannot import `yaml`, and adding it would change `pnpm-lock.yaml`. A shape the reader cannot read is reported, never passed.                                                                                                              |
| `unpinned-uses` is report-only.                                                                                    | All 122 third-party references are still tags or branches. The next change pins them and turns the rule into an error.                                                                                                                                    |
| A sixth rule, `secret-map`, compares each call with the workflow it calls.                                         | Named lists can drift in ways `inherit` could not: a name the callee reads but the call does not pass arrives empty, and a name passed but not declared stops the run from starting. No push exercises either, so the check has to run in the test suite. |
| The four release-job gaps go into the allow-list with a reason instead of getting permission blocks.               | A calling job can only lower the token the called workflow gets, and these workflows publish images, releases, and packages, so a change needs a dispatch rehearsal that cannot be run here. The list can only shrink.                                    |
| The new `on.workflow_call.secrets` declaration is not copied into the commented triggers of `build-container.yml`. | Those blocks are generated by `ci-local` and off limits. A comment next to the declaration says to copy it there before a `ci-local restore`, which would otherwise drop it.                                                                              |
| Declared secrets are `required: false`.                                                                            | A missing secret then fails in the step that needs it, with that step's message, and the Sentry names stay optional.                                                                                                                                      |
| `SECURITY.md` is its own commit and names no new mailbox.                                                          | It names a reporting route, so it must not merge before the owner has switched the route on or named a contact.                                                                                                                                           |
| `docs/agent/TEST_INVENTORY.md` is not regenerated.                                                                 | It is already stale at the base, so regenerating would pull unrelated rows into this change.                                                                                                                                                              |

## Files touched

- `scripts/check-workflow-hygiene.ts`, `scripts/__tests__/check-workflow-hygiene.test.ts`, and `scripts/__tests__/fixtures/workflow-hygiene/`: the guard, its tests, and nine fixtures.
- `.github/workflow-hygiene.allow.json`: the four baseline entries.
- `.github/workflows/`: `desktop-release.yml`, `nightly-release.yml`, `build-container.yml`, and `publish-package-managers.yml` for the secret maps; `desktop-tests.yml`, `e2e.yml`, `e2e-extended.yml`, `e2e-mcp.yml`, `e2e-platform.yml`, and `style-canon-lint.yml` for the token; `ci.yml` for the guard step; `README.md` for the rules.
- `package.json`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/DEVELOPMENT_SETUP.md`, and `docs/system/e2e.md`.
- `SECURITY.md`, linked from `README.md`, `CONTRIBUTING.md`, and `docs/README.md`.
- `docs/agent/sessions/`, `docs/agent/WORKFLOW_FEEDBACK.md`, and `TODO.md`.

## Tests run

- [x] `HUSKY=0 pnpm install --frozen-lockfile && pnpm --filter common build`: exit 0.
- [x] `pnpm run check:workflows`: 0 findings, 4 allow-listed, 122 report-only.
- [x] `pnpm exec vitest run --config scripts/vitest.config.ts scripts/__tests__/check-workflow-hygiene.test.ts`: 1 file, 185 tests passed.
- [x] `pnpm exec biome ci --error-on-warnings --no-errors-on-unmatched` on the two new files: zero diagnostics.
- [x] `pnpm run lint:ci`: red before and after, for reasons outside this change. The set of files with diagnostics is identical to the base (143 files, 142 errors and 6 warnings), and every new or changed file outside that set has zero diagnostics.
- [x] `pnpm run tsc`: 3 tasks successful. `scripts/` is not covered by it, so the two new files were also checked with the root settings in a throw-away tsconfig outside the repository: 0 errors.
- [x] `TURBO_FORCE=true pnpm run test`: the turbo leg ran for real (5 tasks, none cached): `backend` 10521 passed and 2 skipped, `frontend` 3641 passed and 2 skipped, `common` 475 passed, `openclaw-plugin` 44 passed. `test:cli`: 1 failed, 3358 passed, and 32 skipped in 134 files. The one failure, `qa-stream-compose-retry.test.ts`, also fails at the base.
- [x] `pnpm run test:entrypoint`: 17 passed. `pnpm run test` does not reach it while `test:cli` fails, so it ran on its own.
- [x] `pnpm run knip:ci`: exit 0.
- [ ] `bin/agent-validate-shift`: not run as one command. Its first step is `lint:ci`, which is red at the base, so it would stop there. Its components were run separately and compared with the base as sets.
- [ ] App run (`pnpm run local`), integration tests, `actionlint`, and every workflow dispatch: not run. There is no Docker or GUI here, `actionlint` is not a dependency, and the release workflows publish.

## Open items / handoff

- Switch on private vulnerability reporting or name a contact before `SECURITY.md` merges.
- Rehearse a dispatch of `desktop-release.yml` (environment `dev`, a prerelease) before the next real release. Which of the eight secret names live at the organization, repository, or environment level is not known from the repository, and a name that exists only as an environment secret reaches the called workflow as an empty value from the caller.
- Narrow the four allow-listed jobs after the rehearsal, and remove each entry as you do.
- The next change pins the actions and turns `unpinned-uses` into an error.

## Reviews run

| Phase | Persona  | Model | Notes                                                                                                                     |
| ----- | -------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| wrap  | security | none  | `bin/agent-review --phase wrap --persona security` only prints a prompt. Not run; the prompt is in the pull request text. |
