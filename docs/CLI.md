# CI-Hub CLI

The preferred packaged executable is:

```bash
cihub <command> [args]
```

## Install

```bash
npm install -g ci-hub
cihub --help
```

One-off without installing:

```bash
npx --package ci-hub cihub --help
```

Homebrew and other package managers expose the same `cihub` executable on `PATH`.

---

## On-device testing loop

Use this loop when iterating on CLI/TUI or developer workflow changes:

```bash
cihub reset local --yes  # clean local runtime state
cihub up local           # infra + backend/frontend from source
cihub wizard             # run the full interactive flow
pnpm run test:cli        # presentation tests (25 cases)
```

- **`cihub reset local --yes`** — removes local runtime state for clean-slate testing.
- **`cihub up local`** — brings up infra then starts backend/frontend from source; no Docker rebuild needed.
- **`pnpm run test:cli`** — Vitest suite covering banner, step renderer, FTUE detection, arg validation, all wizard selectors, and help/man output.

---

## ASCII banner

Every command entry point shows the Companion Intelligence ASCII banner followed by the company tagline:

<p>
  <img src="./images/cli/banner-help.svg" alt="Companion Intelligence ASCII banner from cihub --help" width="960" />
</p>

<p>
  <img src="./images/cli/banner-wizard.svg" alt="Companion Intelligence ASCII banner from cihub wizard" width="960" />
</p>

---

## Help and MAN

```bash
cihub --help     # command reference
cihub man        # manual-style reference with packaging notes
cihub version    # print version from package.json
```

![Screenshot of cihub --help](./images/cli/help.svg)

![Screenshot of cihub man](./images/cli/man.svg)

---

## Setup & Registration

### `cihub wizard [env]`

Runs the guided setup wizard. On **first run** (no `env` file found) it enters FTUE mode: shows a step tracker, checks Docker availability, runs setup and registration automatically, then launches the Hub.

```bash
cihub wizard          # local env, first-run auto-detected
cihub wizard staging  # target a specific environment
```

![Screenshot of cihub wizard (FTUE mode)](./images/cli/wizard.svg)

Returning users get the action menu: setup, up, register, config, MCP, down, app-list, reset, restart.

### `cihub setup [env]`

Initializes Traefik and Docker auth config for the target environment.

```bash
cihub setup local
```

![Screenshot of cihub setup local](./images/cli/setup.svg)

### `cihub register [env]`

Prints your device ID and the CI Cloud registration URL. Open the URL in a browser to pair the device, then proceed to `cihub up`.

```bash
cihub register local
```

![Screenshot of cihub register local](./images/cli/register.svg)

---

## Hub lifecycle

```bash
cihub up [env] [--detached]  # start the hub stack
cihub down [env]             # stop the hub stack
cihub restart [env]          # stop then start the target environment
cihub recreate [env]         # reset runtime state, then start again
cihub status [env]           # show container health + resolved config
cihub logs [env] [service]   # stream compose logs
cihub config [env]           # show resolved config values only
```

- `--detached` runs the stack in the background (equivalent to `docker compose up -d`).
- `status` shows three sections: **Containers** (color-coded ●/✗), **Network** (local URL, Cloudflare tunnel URL from `CF_DOMAIN`/`DOMAIN`, Tailscale VPN IP), and **Models** (installed Ollama models).

![Screenshot of cihub status local](./images/cli/status.svg)

![Screenshots of cihub config, cihub up, and cihub down](./images/cli/lifecycle.svg)

---

## App lifecycle

Manage individual Docker containers on the host machine, independently of the compose stack.

```bash
cihub app list                                        # list all containers
cihub app status [name]                               # color-coded status (all or one)
cihub app logs <name> [--tail N]                      # stream logs (default tail 50)
cihub app inspect <name>                              # ports, env vars, mounts
cihub app add <name> <image> [--port h:c] [--env K=V] # launch new container
cihub app edit <name> <image> [--port h:c] [--env K=V] # recreate (rm -f then run)
cihub app start <name>
cihub app stop <name>
cihub app restart <name>
cihub app delete <name>                               # docker rm -f
```

`app status` shows each container with a color-coded status and the bound ports:

```
demo-ollama    Up 3 hours → 0.0.0.0:11434->11434/tcp
demo-webui     Exited (1) 2 minutes ago
```

`app inspect` parses `docker inspect` JSON and prints a structured summary of image, status, ports, environment variables, and volume mounts.

![Screenshot of cihub models list and models install](./images/cli/models.svg)

![Screenshot of cihub app list and app status](./images/cli/app-list.svg)

![Screenshots of cihub app add/edit/start/stop/restart/delete](./images/cli/app-management.svg)

---

## MCP

```bash
cihub mcp setup [env]     # set MCP_ENABLED=true
cihub mcp shutdown [env]  # set MCP_ENABLED=false
cihub mcp config [env]    # show current MCP settings
```

![Screenshots of cihub mcp setup, config, and shutdown](./images/cli/mcp.svg)

### API keys

The MCP endpoint (`POST /api/mcp`) authenticates with `Authorization: Bearer <key>`, and the key must
carry the `mcp` scope. The hashed key store is the sole authority — `MCP_API_KEY` in the env file is
**not** a credential and nothing is seeded at boot (SEC-MCP-8), so a key must be created explicitly.

```bash
cihub api-key create --name "laptop"                # scope defaults to 'mcp'
cihub api-key create --name "agent" --scopes mcp,app
cihub api-key list                                  # id, name, scopes, prefix
```

The raw key is printed **once** at creation; store it immediately. Revoke keys in
**Settings → Security**. Names beginning `app:` are reserved for keys the Hub provisions to
marketplace apps.

Connect an external MCP client with:

```json
{ "mcpServers": { "ci-hub": { "url": "http://<hub-host>:5002/api/mcp", "headers": { "Authorization": "Bearer <key>" } } } }
```

---

## Maintenance

```bash
cihub doctor [env]         # validate env files, Docker access, and bind mounts
cihub clean [env] [--yes]  # remove generated host-state files for one environment
cihub reset [env] [--yes]  # remove runtime state for one environment
cihub uninstall [--yes]    # full machine cleanup of CI-Hub runtime state
```

`reset` is the environment-focused cleanup path. `uninstall` is the full machine cleanup path.

---

## Environments

All commands accept an optional `[env]` argument:

| Value | Env file | Compose files |
|-------|----------|---------------|
| `local` (default) | `.env.local` | `docker-compose.local.yml` |
| `dev` | `.env.dev` | `docker-compose.prod.yml` |
| `staging` | `.env.staging` | `docker-compose.prod.yml` + `docker-compose.staging.yml` |
| `prod` | `.env.prod` | `docker-compose.prod.yml` |
