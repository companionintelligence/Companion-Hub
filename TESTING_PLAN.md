# Testing Infrastructure Overhaul

This document outlines the new testing foundations established to ensure reliable, conflict-free testing in both local and CI environments.

## Key Improvements

1.  **Dynamic Ports**: All integration and E2E tests now use dynamically assigned ports. This prevents conflicts with running development servers or other test instances.
2.  **Isolated Environments**: Tests spin up their own Docker containers (Postgres, RabbitMQ, etc.) which are torn down after execution.
3.  **Unified Scripts**: New scripts manage the lifecycle of test environments (Setup -> Test -> Teardown).

## Backend Integration Tests

*   **Command**: `bun run test:integration` (in `packages/backend` or root)
*   **Mechanism**:
    *   Spins up `postgres` and `rabbitmq` using `packages/backend/src/tests/db.compose.yml`.
    *   Assigns random ports to these services.
    *   Injects connection details via environment variables (`POSTGRES_PORT`, `RABBITMQ_PORT`).
    *   Runs `vitest` with the integration config.
    *   Cleans up containers automatically.

## E2E Tests

*   **Command**: `bun run test:e2e` (in root)
*   **Mechanism**:
    *   Spins up a full stack (`app`, `db`, `queue`) using `e2e/docker-compose.e2e.yml`.
    *   Builds the application using `Dockerfile.dev`.
    *   Assigns random ports for the Frontend and Backend.
    *   Runs Playwright tests against this isolated instance.
    *   Cleans up containers automatically.

## Frontend Tests

*   **Command**: `bun run test` (in `packages/frontend`)
*   **Mechanism**: Runs `vitest` for component and unit tests.

## Configuration Changes

*   **Environment Variables**:
    *   `DATA_DIR`, `APP_DATA_DIR`, `APP_DIR` can now be overridden via environment variables.
    *   `RABBITMQ_PORT` is now configurable (defaulting to 5672).
*   **Database Helper**: `e2e/helpers/db.ts` now respects `POSTGRES_PORT`.

## How to Run

### Run all tests
```bash
bun test
```

### Run E2E tests
```bash
bun run test:e2e
```

### Run Backend Integration tests
```bash
cd packages/backend
bun run test:integration
```
