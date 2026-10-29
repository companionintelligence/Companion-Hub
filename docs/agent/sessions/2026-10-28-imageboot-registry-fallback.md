# Hub image boot registry fallback

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `imageboot-registry-fallback` |
| **Date** | 2026-10-28 |
| **Agent** | Codex |
| **Model** | GPT-6 |
| **Task** | Make Hub image-boot verification resilient to registry-specific pull failures. |

## Goal

Avoid treating a transient registry failure as a Hub image boot failure while keeping the smoke test strict when neither source can provide its dependency images.

## Steps taken

1. Changed Docker Hub to the primary Postgres and RabbitMQ source, with public ECR as fallback.
2. Kept three retries per source and surfaced Docker's pull errors in the workflow log.
3. Documented the image override variables and verified fallback behavior with a mocked Docker CLI.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Retry the primary registry before falling back. | Preserve the configured source when it is healthy and tolerate temporary registry outages. |
| Fail only after both image sources fail. | Keep the boot gate meaningful while distinguishing registry availability from Hub startup. |

## Files touched

- `scripts/smoke-boot-image.sh`
- `docs/system/e2e.md`
- `docs/agent/sessions/2026-10-28-imageboot-registry-fallback.md`
- `docs/agent/sessions/2026-10-28-imageboot-registry-fallback-feedback.md`
- `docs/agent/WORKFLOW_FEEDBACK.md`

## Tests run

- [x] `bash -n scripts/smoke-boot-image.sh`
- [x] Mocked Docker CLI: verified primary pull failures use the ECR fallback for both dependencies and the smoke script completes.
- [ ] GitHub Actions image-boot workflow — run on the PR branch; must pass before merge.
- [ ] `bin/agent-validate-shift` — not run; the local Docker daemon is stopped and the GitHub image-boot workflow provides the end-to-end container check.

## Open items / handoff

The current Hub release image-boot run failed twice while fetching Postgres from public ECR. This follow-up needs its own image-boot workflow run against the PR branch. The user's production `v0.3.8` release workflow is already running against the merged dev SHA and should not be restarted for this smoke-test-only improvement.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| | | | |
