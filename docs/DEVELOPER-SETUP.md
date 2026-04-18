# Developer Setup

This guide is for contributors working on CI-Hub locally. If you want to install a Hub on a device, use the repository [README](../README.md) instead.

## Prerequisites

| Tool | Version |
| --- | --- |
| Node.js | 22+ |
| pnpm | 10+ |
| Docker Engine | 28+ |
| Docker Compose | current plugin |

## Local web development

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Create a local environment file:

   ```bash
   cp .env.example .env.local
   ```

3. Edit `.env.local` and set at least:

   - `ROOT_FOLDER_HOST`
   - `POSTGRES_PASSWORD`
   - `JWT_SECRET`
   - `INTERNAL_IP`
   - `DOMAIN`
   - `CI_CLOUD_URL`

4. Start the local developer loop:

   ```bash
   pnpm dev
   ```

This starts Postgres and RabbitMQ in Docker, then runs the backend and frontend locally with hot reload.

- Frontend: <http://localhost:5173>
- Backend API: <http://localhost:3000>

## Other supported run modes

| Command | When to use it |
| --- | --- |
| `pnpm start:docker` | Full local stack in Docker using `.env.local` |
| `pnpm start:dev` | Dev environment container stack using `.env.dev` |
| `pnpm start:staging` | Staging-like container stack using `.env.staging` |
| `pnpm start:prod` | Production-like container stack using `.env.prod` |
| `pnpm dev:desktop` | Native desktop shell development |

## Verification before opening a PR

Run the checks that match the area you touched:

```bash
pnpm test
pnpm test:integration
pnpm lint:ci
pnpm tsc
```

For doc-only changes, run:

```bash
bash scripts/check-docs.sh
```

## Related docs

- [Release Architecture](./RELEASE-ARCHITECTURE.md)
- [Compatibility Notes](./COMPATIBILITY-NOTES.md)
- [Desktop development guide](../packages/desktop/README.md)
