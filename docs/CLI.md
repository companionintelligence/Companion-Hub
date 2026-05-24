# CI-Hub CLI

The Hub CLI is available via:

```bash
pnpm run hub -- <command> [args]
```

## Help and MAN

- `pnpm run hub -- --help` (or `-h`) prints command help
- `pnpm run hub -- man` prints a manual-style command reference

## Commands

### Wizard

```bash
pnpm run hub -- wizard [env]
```

Runs a guided interactive flow for setup/start/register/config actions.

### Setup

```bash
pnpm run hub -- setup [env]
```

Initializes Traefik and Docker auth config.

### Register with Cloud Portal

```bash
pnpm run hub -- register [env]
```

Prints a registration URL containing your machine device ID for CI Cloud pairing.

### Hub lifecycle

```bash
pnpm run hub -- up [env] [--detached]
pnpm run hub -- shutdown [env]
pnpm run hub -- config [env]
```

Starts/stops the Hub stack and prints resolved config values.

### MCP lifecycle

```bash
pnpm run hub -- mcp setup [env]
pnpm run hub -- mcp shutdown [env]
pnpm run hub -- mcp config [env]
```

Enables/disables MCP in the env file and ensures `MCP_API_KEY` exists when enabled.

### Container app lifecycle (local Docker)

```bash
pnpm run hub -- app list
pnpm run hub -- app add <name> <image> [--port host:container] [--env KEY=VALUE]
pnpm run hub -- app edit <name> <image> [--port host:container] [--env KEY=VALUE]
pnpm run hub -- app start <name>
pnpm run hub -- app stop <name>
pnpm run hub -- app restart <name>
pnpm run hub -- app delete <name>
```

These commands manage local Docker containers directly.

## Environments

Supported environment values: `local`, `dev`, `staging`, `prod`.
