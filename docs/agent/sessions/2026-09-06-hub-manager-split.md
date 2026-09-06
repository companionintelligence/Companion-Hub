# Session Worksheet — hub-manager-split

> Git tag after merge: `agent-session/hub-manager-split`

---

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `hub-manager-split` |
| **Date** | 2026-09-06 |
| **Agent** | Claude |
| **Model** | Opus 5 |
| **Task** | User request: do the Rust half of the Stage 1 refactor — split `hub_manager.rs` (11,338 lines). |

---

## Goal

Stage 1a, the last piece of the modularization program. It had been deferred twice because its
verification — the same tests passing before and after — needs `cargo test`, and this machine cannot
build the crate.

---

## What actually happened

**The refactor already existed.** Branch `claude/main-hub-logic-refactor-d5b338`, five commits dated
2026-09-05, sitting in a parallel worktree: never pushed, no PR, no worksheet. It splits
`hub_manager.rs` into 23 production modules plus a `tests/` tree, and it is good work — structurally
close to what the Stage 1 plan proposed, with the `include_str!` depths correctly re-based for the
extra directory level.

What it had never been is **verified**. It could not have been: `cargo test` fails on this machine in
`libdbus-sys` before compiling a line of crate code.

So the work of this session was not writing the refactor. It was building a way to verify it,
verifying it, reviewing it, and shipping it.

---

## Steps taken

1. Checked `origin/dev` — `hub_manager.rs` untouched since `ea2a7ca41`, so no conflict with the
   existing branch and no second implementation needed.
2. Established that the crate's bulk is Tauri-free: `hub_manager` and the six modules it depends on
   contain **zero** real `tauri::` references (the only matches are doc-comment prose).
3. Built a scratch crate from exactly those modules with only their real dependencies — no `tauri`,
   no GTK, and `rustls` instead of the default `native-tls` so no system OpenSSL either. It compiles
   and runs the tests on a machine with none of the GUI headers.
4. Ran it against `origin/dev` and against the refactor, and diffed the test-name sets.
5. Reviewed every file the branch touches outside `hub_manager`.
6. Rebased onto current `dev`, re-verified, and generalized the harness into a committed script.

---

## Verification

| | pre-refactor (`origin/dev`) | post-refactor |
|---|---|---|
| Compiles | yes | yes |
| Tests | 155 unique | 155 unique |
| Test-name diff | — | **identical: none added, none lost, none renamed** |
| `cargo fmt --check` | — | clean |

One test, `hub_watchdog_decision`, fails in the harness on both sides: `should_trigger_hub_watchdog`
calls `is_docker_available()`, which shells out to `docker`. It is environment-dependent, not a
regression, and it fails identically before and after — which is the whole reason the comparison is
run like-for-like rather than against an absolute "all green".

Module sizes after the split: 23 production files, largest 851 lines (`lifecycle.rs`), 9,882
production lines total against 11,338 in the single original file. `#[cfg(test)] mod tests;` keeps
the test tree out of release builds.

Reviewed outside `hub_manager`: `sentry_scrubber.rs`, `updater.rs`, and `main.rs` are touched only by
the `cargo fmt` commit — line wrapping, no logic. Verified by reading every hunk.

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| Adopt the existing branch rather than reimplement | A second implementation of an 11k-line move would conflict with the first and be no more correct. The missing ingredient was verification, not code. |
| Build a Tauri-free harness instead of waiting on system headers | Installing the GTK/WebKit stack needs root, and the blocker had already deferred this work twice. Since the modules in question have no Tauri dependency, the headers were never actually required to test them. |
| Compare test-name **sets**, not just counts | Equal counts can hide a lost test paired with a new one. Diffing the names makes "nothing was lost" checkable rather than asserted. |
| Exclude `hub_watchdog_decision` in the committed script, not silently | It shells out to Docker and would otherwise make the script look broken on any machine without a daemon. The script says so, and running without `--skip` shows it. |
| Keep the CI commit but flag it | See handoff — it is a spend decision, and not one to make silently inside a refactor. |
| Commit the harness as a script | The "can't test Rust locally" blocker is documented in `DEVELOPMENT_SETUP.md`; this removes it for the 155 tests that never needed the GUI stack. |

---

## Tests run

- [x] `packages/desktop/src-tauri/scripts/test-without-gui.sh` — 155 passed, 1 filtered
- [x] `… test-without-gui.sh origin/dev` — 155 passed, 1 filtered, identical name set
- [x] `cargo fmt --check` — clean
- [ ] `cargo test` (full crate, including `main.rs` / `tray.rs` / `commands/`) — **not run**, needs
      the GUI headers. `desktop-tests.yml` covers it on a runner that has them.
- [ ] App run — not possible here for the same reason

---

## Open items / handoff

**The CI commit is a spend decision and should be reviewed as one.** `ci(desktop): re-enable Rust
tests on desktop changes` restores a `pull_request` trigger on `desktop-tests.yml`, scoped to
`packages/desktop/src-tauri/**`. Every workflow in this repo is currently `workflow_dispatch`-only
because GitHub Actions cost the org $563/month (`docs/CI.md`). The scoping is sensible and the commit
argues its own case (~62 crate commits/quarter), but re-enabling any automatic trigger is a call for
whoever owns that budget. It is a single separable commit and can be dropped without touching the
refactor.

**The full crate is still unverified locally.** The harness covers 155 tests; `main.rs`, `tray.rs`,
and `commands/` are genuinely Tauri-coupled. Dispatch `desktop-tests.yml` against this branch before
merging:

```
gh workflow run desktop-tests.yml --repo companionintelligence/CI-Hub --ref claude/desktop-hub-manager-split
```

**`hub_watchdog_decision` is environment-dependent in the real suite too**, not only in the harness —
it will fail anywhere `docker` is absent, including a runner without a daemon. Worth making it
inject `is_docker_available` rather than calling it, but that is a source change this PR does not
make.

**Stage 1 is now complete**: `cihub-cli.ts` (#1245), the inference registry and lifecycle command
base (#1245), tests and docs (#1251), the three latent hazards (#1252), and `hub_manager.rs` here.

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| Verification | — | — | Built and ran the harness directly rather than delegating; the point was to produce evidence, and the evidence is the diff of two test-name sets. |
| Code review | maintainability | Opus 5 | Read every hunk outside `hub_manager` to confirm the `cargo fmt` commit changed no logic, and checked the CI commit for cost implications. |
