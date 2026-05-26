# CI-Hub CLI

The preferred packaged executable is:

```bash
cihub <command> [args]
```

Compatibility command while developing inside the repository:

```bash
pnpm run hub -- <command> [args]
```

## Package-manager installs

```bash
npm install -g ci-hub
cihub --help
```

One-off execution with NPX:

```bash
npx --package ci-hub cihub --help
```

Homebrew and other package managers should expose the same `cihub` executable on the user's `PATH`.

The screenshots below were captured from the packaged `cihub` executable in a demo sandbox so each command flow renders consistently without depending on live Docker services or root access.

## On-device CLI / TUI testing loop

Use the packaged CLI together with the focused Vitest suite for fast local verification of command rendering and developer workflows:

```bash
cihub purge --yes
cihub hot-reload local
cihub wizard
pnpm run test:cli
```

- `cihub purge --yes` removes CI-Hub Docker state plus CI-Hub entries from `.local`, `.config`, and `.cache` so clean-slate installs are reproducible on one machine.
- `cihub hot-reload local` starts infra plus backend/frontend from source, which keeps CLI/TUI iteration tight without rebuilding the full Docker stack.
- `pnpm run test:cli` is the focused on-device presentation harness for help, MAN, and wizard flows.

## Branded terminal preview

These zoomed previews keep the Companion Intelligence ASCII banner readable before the full command walkthroughs below.

<p>
  <img src="./images/cli/banner-help.svg" alt="Zoomed screenshot of the cihub help banner" width="960" />
</p>

<p>
  <img src="./images/cli/banner-wizard.svg" alt="Zoomed screenshot of the cihub wizard banner" width="960" />
</p>

## Help and MAN

- `cihub --help` (or `-h`) prints command help
- `cihub man` prints a manual-style command reference

![Screenshot of `cihub --help`](./images/cli/help.svg)

![Screenshot of `cihub man`](./images/cli/man.svg)

## Commands

### Wizard

```bash
cihub wizard [env]
```

Runs a guided interactive flow for setup/start/register/config actions.

![Screenshot of `cihub wizard`](./images/cli/wizard.svg)

### Setup

```bash
cihub setup [env]
```

Initializes Traefik and Docker auth config.

![Screenshot of `cihub setup local`](./images/cli/setup.svg)

### Register with Cloud Portal

```bash
cihub register [env]
```

Prints a registration URL containing your machine device ID for CI Cloud pairing.

![Screenshot of `cihub register local`](./images/cli/register.svg)

### Hub lifecycle

```bash
cihub up [env] [--detached]
cihub shutdown [env]
cihub config [env]
```

Starts/stops the Hub stack and prints resolved config values.

![Screenshots of `cihub config`, `cihub up`, and `cihub shutdown`](./images/cli/lifecycle.svg)

### Developer workflow

```bash
cihub purge [--yes]
cihub hot-reload [env]
```

- `cihub purge` is the clean-slate command for local troubleshooting, credential resets, and reinstall testing. It removes Docker containers/networks/volumes plus CI-Hub config and cache directories.
- `cihub hot-reload` starts the backend and frontend from source after bringing up local infrastructure, so CLI/TUI and marketplace iteration can be checked without a full rebuild.

### MCP lifecycle

```bash
cihub mcp setup [env]
cihub mcp shutdown [env]
cihub mcp config [env]
```

Enables/disables MCP in the env file and ensures `MCP_API_KEY` exists when enabled.

![Screenshots of `cihub mcp setup`, `cihub mcp config`, and `cihub mcp shutdown`](./images/cli/mcp.svg)

### Container app lifecycle (local Docker)

```bash
cihub app list
cihub app add <name> <image> [--port host:container] [--env KEY=VALUE]
cihub app edit <name> <image> [--port host:container] [--env KEY=VALUE]
cihub app start <name>
cihub app stop <name>
cihub app restart <name>
cihub app delete <name>
```

These commands manage local Docker containers directly.

![Screenshot of `cihub app list`](./images/cli/app-list.svg)

![Screenshots of `cihub app add`, `app edit`, `app start`, `app stop`, `app restart`, and `app delete`](./images/cli/app-management.svg)

## Environments

Supported environment values: `local`, `dev`, `staging`, `prod`.
