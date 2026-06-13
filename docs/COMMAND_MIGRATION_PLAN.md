# Command Migration Plan

## Current branch state

This branch is actively implementing the migration plan.

Implemented commits:

- `48fe096f` — add the migration plan doc
- `6f740a3a` — migrate the `cihub` lifecycle surface to the new canonical commands
- `5db4e90b` — simplify the root `package.json` script surface
- `cd14a2fe` — update docs, generated CLI assets, helper text, and stale comments
- `5e1d8a7c` — gate desktop-only helpers by platform/build mode to remove warnings
- `ff365a54` — make desktop build preflight the frontend bundle before `cargo tauri build`
- `077105cd` — remap root entrypoints so `local` is source dev and `dev` is the `.env.dev` appliance stack

Current implemented behavior:

- `cihub` is the canonical lifecycle interface.
- Removed lifecycle names such as `shutdown`, `hot-reload`, `start`, `start:detached`, and `purge` now fail with migration guidance instead of acting as primary interfaces.
- `pnpm run local` starts source-based local development.
- `pnpm run dev` starts the `.env.dev` appliance stack in detached mode.
- `pnpm start <env>` is available again as the shared appliance start entrypoint.
- `cihub uninstall [--yes]` is the full uninstall-style wipe path.
- `cihub reset <env> [--yes]` is the environment-scoped wipe path.
- Desktop build now ensures frontend assets exist before the Tauri build runs.
- Local source dev now writes the runtime env file the backend expects before launching the workspace dev processes.

## Approved command semantics

- `local` = source-based local development
- `dev` = deployed dev appliance on prod-style compose with `.env.dev`
- `staging` = staging appliance
- `prod` = production appliance

## Approved migration direction

- Root `package.json` keeps engineering tasks and stops being the primary lifecycle interface.
- Canonical lifecycle control moves to `cihub`.
- Old lifecycle interfaces can break in this release if the replacement and migration guidance are explicit.

## Canonical `cihub` lifecycle surface

- `cihub setup <env>`
- `cihub up <env> [--detached]`
- `cihub down <env>`
- `cihub restart <env>`
- `cihub recreate <env>`
- `cihub status <env>`
- `cihub logs <env> [service]`
- `cihub config <env>`
- `cihub register <env>`
- `cihub doctor <env>`
- `cihub clean <env>`
- `cihub reset <env>`
- `cihub uninstall`

## Root script direction

Keep engineering-task scripts such as:

- `start`
- `dev`
- `local`
- `dev:app`
- `dev:desktop`
- `local:desktop`
- `build`
- `bundle`
- `tsc`
- `test`
- `test:integration`
- `test:e2e`
- `test:e2e:ci`
- `test:e2e:ui`
- `test:cli`
- `check`
- `lint`
- `lint:fix`
- `lint:ci`
- `gen:api-client`
- `gen:swagger`
- `prepare`
- `version`

Remove lifecycle-style root scripts and move those workflows behind `cihub`.

Additional approved root-entrypoint mapping:

- `pnpm run local` = source-based local development
- `pnpm run dev` = `.env.dev` appliance stack, detached
- `pnpm start <env>` = shared start entrypoint for appliance environments

## Breaking migration policy

- Old lifecycle names can break in this release.
- Replacements should fail clearly with direct guidance to the new `cihub` command.
- Soon-to-be-incorrect comments and examples should be updated or removed during the migration.

## Replacement checklist and status

### Root scripts to remove or rename

Status: implemented

File:

- `package.json`

Old script keys found:

- `infra:up`
- `infra:down`
- `start`
- `start:docker`
- `init:host`
- `compose:profiles`
- `start:prod`
- `start:staging`
- `start:dev`
- `start:dev:detached`
- `check:all`
- `device-id`
- `hub`
- `start:detached`
- `fresh`
- `fresh:local`
- `wait:hub`
- `start:dev:desktop`

### CLI implementation still exposing old names or compat paths

Status: implemented

Files:

- `scripts/cihub-cli.ts`
- `scripts/__tests__/cihub-cli.test.ts`

Handled by implementation:

- `pnpm run hub --` is no longer the documented interface
- `shutdown` fails with guidance to `down`
- `hot-reload` / `dev` fail with guidance to `up local`
- raw start-mode entrypoints no longer act as primary lifecycle commands

### Repo docs still pointing at old CLI/script usage

Status: implemented

Files:

- `README.md`
- `docs/CLI.md`
- `packages/desktop/README.md`

Main references updated:

- `README.md`
- `docs/CLI.md`
- `packages/desktop/README.md`

### Helper/example text and comments

Status: implemented

Files:

- `e2e/helpers/infra.ts`
- `scripts/get-device-id.ts`
- `scripts/render-cli-svgs.ts`
- stale inline command comments elsewhere in the repo

Main references updated:

- `e2e/helpers/infra.ts`
- `scripts/get-device-id.ts`
- `scripts/render-cli-svgs.ts`
- stale inline command comments touched during the migration sweep

## Implementation order

1. Update `scripts/cihub-cli.ts` command surface and migration failures.
2. Update CLI tests tied to help/man output.
3. Replace the root `package.json` script surface.
4. Update docs, examples, helper messages, and stale comments.
5. Run a final repo-wide search for removed names.

## Remaining follow-up

- Keep validating real user flows (`local`, `dev`, desktop build, uninstall/reset) and tighten any rough edges found during manual testing.
- Continue preferring user-friendly improvements only when they preserve the approved command semantics.
