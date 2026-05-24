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

## Help and MAN

- `cihub --help` (or `-h`) prints command help
- `cihub man` prints a manual-style command reference

## Commands

### Wizard

```bash
cihub wizard [env]
```

Runs a guided interactive flow for setup/start/register/config actions.

### Setup

```bash
cihub setup [env]
```

Initializes Traefik and Docker auth config.

### Register with Cloud Portal

```bash
cihub register [env]
```

Prints a registration URL containing your machine device ID for CI Cloud pairing.

### Hub lifecycle

```bash
cihub up [env] [--detached]
cihub shutdown [env]
cihub config [env]
```

Starts/stops the Hub stack and prints resolved config values.

### MCP lifecycle

```bash
cihub mcp setup [env]
cihub mcp shutdown [env]
cihub mcp config [env]
```

Enables/disables MCP in the env file and ensures `MCP_API_KEY` exists when enabled.

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

## Environments

Supported environment values: `local`, `dev`, `staging`, `prod`.
