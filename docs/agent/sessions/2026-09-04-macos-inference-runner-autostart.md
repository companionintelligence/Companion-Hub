## Meta

| Field | Value |
|-------|-------|
| **Slug** | `macos-inference-runner-autostart` |
| **Date** | 2026-09-04 |
| **Agent** | Codex |
| **Model** | GPT-5 |
| **Task** | Improve mlx-dspark and MTPLX automatic installation/startup and open a follow-up PR |

## Goal

Make the Apple Silicon FTUE install only the selected inference stack, provision compatible
Python environments and authenticated host runners, and keep Hub-managed mlx-dspark or MTPLX
running across login and process failures without making onboarding depend on every optional runner.

## Steps taken

1. Audited the existing FTUE-to-Tauri runner boundary and the current mlx-dspark/MTPLX server contracts.
2. Added exact backend install sets, Python-version repair/install, private runner credentials, and macOS LaunchAgent lifecycle management.
3. Passed managed credentials through backend probes, model administration, standardized app env, and direct sibling-app credentials.
4. Added focused frontend/backend/Rust tests, updated system docs, built both web packages, and smoke-tested the running preview.

## Decisions

| Decision | Rationale |
|----------|-----------|
| Stack this branch on `feat/speculative-inference-backend` | Keep the follow-up review focused while PR #1204 owns the FTUE/backend foundation. |
| Install only the selected chat runner plus Ollama | Avoid unrelated multi-engine downloads; Ollama remains the shared embeddings provider. |
| Use one private key per Hub-managed MLX runner | Both servers bind to the host gateway for Docker access, so unauthenticated all-interface listeners are unsafe. |
| Use a per-user LaunchAgent on macOS with detached-process fallback | Supplies login/crash recovery without requiring elevation and preserves best-effort FTUE behavior if registration fails. |
| Require Python 3.10+ for mlx-dspark and 3.11+ for MTPLX | Match upstream runtime constraints and repair stale Hub-owned virtual environments automatically. |

## Files touched

- `packages/desktop/src-tauri/src/inference_runners.rs`
- `packages/frontend/src/lib/inference/auto-inference-runners.ts`
- `packages/backend/src/modules/inference/managed-runner-auth.ts`
- Inference backend/env/credentials implementations and focused tests
- `docs/system/backend.md`, `docs/system/desktop.md`, `docs/system/frontend.md`

## Tests run

- [x] Targeted `biome check`
- [x] Backend and frontend type checks
- [x] 93 focused backend tests
- [x] 26 focused FTUE/frontend tests
- [x] 212 desktop tests
- [x] Backend and frontend production builds
- [x] Running preview + API proxy smoke (`http://127.0.0.1:5025`, both HTTP 200)
- [x] `bin/agent-validate-shift --skip-visual --skip-benchmark` (4,874 workspace tests; OpenAPI clean)

## Open items / handoff

- The PR is intentionally stacked on #1204; retarget it to `dev` after #1204 merges.
- Tests validate LaunchAgent rendering/reconciliation without installing or replacing a real host service.
- Linux systemd and Windows service persistence remain separate follow-ups; their current detached lifecycle is unchanged.

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Research | Maintainability | Codex | Verified current ownership boundaries and avoided changing the dirty primary checkout. |
| Plan | Security | Codex | Added key storage/auth propagation and avoided shell interpolation. |
| Implementation | Security + maintainability | Codex | Checked key permissions/redaction, exact LaunchAgent ownership, fallback behavior, docs, and focused tests. |
| Wrap | Security + code quality | Codex | Re-ran the repository review prompts, closed the atomic service-file permission gap, scanned the diff for credentials, and passed the full validation gate. |
