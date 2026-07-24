# Backend System — CI-Hub

> **Purpose:** NestJS API server — app lifecycle, Docker management, auth, queues, MCP.
> **Scope:** `packages/backend/` — modules, Drizzle schema, RabbitMQ workers, SSE.
> **Key paths:** `packages/backend/src/modules/`, `packages/backend/src/database/`, `packages/backend/src/queue/`
> **Commands:** `cd packages/backend && pnpm test`, `pnpm run test:integration` (root)
> **Owner persona:** maintainability + security (see REVIEW_PERSONAS.md)
> **Last updated:** 2026-07-12
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
