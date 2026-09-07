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

## Headless — no graphical session required

Everything the Hub does runs in Docker; only the desktop *UI* needs a display.
On an SSH-only machine, a server, or in CI (including coding agents driving the
box), use one of these instead of launching the GUI:

```bash
companion-hub --detached   # one-shot headless start of the Hub stack, then exits
cihub up                   # same, via the CLI
cihub status               # containers, tunnel, VPN, models
cihub register --code <c>  # pair with Companion Portal (required for marketplace installs)
```

Discoverability guarantees:

- The Linux packages (.deb/.rpm) install the bundled CLI at **`/usr/bin/cihub`**,
  executable immediately after `apt install` — no first GUI launch required.
- `companion-hub --help` and `--version` work without a display (they never
  touch GTK).
- Launching `companion-hub` in desktop mode with no `DISPLAY`/`WAYLAND_DISPLAY`
  prints guidance pointing to `--detached` and `cihub` and exits with status 2,
  instead of panicking inside the GTK backend.
- `apt show companion-hub` mentions the headless entry points in the package
  description.

Developer stack override (attach to an externally managed compose stack instead
of the bundled one — skips reconciliation):

```bash
CI_HUB_STACK_DEV=1 \
CI_HUB_STACK_DEV_COMPOSE_PATH=/path/to/docker-compose.yml \
CI_HUB_STACK_DEV_ENV_PATH=/path/to/.env \
companion-hub --detached
```

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

Prints your device ID and the Companion Portal registration URL. Open the URL in a browser to pair the device, then proceed to `cihub up`.

Marketplace compose downloads and registry JWTs require the device key Portal issues at pairing ([CI-Portal#634](https://github.com/companionintelligence/CI-Portal/pull/634)). Hub always tries to send it. If this machine is not paired, or cannot store the key, store installs fail and tag lists can look empty — the UI may look slow rather than unauthorized.

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
- After a reset (no `~/.local/share/companion-hub` seed), `cihub up prod` prompts interactively for a database password and writes a fresh install. Set `POSTGRES_PASSWORD` (or `CIHUB_POSTGRES_PASSWORD`) to skip the prompt.
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
cihub api-key create --name "laptop"   # operator keys carry the 'mcp' scope
cihub api-key list                     # id, name, scopes, capability, prefix
```

The raw key is printed **once** at creation; store it immediately. Revoke keys in
**Settings → Security**.

`create` also accepts `--capability read|write|full`, which decides what the key may do on the
surfaces its scopes opened — `write` is the default. Raise or lower an existing key's capability in
**Settings → Security**; the CLI has `create` and `list` only.

Operator keys carry `mcp` only. The `app` scope belongs to **managed** keys the Hub provisions to
installed apps and revokes on uninstall — the callback guard resolves the key's owning app, so an
operator key carrying `app` would authenticate nothing. Names beginning `app:` are reserved for the
same reason.

Connect an external MCP client with:

```json
{ "mcpServers": { "ci-hub": { "url": "http://<hub-host>:5002/api/mcp", "headers": { "Authorization": "Bearer <key>" } } } }
```

---

## Connect an agent

Wire an agent installed **on this host** to Companion Memory, so it gets passive capture and injected
context rather than memory tools it has to call. This is the memory-provider path, not MCP — the two
are independent.

```bash
cihub connect openclaw --memory-url <url> --memory-key <key>
cihub connect hermes   --memory-url <url> --memory-key <key>
```

| Flag                           | Effect                                                               |
| ------------------------------ | -------------------------------------------------------------------- |
| `--memory-url`, `--memory-key` | Companion Memory base URL and API key. Required; prompted on a TTY   |
| `--hub-url`, `--hub-key`       | Also register the Hub MCP server. Both or neither                    |
| `--force`                      | Claim the memory slot even if another provider holds it (`openclaw`) |
| `--dry-run`                    | Print the plan and write nothing                                     |

**The memory key is not the MCP key above.** The provider talks REST, so the key needs the `Memory`
scope (plus `Intents` for the intent tools) at **Read & write**. A key minted for MCP alone
authenticates and is refused on every capture call, and the plugin swallows failed writes rather than
break a session — which is why the probe checks the key and not just the address.

### What it does

Everything is probed before anything is written, so a failed probe leaves the machine exactly as it
was. Memory is checked twice — `/api/health` for reachability, then `/api/memory/context`, which is
scope-guarded and therefore actually exercises the key. Hub, when its flags are given, is checked
with a real `initialize` + `tools/list` handshake and the tool count is reported.

Both memory legs go out under the User-Agent the agent's own plugin sends, because a probe that
identifies as a different client can only prove something about itself: the hermes plugin talks
urllib, whose default `Python-urllib/x.y` an edge in front of an exposed hub rejects outright. And
because Companion Memory answers in JSON, an HTML error body is reported as a CDN or proxy refusing
the request — not as a bad key, which is the one piece of advice that cannot help there.

For **openclaw** it guards the memory slot first (the guard cannot be delegated: installing by hand
can switch a foreign slot without asking), backs up `openclaw.json`, installs the pinned plugin from
npm, merges the settings the installer does not write — `plugins.slots.memory`, the plugin's `config`
and `hooks.allowConversationAccess`, an additive `tools.alsoAllow`, and disabling the bundled
`session-memory` hook — then validates with `openclaw doctor --lint --json`, restoring the backup if
the lint faults any of the keys it wrote. (It ignores findings about anything else, so a config that
was already untidy is not blamed on this command.) Restart the gateway afterwards with
`openclaw daemon restart` — that manages a service install; a gateway you started by hand has to
be stopped and started yourself. `openclaw daemon status` says which you have.

For **hermes** it stages the pinned plugin tarball into `~/.hermes/plugins/companionintelligence`,
swapping it in only once the download succeeded, and writes the `mcp_servers.hub` block into
`config.yaml` when the Hub flags are given — atomically, `0600`, after a backup, and skipped entirely
if the block is already correct. Memory credentials stay with `hermes memory setup`, which owns them
and runs its own connection test, so you still finish with that command. If a Hub server was
written, start a new Hermes session — `mcp_servers` is read at startup. Not
`hermes gateway restart`: that subcommand manages the messaging gateway and does not reload
`config.yaml`.

It configures **the machine it runs on**. For an agent on another machine, follow the per-agent
instructions in the [connect docs](https://docs.ci.computer/docs/connect) — they need no Hub CLI.

| Exit | Meaning                                                |
| ---- | ------------------------------------------------------ |
| `0`  | connected                                              |
| `1`  | a probe failed — nothing was written                   |
| `2`  | a write failed — the backup was restored, path printed |

One exception to `2`: if the hermes plugin installed but its Hub MCP block could not be written, that
is reported in the summary and the run still succeeds — the plugin is in place and useful without it.

Plugin versions are **pinned in the CLI** and bumped deliberately; `connect` never installs `latest`.

---

## Hub Pool

Operate multi-Hub inference pooling from the terminal — the same surface as **Settings → Network →
Hub Pool**. See [`hub-pool.md`](./hub-pool.md) for how pooling works.

```bash
cihub pool status [env]                       # is pooling routing, and why or why not
cihub pool peers [env]                        # paired peers: status, last seen, queue depth, models
cihub pool discover [env]                     # unpaired CI-Hub nodes, from every source
cihub pool probe <address> [env]               # find a Hub by LAN address (no OAuth credential needed)
cihub pool pair <node> [--name <label>]       # send a pairing request (the other Hub must approve)
cihub pool approve <id>                       # accept a pending inbound request
cihub pool reject <id>                        # refuse one
cihub pool unpair <id>                        # remove a peer and revoke both tokens
cihub pool log [env] [--limit N]              # recent routing decisions, failovers marked
cihub pool enable [env] | cihub pool disable  # flip the persisted kill switch
cihub pool enable --outbound | --inbound      # ...or just one direction
cihub pool peer-enable <id> | peer-disable    # take one peer in or out of the pool
```

| Flag | Effect |
| ---- | ------ |
| `--yes` | Skip the confirmation prompt. Required for `pair`/`approve`/`reject`/`unpair`/`enable`/`disable` on a non-interactive terminal |
| `--name <label>` | `pair` only: a display label for the peer |
| `--limit N` | `log` only: how many decisions to show, 1–200 (default: all 200 retained) |

**It runs on the Hub it manages.** Every call goes to `http://127.0.0.1:<API_PORT>` — `cihub pool` on
machine A cannot manage machine B, which matters more than usual for a feature about several Hubs.
Approving a pairing request means running `cihub pool approve` (or clicking Approve) **on the Hub that
received it**.

**It needs the Portal device key**, the same credential the dashboard uses, read from
`state/settings.json`. A Hub that has never run `cihub register` has none, and the command says so
instead of returning a bare 401. A key from `cihub api-key create` is MCP-scoped and is *not* accepted
here.

### Identifying a peer

`approve`, `reject` and `unpair` take the 8-character `ID` from the peers table, the full row uuid, or
the peer's FQDN. An ambiguous prefix is refused rather than guessed. `pair` takes the MagicDNS name a
peer publishes on the tailnet (`hub-b.example-tailnet.ts.net`) — a scheme, port, path or IP address is
rejected before the request is sent.

### `cihub pool discover`

Lists every unpaired candidate, from both sources, with a `FOUND VIA` column saying which. A node
reachable both ways is listed once.

A Tailscale OAuth client (`TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET`,
`devices:core:read`) enumerates the whole tailnet at once and is worth having when a pool spans
several networks. It is **optional**: without one, the empty-list output points at `cihub pool probe`
first and names the variables second.

### `cihub pool probe`

```
cihub pool probe 192.168.1.42
cihub pool probe 192.168.1.42:5010     # a Hub that moved its published API port
cihub pool probe mini-pc.lan
```

Asks what is at that address and prints the node's **tailnet FQDN** to pair with. The address is a
directory lookup and nothing more — it is discarded, and pairing plus every pooled request still go to
`https://<fqdn>` with the same TLS and the same tokens. There is no LAN peer transport and no second
trust model.

Refused: any address that is not RFC1918, CGNAT or IPv6 ULA; a hostname where *any* resolved address is
public; loopback and link-local. With no explicit port it tries 5002 then 3000, and cannot infer a
published port that was moved — name it if so. A Hub found this way but not joined to a tailnet is
reported as found-but-not-pairable, because there is no name to dial.

### `cihub pool log`

The answer to "is pooling actually doing anything". One line per routing decision — time, direction,
model, the node that served it, which ranked candidate won, time to response headers, and outcome — with
a `↳ failed over from …` line naming the chain whenever a candidate was tried and rejected. `in` rows are
work a *peer* sent to this node's engines.

The log is in-memory, process-local and holds the last 200 decisions, so an empty log means "nothing
routed since this Hub started", not "nothing ever routed". Duration is time to headers, not the streamed
generation.

### `cihub pool enable` / `disable`

With no flag these write the persisted **master** `poolEnabled` setting through the Hub API; they take
effect on the next request, with no restart. **`HUB_POOL_USER_DISABLED=true` in the env file wins.** Under
that override, `enable` saves the setting and then says plainly that nothing changed in effect, naming the
file to edit and the restart needed — it never reports success it did not deliver.

Disabling keeps existing pairings. Peers mark this node unreachable while it is off and pick it back up
on their next successful health poll.

`--outbound` and `--inbound` write one half instead, each with its own env override
(`HUB_POOL_OUTBOUND_DISABLED`, `HUB_POOL_INBOUND_DISABLED`) and the same refusal to claim a success it did
not deliver. Pass at most one; passing neither is what "the master switch" means.

- `disable --outbound` stops this Hub sending work to peers. Peers may still send work here, and a request
  this node cannot serve now fails locally with the usual 502 instead of being shipped out.
- `disable --inbound` stops this Hub serving peers' work while it keeps using them. Peers see a healthy
  node advertising an empty inventory — **not** an unreachable one — and route elsewhere.

`cihub pool status` prints both directions with the switch actually responsible for each.

### `cihub pool peer-enable` / `peer-disable`

Take one peer in or out of the pool. Symmetric: no work moves in either direction with a disabled peer.
The pairing, both directional tokens and the health poll are kept, so re-enabling is instant and needs no
approval from the other side — and disabled peers keep being polled, so the status card stays honest about
a machine that is up. It is therefore **not** a revocation; `cihub pool unpair` is. Disabled peers print as
`connected/off` in the peer table.

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

## Implementation map

The command surface is stable; this is where each part lives, for anyone changing it.

`bin/cihub.cjs` → `scripts/start.ts` → `runCli()` in `scripts/lib/cli-dispatch.ts`, which matches
`argv[0]` and calls the module that owns the handler. There is no argument-parsing library; flag
normalization is in `scripts/lib/cli-args.ts`.

| Module | Commands |
|---|---|
| `cli-lifecycle.ts` | `up`, `setup`, `config` |
| `cli-teardown.ts` | `down`, `restart`, `recreate`, `clean`, `reset` |
| `cli-doctor.ts` | `status`, `logs`, `doctor`, `uninstall` |
| `cli-register.ts` | `register`, `device-id` |
| `cli-app.ts` | `app` |
| `cli-models.ts` | `models`, `mcp`, `public-web` |
| `cli-pool.ts` | `pool` |
| `cli-api-key.ts` | `api-key` |
| `cli-update.ts` | `version`, `update`, `connect` |
| `cli-wizard.ts` | `wizard` |
| `catalog-submit.ts` | `login`, `logout`, `submit` |

Shared pieces: `cli-args.ts` (flags and env resolution), `cli-repo-context.ts` (checkout vs packaged
appliance), `hub-context.ts` (env file, compose files, and working directory for the resolved
context), `cli-prompt.ts` (every confirmation, so the non-TTY refusal is worded the same everywhere),
`cli-proc.ts` (process execution), `cli-ui.ts` (colors, boxes, help and man rendering),
`cli-compose-env.ts` (env file and compose profile handling), `docker-engine.ts` (engine discovery
and pinning).

`scripts/cihub-cli.ts` is a re-export facade kept so `scripts/__tests__/cihub-cli.test.ts` has one
stable import site. New code should import from the owning module instead.

### Adding a command

1. Add the handler to the module that owns that command group, or a new `scripts/lib/cli-<name>.ts`.
2. Route it in `cli-dispatch.ts`.
3. Add it to `commandSections` in `cli-ui.ts` so it appears in `--help` and `man`.
4. Test the handler in `scripts/__tests__/`, and the routing in `cli-dispatch.test.ts`.

Retired commands stay routed to `printRemovedCommand` with their replacement rather than being
deleted, so an old script fails with guidance instead of "unknown command".

### Two distributions

`bin/cihub.cjs` runs the TypeScript through `tsx` at each invocation — that is the npm install.
`pnpm run build:cli` (`scripts/build-standalone-cli.cjs`) instead bundles it with Bun into a single
executable for six targets, which is what the desktop app bundles and installs onto `PATH`.

---

## Environments

All commands accept an optional `[env]` argument:

| Value | Env file | Compose files |
|-------|----------|---------------|
| `local` (default) | `.env.local` | `docker-compose.local.yml` |
| `dev` | `.env.dev` | `docker-compose.prod.yml` |
| `staging` | `.env.staging` | `docker-compose.prod.yml` + `docker-compose.staging.yml` |
| `prod` | `.env.prod` | `docker-compose.prod.yml` |
