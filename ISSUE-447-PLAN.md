## Plan: CI-Hub #447 Startup Pull Progress

Deliver an end-to-end startup-progress flow for first-run Hub launch so users get immediate, continuous feedback after clicking Start Hub while Docker images are pulled. The fix will preserve current CI-Hub architecture (Tauri desktop startup path + frontend hub-status gate) and add regression coverage that proves the issue is resolved in both automated and manual first-run scenarios.

Source verified via authenticated gh CLI:
- Issue URL: https://github.com/companionintelligence/CI-Hub/issues/447
- Label: bug
- State: OPEN
- Assignee: hanzlamateen
- Comments: none
- Project items: none

**Ticket coverage matrix (Issue #447)**
1. Ticket: UI remains on start screen after Start Hub click.
Plan coverage:
- Force immediate transition to explicit startup state in frontend, independent of slow backend/container readiness.
- Prevent poll-driven regression from Starting back to Stopped during in-flight startup.

2. Ticket: No visual feedback during initial image pull.
Plan coverage:
- Stream startup progress events from desktop compose execution.
- Render stage-based progress + current image/log context in Hub status UI.

3. Ticket: Progress appears only near completion.
Plan coverage:
- Emit events from the earliest startup stage (preparing + initial pull output), not only at the end.
- Add tests that assert progress is shown before terminal running state.

4. Ticket reproduction condition: first run with images absent.
Plan coverage:
- Include first-run manual validation with required images removed.
- Add deterministic test fixtures for early pull-line handling to verify behavior under cold-cache startup.

5. Ticket includes media evidence (video + screenshot) showing frozen start screen.
Plan coverage:
- Manual acceptance checklist explicitly includes confirming there is no frozen start screen period after Start Hub click.

6. Ticket comments requirements.
Plan coverage:
- No issue comments are present; no comment-derived behavior required.

**Steps**
1. Reconfirm issue boundaries in code-level acceptance criteria.
Dependency: none.
Actions:
- Convert #447 expectations into checkable outcomes: immediate transition, persistent progress visibility, no frozen start screen, eventual success/failure transition.
- Keep constraints from user decisions: stage-based progress, comments on modified/new functions only, desktop logs as logging sink.

2. Add startup session state in desktop runtime.
Dependency: step 1.
Actions:
- Introduce a startup session/state model in desktop Rust flow with explicit phases: preparing, pulling_images, starting_services, waiting_health, completed, failed.
- Ensure startup state is readable while startup is in progress and keyed to the current startup session.
- Keep START_IN_PROGRESS as concurrency guard and align status checks to in-flight startup semantics.
- Add/refresh Rust doc comments for every modified/new function.

3. Instrument compose execution for progressive updates.
Dependency: step 2.
Actions:
- Refactor startup compose invocation to process stdout/stderr incrementally (line-based) instead of completion-only output.
- Map line patterns to stage transitions and current image hints.
- Emit structured Tauri events from the startup pipeline from earliest startup moments.
- Continue detailed append-only writes to desktop.log for diagnostics and auditability.
- Use resilient parsing with fallback generic status text when line formats do not match known patterns.

4. Implement frontend startup-progress rendering.
Dependency: steps 2-3.
Actions:
- Update hub-status UI state machine to track in-flight startup session and prioritize event-driven startup state over transient stopped polls.
- Subscribe/unsubscribe to startup events using existing Tauri event pattern in frontend.
- Show stage-based text and current pull item while keeping current simple visual design.
- Preserve existing behavior for DockerNotAvailable, running mode, and non-Tauri web mode.
- Add/refresh TS comments/JSDoc on modified/new functions.

5. Harmonize polling with startup event stream.
Dependency: step 4.
Actions:
- Define precedence rules: startup session active => keep startup UI despite stopped container status until terminal event/timeout.
- Add safe timeout/recovery path for lost events.
- Ensure cleanup of listeners and startup session state on completion/failure/navigation.

6. Add comprehensive tests.
Dependency: steps 2-5.
Actions:
- Frontend unit tests in hub-status suite:
  - immediate startup UI after Start Hub click,
  - startup UI persists while status polling reports Stopped,
  - stage/event updates render,
  - terminal transitions to running/error.
- Desktop Rust tests in hub_manager suite:
  - line parser/stage mapping correctness,
  - startup session/state behavior while START_IN_PROGRESS true,
  - early-event emission semantics.
- Keep tests colocated with current patterns to match repo architecture.

7. Execute end-to-end validation gates.
Dependency: step 6.
Actions:
- Automated gate: all impacted frontend + desktop tests pass.
- Manual gate (cold start): remove the seven images listed in issue #447, launch app, click Start Hub, verify immediate transition and sustained progress visibility from early pull stage through completion.
- Regression gate: verify Windows auto-start path and DockerNotAvailable onboarding remain intact.
- Logging gate: verify desktop.log shows ordered startup milestones and useful failure diagnostics.

**Relevant files**
- /home/hanzlamateen/ci/CI-Hub/packages/frontend/src/components/hub-status/hub-status.tsx — Startup UI state machine and Start Hub flow.
- /home/hanzlamateen/ci/CI-Hub/packages/frontend/src/components/hub-status/hub-status.test.tsx — Primary regression test suite for this ticket.
- /home/hanzlamateen/ci/CI-Hub/packages/desktop/src-tauri/src/main.rs — Tauri commands and event emission integration points.
- /home/hanzlamateen/ci/CI-Hub/packages/desktop/src-tauri/src/hub_manager.rs — Startup orchestration, compose output handling, logging, startup state.
- /home/hanzlamateen/ci/CI-Hub/packages/frontend/src/modules/auth/pages/device-registration-page.tsx — Existing event listener lifecycle reference pattern.
- /home/hanzlamateen/ci/CI-Hub/docs/ARCHITECTURE.md — Architecture guardrails and startup lifecycle references.

**Verification**
1. Frontend automated checks (from CI-Hub root):
- `pnpm --filter @ci-hub/frontend test -- src/components/hub-status/hub-status.test.tsx`
- `pnpm --filter @ci-hub/frontend test`
- Require passing tests for new startup-progress scenarios and no regressions in existing hub-status behavior.
2. Desktop Rust automated checks (from CI-Hub/packages/desktop/src-tauri):
- `cargo test hub_manager`
- `cargo test`
- Require parser/state tests for startup session + progress mapping to pass.
3. Cold-start manual acceptance (issue reproduction path):
- Remove images:
  - `docker image rm cloudflare/cloudflared:2026.2.0 ghcr.io/companionintelligence/ci-hub:dev headscale/headscale:0.25.1 postgres:14 rabbitmq:4-alpine tailscale/tailscale:v1.82.5 traefik:v3.6.7`
- Launch desktop app.
- Click Start Hub.
- Verify immediate transition from start screen to startup-progress UI.
- Verify continuous stage updates during image pull (no frozen start screen window).
- Verify eventual running/dashboard state.
4. Regression acceptance:
- Validate Windows auto-start path still transitions correctly.
- Validate DockerNotAvailable guidance and recovery flow still function.
5. Logging acceptance:
- Inspect desktop log and confirm ordered startup milestones (`preparing`, `pulling_images`, `starting_services`, `waiting_health`, terminal success/error) with actionable diagnostics on failure.

**Decisions**
- Progress fidelity: stage-based status + current image/log context.
- Function comment scope: modified/new functions only.
- Logging scope: desktop logs as source of truth, concise UI text derived from progress events.
- Included scope: desktop startup + frontend startup UX + tests + comments/logging for touched code.
- Excluded scope: repo-wide documentation/comment sweep, backend SSE redesign, exact docker-layer percentage computation.

**Known constraints and assumptions**
- Issue Environment fields are placeholders (App Version/OS not specified). Validation must therefore include at least current dev workflow and specifically preserve Windows auto-start behavior already covered by existing tests.
- No issue comments exist at plan time; if comments are added before implementation, reconcile deltas before coding.