---
name: hot-swap
description: >-
  Swap a locally built CI-Server branch onto the Hub-installed ci-memory app
  so it can be tested against that appliance's live data. Use when the user
  says hot swap, hot-swap, swap a branch onto Memory, or hub-pr-test-deploy,
  including on a named appliance such as core-3.
---

# Hot-swap Memory

Hot-swap replaces the running Memory images with a local CI-Server build. Memory's database, object store, secrets, and Hub catalog pin stay as they are. This is a one-off test, not a release.

The live app is Hub's `ci-memory` install. A git checkout on the box is only the build source.

The scripts and the runbook live in the CI-Server repo, not in Hub. Read `docs/runbooks/one-off-prod-data-testing.md` there before a swap that runs migrations. Deploy with `scripts/dev/hub-pr-test-deploy.sh`. Roll back with `scripts/dev/hub-pr-test-rollback.sh`.

## Before building

1. SSH to the appliance that is running Hub. The checkout, the Docker socket, and `ci-os-hub` must be on that machine.
2. Use the devel checkout (on core-3, `~/devel/ci/ci-server`). Ignore stale clones such as `~/CI-Server`.
3. Confirm the branch to test, then check it out. Stash a dirty tree first.
4. Confirm Hub's env file exists: `~/.local/share/companion-hub/app-data/ci-marketplace/ci-memory/app.env`. Stop if it is missing. Do not edit `app.env` to change images.

## Swap

Run from that CI-Server checkout:

```bash
# UI only (web build + gateway). Skips migrate.
./scripts/dev/hub-pr-test-deploy.sh --frontend

# API, HBPE, summary, or a migration. Takes a backup first (runbook).
./scripts/backup/appliance-backup.sh --project ci-memory_ci-marketplace ~/ci-backups
./scripts/dev/hub-pr-test-deploy.sh
```

- `--skip-build` when `make build ENV=production` already ran.
- `--skip-migrate` to recreate containers without applying SQL.
- `GPU=cpu` is the default. Hub does not pass GPU devices into `hbpe-service`.
- `PR_TAG` defaults to `pr-onboarding-test`. Set it when this box already uses another local tag.

The script tags local `ci/*:latest` images, writes `docker-compose.pr-test.yml` beside Hub's installed compose, runs compose inside `ci-os-hub`, recreates `api`, `gateway`, `hbpe-service`, and `summary-service` (`gateway` only for `--frontend`), and points Traefik at the new gateway IP.

The override changes image tags only. Hub's env files are passed through to the new containers: `app.env`, and `user-config/app.env` when that overlay exists. That is what keeps the appliance on its dedicated Hub subdomain. `APP_URL`, the public hostname, and the OIDC URLs come from those files, not from the image. Do not copy them into the build and do not rewrite them for the swap.

Database and object-store images stay on the Hub pin. The Hub UI still shows the old catalog version. That is expected.

If the script warns that it could not refresh Traefik, restart ci-memory from the Hub UI or restart `ci-os-hub`.

## Check

```bash
docker ps --filter name=ci-memory_ci-marketplace --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
docker logs ci-memory_ci-marketplace-api-1 --tail 40
```

`api`, `gateway`, `hbpe-service`, and `summary-service` should show `PR_TAG`. For `--frontend`, only `gateway` changes.

## Roll back

```bash
./scripts/dev/hub-pr-test-rollback.sh
```

This deletes the override and recreates those four services from Hub's pinned compose. It does not undo SQL. A migration that already applied stays applied.
