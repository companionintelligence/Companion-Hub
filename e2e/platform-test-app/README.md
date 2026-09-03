# CI E2E Test App

A purpose-built multi-service Docker application for validating CI-Hub platform capabilities end-to-end.

## Why It Exists

Rather than testing against third-party apps (which may change, break, or be slow to pull), this app exercises every Hub feature in a controlled, deterministic way:

- **Form field injection** — all field types (text, password, email, number, url, boolean, random)
- **Multi-service orchestration** — 5 containers with dependency ordering and healthchecks
- **Persistent storage** — file writes survive container restarts
- **Inter-service communication** — web → Postgres, web → Redis, worker → Postgres
- **Health check detection** — togglable health endpoint for testing Hub health monitoring
- **Networking** — port exposure, internal isolation, UDP support
- **Static assets & SPA** — CSS, images, and client-side routing fallback

## Services

| Service | Image | Description |
|---------|-------|-------------|
| `web` | `ci-e2e-test-app-web` | Express.js app with API endpoints and HTML UI |
| `db` | `postgres:16-alpine` | PostgreSQL database |
| `cache` | `redis:7-alpine` | Redis cache |
| `worker` | `ci-e2e-test-app-worker` | Writes heartbeat rows to Postgres every 5s |
| `udp-echo` | `ci-e2e-test-app-udp` | UDP echo server on port 9999 |

## Running Locally

```bash
# Build the custom images
cd e2e/platform-test-app/services/web && docker build -t ci-e2e-test-app-web:latest .
cd ../worker && docker build -t ci-e2e-test-app-worker:latest .
cd ../udp-echo && docker build -t ci-e2e-test-app-udp:latest .

# The app is installed via the Hub API — the docker-compose.json is in Hub V2 schema format.
# For standalone testing, you can run the web service directly:
cd ../web && npm install && node index.js
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Returns 200 or 500 based on toggle |
| `/api/set-unhealthy` | POST | Sets health to failing |
| `/api/set-healthy` | POST | Sets health to passing |
| `/api/env` | GET | Returns all E2E_*/CI_*/APP_* env vars |
| `/api/db-check` | GET | Queries Postgres for heartbeat count |
| `/api/redis-check` | GET | Writes/reads Redis to verify connectivity |
| `/api/worker-status` | GET | Checks for recent worker heartbeats |
| `/api/write-file` | POST | Writes `{filename, content}` to persistent volume |
| `/api/read-file` | GET | Reads file from persistent volume (`?filename=`) |

## Playwright Tests

Test specs live in `e2e/platform/`:

| Spec | What It Tests |
|------|---------------|
| `platform.spec.ts` | Orchestrator: build images, install, cleanup |
| `lifecycle.spec.ts` | Install → verify containers → uninstall → verify cleanup |
| `web-ui.spec.ts` | HTML page, CSS, images, SPA fallback |
| `form-fields.spec.ts` | All form field types injected correctly |
| `multi-service.spec.ts` | Postgres, Redis, worker heartbeat connectivity |
| `storage.spec.ts` | File persistence across container restarts |
| `networking.spec.ts` | Port exposure, Traefik routing, internal isolation |
| `health.spec.ts` | Health toggle detection by Hub |

## Adding New Test Cases

1. Add new API endpoints to `services/web/index.js`
2. Add new form fields to `config.json` and reference them in `docker-compose.json`
3. Create a new `.spec.ts` in `e2e/platform/`
4. Run locally: `npx playwright test e2e/platform/your-new-spec.spec.ts`
