# QA Start Timeout and Cleanup Reliability

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `qa-start-timeout-cleanup` |
| **Date** | 2026-10-27 |
| **Agent** | Codex |
| **Model** | GPT-6 |
| **Task** | Prevent ambiguous Docker start timeouts and stuck command cleanup during Marketplace QA |

## Goal

Make the QA runner report local command deadlines reliably, avoid retrying Docker starts when the daemon may already own the run-scoped name, and retry transient readiness or Compose failures only after proving that the prior run's Docker resources are gone.

## Steps taken

1. Reproduced the retry failure on beta-red: a Docker start timeout could leave a run-scoped container, then the retry replaced the original timeout with a container-name conflict.
2. Made process-local deadline state authoritative. Compose output containing `ETIMEDOUT` no longer misclassifies a completed network failure as a timed-out local process.
3. Replaced the callback command runner with a spawned process that kills its POSIX process group, closes inherited output pipes, and settles independently when the deadline fires.
4. Added cleanup checks for Compose containers, networks, volumes, and the exact run-scoped container before retrying readiness, Compose, or host-port failures.
5. Marked deadline timeouts, output overflow, signal termination, and signal-style exit codes as interrupted; retries are suppressed for those command outcomes.
6. Added injected retry and cleanup tests plus a real subprocess test whose background child keeps stdout/stderr open after its shell exits.
7. Ran the complete `scripts` Vitest suite, changed-file Biome, and `git diff --check`.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Trust only the runner's explicit deadline flag when classifying a process timeout | Error codes and Compose output can report network `ETIMEDOUT` without the local command deadline firing. |
| Do not retry a timed-out Docker start under the same resource name | The Docker daemon may have created the named container before the CLI timed out. |
| Require all cleanup queries to succeed and return empty output before retry | A best-effort `compose down` does not prove the prior container, network, or volume is gone. |
| Kill the process group and settle without waiting for stream closure | Descendant processes may inherit stdout/stderr and keep Node's `close` event pending indefinitely. |

## Files touched

- `scripts/qa-stream.ts`
- `scripts/__tests__/qa-stream-compose-retry.test.ts`
- `docs/system/agent-qa.md`
- `TODO.md`
- `docs/agent/WORKFLOW_FEEDBACK.md`
- `docs/agent/sessions/2026-10-27-qa-start-timeout-cleanup.md`
- `docs/agent/sessions/2026-10-27-qa-start-timeout-cleanup-feedback.md`

## Tests run

- [x] Focused retry and timeout tests: 21 passed, including a real shell with a background child holding inherited pipes and signal/output interruption cases.
- [x] Full `scripts` Vitest suite: 130 files passed; 3,145 passed and 32 skipped.
- [x] Changed-file Biome check.
- [x] `git diff --check`.
- [ ] Full `bin/agent-validate-shift`: stopped at the workspace package-manager guard because pnpm refused to replace the shared `node_modules` symlink in a non-interactive worktree. The symlink was preserved.
- [ ] Targeted TypeScript check: ran against the runner and test. It still reports existing errors in `qa-mcp.ts` and unrelated `qa-stream.ts` error/manifest fields; no diagnostics point to the command runner, interrupted-state policy, or new test helpers.
- [ ] Fleet retest using this revised runner: existing live campaigns use the previously copied runner and must be completed before replacing it on a node.

## Open items / handoff

- Follow-up PR [#2171](https://github.com/companionintelligence/Companion-Hub/pull/2171) is open against `dev`; CI status had not populated at the last check.
- Keep active fleet checkouts on `dev`, per the user's direction.
- The campaign that reported `tldraw`, `xyops`, and `bytebase` start/name conflicts used the old runner. Those results remain historical failures; retest those IDs with the revised runner after the current campaigns complete.
- Other fleet campaigns still have many selected IDs idle, plus screenshot warnings and declared skips. This change alone does not establish Marketplace promotion readiness.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Wrap | Retry and cleanup reliability | Tesla | Review identified deadline reporting, output bounds, retry suppression for interrupted commands, and cleanup verification gaps; all were addressed. Final review found no remaining actionable issues. |
