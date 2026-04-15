# PR #370 review fix spec

## Objective
Harden the Linux Docker auto-install flow in the desktop app so privilege escalation, installer execution, permission changes, and post-install UX are safe and diagnosable. The fixes must address the six Copilot review comments without changing the intended one-click install experience on Linux.

## Behaviour spec

### 1. Safe username resolution
- The desktop installer must resolve the current non-root username from the current UID, not from the `USER` environment variable.
- The resolved username must be passed into the privileged script as a separate argument, not interpolated into a root shell command string.
- If the username cannot be resolved, the install command must fail with a targeted error.

### 2. Robust installer execution
- The privileged script must not use `curl | sh`.
- It must download the Docker installer to a unique temporary file, fail fast on download errors, execute that file, and clean it up on exit.
- The script must enable strict shell error handling so pipeline and unset-variable failures are surfaced.

### 3. Unique temporary wrapper script
- The desktop app must create the wrapper script using a unique temporary file path.
- The wrapper script must be cleaned up even if `pkexec` fails.
- Parallel installs must not collide on the same temp file path.

### 4. Correct permission handling
- The wrapper script executable bit must be set via Rust filesystem permissions, not by spawning `chmod` and ignoring exit status.
- Permission-setting failures must abort the install with a clear error.

### 5. Better pkexec diagnostics
- The desktop app must detect missing `pkexec` before attempting installation and return a targeted message suggesting polkit installation.
- If the privileged command fails, stderr/stdout must be surfaced in the error message (trimmed), while preserving a dedicated cancellation/authorization-denied message.

### 6. Post-install frontend handling
- After installation succeeds, the frontend must poll Docker access for a short period instead of checking once immediately.
- The probe must distinguish:
  - Docker ready and usable → success state
  - Docker daemon reachable but current user lacks permission → needs logout state
  - Docker daemon still starting/unreachable → keep polling, then show a daemon-starting message if timeout expires
  - Other failures → error state with diagnostic message

## Acceptance criteria
- Given a malicious `USER` env var, when Docker install is triggered, then no root shell injection path exists.
- Given the Docker installer download fails, when the install runs, then the Tauri command returns an error instead of false success.
- Given two installs run concurrently, when each creates temp files, then their wrapper file paths do not collide.
- Given setting the executable bit fails, when the wrapper script is prepared, then the install aborts with a surfaced error.
- Given `pkexec` is missing or polkit auth is denied, when install is triggered, then the user gets a targeted, actionable error.
- Given Docker install returns before the daemon is fully ready, when the frontend evaluates post-install state, then it polls before deciding and does not immediately misclassify the result as logout-required.

## Implementation design
- `packages/desktop/src-tauri/src/hub_manager.rs`
  - Add helpers for executable lookup, username resolution, permission setting, command output summarising, Docker access classification, and hardened Linux install flow.
  - Introduce a serializable Docker access state enum/struct for the frontend.
- `packages/desktop/src-tauri/src/main.rs`
  - Expose a new Tauri command that returns the richer Docker access state.
- `packages/frontend/src/components/hub-status/hub-status.tsx`
  - Replace the single post-install availability check with a polling helper and richer state handling.
  - Add a dedicated daemon-starting state/message.
- `packages/frontend/src/components/hub-status/hub-status.test.tsx`
  - Add regression tests for the post-install polling logic.

## Risks
- Docker CLI stderr varies by distro/version, so permission/daemon detection needs conservative pattern matching.
- Manual end-to-end verification of the Linux pkexec flow requires a Linux desktop with polkit and no Docker preinstalled; that may remain an explicit verification gap if unavailable locally.
