# Backend System — CI-Hub

> **Purpose:** NestJS API server — app lifecycle, Docker management, auth, queues, MCP.
> **Scope:** `packages/backend/` — modules, Drizzle schema, RabbitMQ workers, SSE.
> **Key paths:** `packages/backend/src/modules/`, `packages/backend/src/database/`, `packages/backend/src/queue/`
> **Commands:** `cd packages/backend && pnpm test`, `pnpm run test:integration` (root)
> **Owner persona:** maintainability + security (see REVIEW_PERSONAS.md)
> **Last updated:** 2026-08-04
> **Related:** docs/system/e2e.md, docs/ARCHITECTURE.md

---

## Layout

```
packages/backend/
  src/modules/       Feature modules (apps, auth, docker, health, mcp, …)
  src/database/      Drizzle schema + migrations
  src/queue/         RabbitMQ workers (install, lifecycle, …)
  src/common/        Shared guards, filters, decorators
```

## Key modules

| Module | Responsibility |
|--------|----------------|
| `apps` / `app-lifecycle` | Install, start, stop, uninstall marketplace apps |
| `docker` | Dockerode + compose orchestration |
| `auth` | JWT sessions, 2FA, registration |
| `health` | Liveness/readiness (`/api/health/live`) |
| `sse` | Real-time status stream to frontend |
| `mcp` | MCP server tools for agent apps |
| `tailscale` / `cloudflare` | Optional sidecar integrations |

## App volumes

`DockerComposeBuilder` renders each manifest volume as either a host bind mount (`hostPath`) or a
docker-managed named volume (`volumeName`), never both. Compose scopes named volumes to the app's
project, so `db` becomes `<app>_<store>_db`, and the existing lifecycle commands already reclaim
them — `down --volumes` on uninstall-with-data and reset, preserved on stop/restart/update.

A bind mount may also declare `requiresPosixPermissions: true`, meaning its contents need real
ownership. Windows-backed host paths (drvfs/9p) accept `chown`/`chmod` and silently discard them,
so postgres' `initdb`, mysql's `mysqld`, and mongo's WiredTiger all abort with `EPERM` on such a
mount. `supportsPosixPermissions()` (`common/helpers/bind-mount-helpers.ts`) probes the app-data
filesystem once per process by flipping a scratch file's mode and reading it back; when the mode
does not stick, the builder mounts those volumes as named volumes instead. The redirected volume is
named after the bind's **host path**, not its mount point — apps like `fastgpt` and `postiz` run two
postgres services that both mount `/var/lib/postgresql/data`, and naming by mount point would put
both servers on one data directory.

The probe reports "supported" on any error **by design** — the opposite would move a working app's
data directory into an empty named volume over what may be a transient IO failure. For the same
reason the redirect is keyed off the filesystem rather than applied everywhere: on Linux and macOS
bind mounts keep working and existing data stays exactly where it is.

## Database

- PostgreSQL via Drizzle ORM
- Migrations in `packages/backend/drizzle/`
- Integration tests use Docker Postgres (see `integration-tests.yml`)

## Queue workers

RabbitMQ consumers handle long-running install/update operations. Frontend polls + SSE for progress.

## API client generation

OpenAPI spec generated from NestJS decorators. Drift check: `pnpm run check:openapi`.

Frontend client: `packages/frontend/src/api-client/` (regenerate via `pnpm run gen:api-client`).

## Agent notes

- Do not add secrets to committed `.env` files.
- New endpoints need Swagger decorators for OpenAPI drift CI.
- Hub health probe used by desktop/frontend: `/api/health/live` only (not full readiness).
