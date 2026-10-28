# Fleet QA Browser Capture Reliability

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `fleetqa-browser-capture-reliability` |
| **Date** | 2026-10-28 |
| **Agent** | Codex |
| **Model** | GPT-6 |
| **Task** | Improve fleet QA reliability while rerunning app, LLM, agent, and pool checks |

## Goal

Make app screenshots reliable for SPAs and apps with long-lived connections, keep each browser capture bounded, and pass the installed Hub checkout to the remote runner so the same QA code works on fleet nodes.

## Steps taken

1. Refreshed production catalog, current app campaign, latest LLM and agent runs, and benchmark history.
2. Added a Playwright capture path that waits for DOM content and bounded visible UI rendering, uses an overall deadline, and terminates Chromium if cleanup hangs.
3. Wired `QA_HUB_ROOT` into the remote fleet runner and updated command coverage for the new internal variable.
4. Ran focused tests, strict helper type checking, and real-browser smoke tests with an asynchronously rendered SPA and open SSE.
5. Rebased both changes onto the latest `origin/dev` and `origin/main`; cross-agent wrap review found issues that were fixed and retested.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Resolve `@playwright/test` from `QA_HUB_ROOT` and retain the CLI fallback | Fleet nodes install Playwright in the Hub checkout; partial setups still have the existing browser CLI path. |
| Wait for visible content after `DOMContentLoaded`, with explicit time bounds | `load` and `networkidle` can stay open forever, while SPAs can render after DCL. |
| Run Chromium through `launchServer` and force-kill after bounded graceful cleanup | A stuck renderer or close call must not hold a worker indefinitely. |

## Files touched

- `scripts/qa-stream.ts`
- `scripts/__tests__/qa-stream-screenshot.test.ts`
- `docs/system/e2e.md`
- `docs/system/agent-qa.md`
- Companion CI-Engineering worktree: `tools/fleet-qa/scripts/lib/harness-env.ts`, `tools/fleet-qa/test/harness-env.test.mjs`, `tools/fleet-qa/test/remote-runner-stop.test.mjs`, and `tools/fleet-qa/test/capacity-guard.test.mjs`
- `docs/agent/WORKFLOW_FEEDBACK.md`

## Tests run

- [x] Focused Vitest screenshot tests: 13 passed.
- [x] Strict TypeScript check of the capture helper and its interfaces.
- [x] Real Chromium smoke: delayed SPA render captured with an SSE request still open; empty SPA remained a screenshot warning after the bounded wait.
- [x] Changed-file Biome check and `git diff --check`.
- [x] CI-Engineering focused Node tests: 33 passed.
- [ ] `bin/agent-validate-shift`: stopped before lint because pnpm tried to replace a shared `node_modules` symlink and refused in the non-interactive session. The symlink remains intact.
- [ ] Full CI-Engineering suite: the current run loaded the old capacity-guard assertion before it was updated; rerun the full suite after this run finishes.
- [ ] Local `pnpm run local`: not run for this script-only change; the live fleet app campaign is exercising the existing Hub runtime.

## Open items / handoff

- The production-style app campaign `fleet-apps-1793148231255` is still running on core-17 and beta-ms-a2. At the latest checked snapshot it had 87 of 524 selected apps with 39 pass, 42 screenshot warnings, 6 skips, and no failures. It uses the previously copied harness; do not overwrite its `/tmp/qa-stream.ts` while it runs.
- Recheck the full CI-Engineering suite log after the current run finishes, rerun it with the updated assertion, then publish the paired pull requests.
- After the active app run completes, retest screenshot-warning IDs with the improved harness and continue coverage for the remaining store entries and eligible fleet nodes.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Wrap | Security and code quality | GPT-6 Astra | Review identified bounded-render, cleanup, Playwright argument-position, and late-rejection issues. All were fixed; final review reported no remaining actionable findings. |
