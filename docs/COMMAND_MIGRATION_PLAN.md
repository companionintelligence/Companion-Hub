# Command Migration Plan

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

## Preliminary replacement checklist

### Root scripts to remove or rename

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

Files:

- `scripts/cihub-cli.ts`
- `scripts/__tests__/cihub-cli.test.ts`

Old/public names still present:

- `pnpm run hub --` compat path
- `shutdown`
- `hot-reload`
- raw start-mode entrypoints:
  - `dev`
  - `start`
  - `start:detached`

### Repo docs still pointing at old CLI/script usage

Files:

- `README.md`
- `docs/CLI.md`
- `packages/desktop/README.md`

Known outdated references include:

- `pnpm run hub -- ...`
- `shutdown`
- `hot-reload`
- `pnpm run start:dev:desktop`
- `pnpm run compose:profiles`

### Helper/example text and comments

Files:

- `e2e/helpers/infra.ts`
- `scripts/get-device-id.ts`
- `scripts/render-cli-svgs.ts`
- stale inline command comments elsewhere in the repo

Known outdated references include:

- `Or: pnpm run infra:up`
- `pnpm run device-id`
- `cihub shutdown local`

## Implementation order

1. Update `scripts/cihub-cli.ts` command surface and migration failures.
2. Update CLI tests tied to help/man output.
3. Replace the root `package.json` script surface.
4. Update docs, examples, helper messages, and stale comments.
5. Run a final repo-wide search for removed names.
