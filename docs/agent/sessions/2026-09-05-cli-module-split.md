# Session Worksheet — cli-module-split

> Git tag after merge: `agent-session/cli-module-split`

---

## Meta

| Field | Value |
|-------|-------|
| **Slug** | `cli-module-split` |
| **Date** | 2026-09-05 |
| **Agent** | Claude |
| **Model** | Opus 5 |
| **Task** | User request: refactor large TypeScript and Rust files into smaller libraries so they can be tested and extended, ahead of porting Tauri functionality to the CLI and rebuilding the installer. |

---

## Goal

Stage 1b of the approved program: split `scripts/cihub-cli.ts` (2,476 lines) into focused command
modules under `scripts/lib/`, and invert the dependency so `cli-dispatch.ts` imports handlers from
the modules that own them instead of reaching back into the monolith. Behavior-preserving only — no
feature or signature changes.

---

## Steps taken

1. Recorded a baseline: 540 tests across 25 files in the `scripts/` vitest lane, and the 77-name
   public export surface of `cihub-cli.ts` at HEAD.
2. Extracted 14 modules in dependency order, leaf-first, so no extraction introduced a cycle:
   `cli-repo-context` and `cli-args` first, then `hub-context`, `cli-prompt`, and the command
   clusters, with `cli-wizard` last because it orchestrates the others.
3. After each extraction, ran three checks: an undefined-name pass (`tsc` filtered to TS2304/TS2552),
   Biome, and the full test lane.
4. Repointed `cli-dispatch.ts` at the owning modules and reduced `cihub-cli.ts` to a documented
   re-export facade.
5. Verified the public export surface against HEAD and restored two types the split had dropped.
6. Smoke-tested the CLI itself (`version`, `--help`, `man`, removed-command guidance, unknown command).

---

## Decisions

| Decision | Rationale |
|----------|-----------|
| Keep `cihub-cli.ts` as a re-export facade rather than deleting it | `__tests__/cihub-cli.test.ts` imports 42 names from it. Keeping the facade means the 122 existing cases validate the move without a single test edit, which is the strongest available evidence the refactor is mechanical. Biome's `noBarrelFile` only targets `index.*`, so the facade does not trip `lint:ci`. |
| Move `buildComposeBaseArgs` into `hub-context.ts` | It is shared by the context and lifecycle clusters; leaving it behind would have made `cli-lifecycle` import from the monolith. |
| Export `envFileMap` from `cli-compose-env.ts` and drop the copy in `cihub-cli.ts` | The map existed in three places. The one being relocated was removed rather than moved, taking the count to two. The third copy in `network-diagnostics-cli.ts` was left alone as out of scope. |
| Drive imports from a `tsc` undefined-name pass rather than static analysis | A hand-rolled analyzer missed identifiers used only inside template literals (`${STEP_ICONS.fail}`) and the combined `import path, { join }` form. Two test failures caught this; the compiler pass caught the rest in one sweep. |
| Widen two symbols to exported: `StartMode`, `findComposeName` | Both were module-local and are now needed across module boundaries. These are the only two surface additions; no names were removed. |

---

## Files touched

**New (14 modules, 2,600 lines):** `scripts/lib/{cli-args,cli-repo-context,cli-prompt,hub-context,cli-lifecycle,cli-register,cli-teardown,cli-doctor,cli-models,cli-api-key,cli-app,cli-pool,cli-wizard,cli-update}.ts`

**Modified:** `scripts/cihub-cli.ts` (2,476 → 80 lines, now a facade), `scripts/lib/cli-dispatch.ts`
(repointed at the owning modules), `scripts/lib/cli-types.ts` (`StartMode`, `RegisterHubOptions`),
`scripts/lib/cli-compose-env.ts` (`envFileMap` exported).

---

## Tests run

- [x] `pnpm exec biome check scripts/` — clean across 95 files
- [x] `pnpm exec vitest run --config scripts/vitest.config.ts` — 540/540 passing, unchanged from baseline
- [x] Undefined-name pass over every new module — clean
- [x] Export-surface diff against HEAD — no regressions
- [x] `pnpm exec knip` — flags none of the new modules
- [x] CLI smoke test — `version`, `--help`, `man`, removed-command and unknown-command paths
- [ ] `pnpm run lint:ci` (whole repo) — blocked, see below
- [ ] `pnpm run tsc` — blocked, see below
- [ ] `pnpm test` (whole repo) — blocked, see below
- [ ] App run — blocked, see below
- [ ] `bin/agent-validate-shift` — blocked, see below

---

## Open items / handoff

**Two environment blockers stopped the full gate from running in this worktree.** Neither is caused
by this change, and both need a human:

1. **Workspace install is partial.** `pnpm install` fails with `ERR_PNPM_FETCH_401` fetching
   `@companionintelligence/tokens` from `npm.pkg.github.com`, because `NODE_AUTH_TOKEN` is not set
   (`.npmrc` interpolates it). Only `packages/frontend` needs that scope. A root-only install
   (`pnpm install --filter "./"`) succeeded, which is what made the `scripts/` lane runnable — but
   backend, frontend, and common tests and `turbo run tsc` cannot run without the token.
2. **Rust cannot build.** `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` fails
   in `libdbus-sys`: the system library `dbus-1` is missing. Tauri's other Linux system deps are
   likely missing behind it. Installing them needs root.

Consequence for the program: **Stage 1a (the Rust split of `hub_manager.rs`) cannot be verified
locally until blocker 2 is cleared.** The plan's verification for that stage is "same 89 tests before
and after", which requires a working `cargo test`. Do not start 1a without it.

Also worth knowing for later stages: `scripts/` is **not** in the `turbo run tsc` gate (only
`packages/{common,backend,frontend}` define a `tsc` script), so `scripts/` is covered by Biome and
vitest alone. `scripts/` carries 94 pre-existing strict-mode type errors under the root tsconfig,
including 3 that moved verbatim from `cihub-cli.ts` into `cli-args.ts` with the
`normalizeRegisterFlags` loop. None are new.

---

## Reviews run

| Phase | Persona | Model | Notes |
|-------|---------|-------|-------|
| — | — | — | Not run; `bin/agent-review` was not exercised this session. |
