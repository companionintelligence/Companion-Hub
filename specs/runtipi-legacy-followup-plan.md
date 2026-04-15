# Runtipi legacy follow-up plan

Base: `origin/dev` @ `d1eff63b`
Worktree: `/Users/josh/workspaces/companionintelligence/_worktrees/ci-hub-runtipi-followup`
Branch: `prep/runtipi-legacy-followup`
Status: prepared only — nothing pushed or merged

## Goal
Remove the remaining **safe** runtipi/tipi rename leftovers that are now internal-only, while preserving backward compatibility still needed for upgraded installs and marketplace app configs.

## Reviewed inputs
- PR #371: `chore: remove remaining runtipi/tipi references`
- PR #370: `feat: auto-install Docker Engine on Linux via Tauri IPC`
- Current `origin/dev` tree
- Ubuntu smoke on `josh@192.168.1.2`

## Safe to delete/update now

### 1) Normalize E2E/dev harness env names to CI-Hub names
These are test/startup harnesses, not migration surfaces for existing installs.

- `e2e/start-backend.sh`
  - replace `TIPI_DATA_DIR` => `CI_HUB_DATA_DIR`
  - replace `TIPI_APP_DATA_DIR` => `CI_HUB_APP_DATA_DIR`
  - replace `TIPI_APP_DIR` => `CI_HUB_APP_DIR`
  - replace `RUNTIPI_APP_DATA_PATH` => `CI_HUB_APP_DATA_PATH`
  - replace `RUNTIPI_FORWARD_AUTH_URL` => `CI_HUB_FORWARD_AUTH_URL`
  - stop exporting `TIPI_VERSION`; keep `CI_HUB_VERSION`
- `playwright.config.ts`
  - same env renames as above
  - stop seeding the backend with legacy keys unless a specific backward-compat test needs them

### 2) Remove now-redundant runtime alias layer
After step 1, runtime startup should already receive canonical CI-Hub vars.

- `packages/backend/src/core/config/configuration.service.ts`
  - remove the local `legacyEnvMap` block for:
    - `RUNTIPI_APP_DATA_PATH -> CI_HUB_APP_DATA_PATH`
    - `RUNTIPI_FORWARD_AUTH_URL -> CI_HUB_FORWARD_AUTH_URL`

Rationale: `generateSystemEnvFile()` already resolves legacy keys and loads canonical values into `process.env` from `state/.env.resolved` before `ConfigurationService` parses config.

### 3) Remove legacy constant fallbacks once harness is updated
- `packages/backend/src/common/constants.ts`
  - remove fallbacks to:
    - `TIPI_APP_DIR`
    - `TIPI_DATA_DIR`
    - `TIPI_APP_DATA_DIR`
  - keep only:
    - `CI_HUB_APP_DIR`
    - `CI_HUB_DATA_DIR`
    - `CI_HUB_APP_DATA_DIR`

This should happen in the same PR as step 1 so tests/startup remain green.

### 4) Fix remaining auth header rename in bundled Traefik dynamic config
- `packages/backend/assets/traefik/dynamic/dynamic.yml`
  - `X-Runtipi-User` => `X-CI-Hub-User`

Rationale: auth controller already emits `X-CI-Hub-User`; compose labels already use `X-CI-Hub-User`. The bundled asset is the odd one out.

### 5) Low-risk wording cleanup
- `scripts/init-traefik.ts`
  - update doc comment mentioning `RUNTIPI_STATE_PATH`; code already uses `CI_HUB_STATE_PATH`

## Keep for now (not safe to remove yet)
These are real compatibility surfaces, historical migration paths, or app-data compatibility.

- `packages/backend/src/common/helpers/env-helpers.ts`
  - keep `LEGACY_ENV_MAP` entries for `RUNTIPI_*` and `TIPI_*`
- `packages/backend/src/modules/docker/docker.service.ts`
  - keep support for legacy `user-config/tipi-compose.yml`
- `packages/backend/src/modules/docker/builders/service.builder.ts`
  - keep `RUNTIPI_APP_ID` interpolation support
- compose-builder/service-builder tests and snapshots covering `RUNTIPI_APP_ID`
- `scripts/cleanup.ts`
  - keep cleanup of legacy runtipi volumes / project names
- historical upgrade scripts:
  - `scripts/update-2.0.0-to-3.0.0.sh`
  - `scripts/update-3.0.0-to-4.0.0.sh`
  - `scripts/temp-update-3.0.0-to-4.0.0-beta.sh`
- `scripts/install.sh`
  - keep `runtipi-cli` download/install path until the CLI artifact itself is renamed upstream
- app/test fixture data where `tipi` is an app-local username/value, not product branding

## Optional later cleanup (non-runtime / repo metadata)
These are stale, but separate from the migration-safe runtime cleanup above:
- `.github/ISSUE_TEMPLATE/*`
- `.github/memory-bank/*`
- `.all-contributorsrc`
- changesets / changelogs / old docs referencing `@runtipi/*`

## Suggested implementation order
1. Update `e2e/start-backend.sh` and `playwright.config.ts`
2. Remove `ConfigurationService` alias layer
3. Remove `TIPI_*` constant fallbacks
4. Update bundled Traefik dynamic header
5. Update/add tests covering startup + auth header expectations
6. Run verification:
   - `pnpm test`
   - `pnpm run lint:ci`
   - `pnpm run tsc`
   - targeted E2E smoke or full `pnpm run test:e2e:ci` if practical
   - Ubuntu smoke using the canonical command `pnpm start:dev` (or `pnpm start dev`, noting semantics below)

## Ubuntu verification result
Host: `josh@192.168.1.2`
Repo: `~/ci-workspace/CI-OS-Hub`
Branch during probe: `feat/remove-runtipi-references` @ `4aa36d1491d25faa8f6f80bab3afef19c5c45723`

### What `pnpm start dev` actually does
It **works**, but not in the way the command spelling suggests:
- `pnpm start dev` is interpreted as `pnpm run start dev`
- that invokes script `start` with argument `dev`
- script `start` runs `tsx scripts/start.ts start dev`
- that launches the **production-style compose stack** with `.env.dev`

So:
- canonical compose/dev-env command: `pnpm start:dev` or `pnpm run start:dev`
- canonical local HMR/dev command: `pnpm run dev`
- `pnpm start dev` is accepted, but semantically means **start mode + dev env**, not the `dev` script

### Probe outcome
Bounded probe (`timeout 90s pnpm start dev`) succeeded far enough to prove startup:
- built/reused `ci-hub-ci-os-hub`
- recreated containers
- `docker compose ... ps` shows healthy:
  - `ci-os-hub`
  - `ci-hub-db`
  - `ci-os-hub-queue`
- `curl http://localhost:5002/api/health` => `{"status":"ok",...}`
- `curl http://localhost:5002/api/registration/status` => `{"registered":true}`

## Ready state
- Clean next-task worktree prepared from latest `origin/dev`
- Exact safe-removal set identified
- No merge/push performed
- Wait for PR #370 to be green/merged before applying changes here
