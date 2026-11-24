# Linux fleet TCP readiness probe

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `qa-procfs-probe` |
| **Date** | 2026-11-01 |
| **Agent** | Codex |
| **Model** | GPT-6 |
| **Task** | Make headless TCP service readiness evidence reliable for fleet QA |

## Goal

Allow the fleet QA runner to verify silent TCP services such as PostgreSQL and SQL Server without trusting executables supplied by the app image or accepting arbitrary lookalike SQL Server image names.

## Steps taken

1. Read container network namespace TCP tables from the Linux host through `/proc/<pid>/net`, using the PID reported by Docker; unsupported platforms and unreadable required evidence remain unknown.
2. Limit silent SQL Server image recognition to Microsoft's canonical repository paths.
3. Add tests for IPv4/IPv6 listener rows, malformed rows, official SQL Server references, and lookalike image paths; update the QA evidence documentation.
4. Run focused tests and the CI-Hub end-of-shift validation; review the patch independently.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Do not execute a reader inside the app container | The app image controls its own binaries and could fabricate procfs output. |
| Mark non-Linux host namespace access unknown | Docker Desktop's Linux VM procfs is not visible from macOS; uncertainty must not become a false pass. |
| Require canonical SQL Server image paths | A repository leaf named `mssql` or `sqlserver` is not protocol evidence. |

## Files touched

- `scripts/qa-stream.ts`
- `scripts/__tests__/qa-route-policy.test.ts`
- `docs/system/agent-qa.md`
- `docs/agent/sessions/2026-11-01-qa-procfs-probe.md`
- `docs/agent/sessions/2026-11-01-qa-procfs-probe-feedback.md`
- `docs/agent/WORKFLOW_FEEDBACK.md`

## Tests run

- [x] `pnpm exec vitest run scripts/__tests__/qa-route-policy.test.ts` — 18 passed
- [x] `pnpm run lint:ci` — passed through `pnpm run agent:validate --skip-visual --skip-benchmark`
- [x] `pnpm run tsc` — passed through the same validation
- [x] `pnpm test` — passed through the same validation (3,386 passed; 32 skipped)
- [x] App run — no UI/app change; exercised through the fleet QA dashboard and Linux host probe
- [x] System QA documentation updated
- [x] Session worksheet and feedback added
- [x] Independent security review; P2 findings fixed with tests
- [x] Secret scan by reviewing changed files; no credentials added
- [x] Scoped behavior tests added

## Open items / handoff

- The existing fleet PostgreSQL run was dispatched before this patch, so its outcome does not validate the new trusted-host probe. Retest PostgreSQL and SQL Server after the harness patch is committed and deployed to the dashboard's source.
- Production Marketplace sync, CI-OS amd64 build, and coordinated app release gates are tracked separately from this QA harness fix.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| wrap | security | independent subagent | Flagged arbitrary SQL Server image matching and image-provided `cat`; both addressed. Added coverage for SQL Server lookalike images and host-only procfs access. |
