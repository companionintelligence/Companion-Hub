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
cihub claim --email <a>    # create the first operator headlessly (after register)
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

**Over SSH, pass `--code`.** The pairing-code prompt needs a terminal and `ssh -n` has none, so with
no terminal and no `--code` the command refuses immediately (exit `2`) naming the flag, rather than
blocking on a stdin that will never answer — which is what it used to do before exiting `0` having
registered nothing. There is deliberately no assume-yes opt-in: assuming yes cannot invent a pairing
code, and only your CI Account can produce one.

```bash
cihub register local
```

![Screenshot of cihub register local](./images/cli/register.svg)

### `cihub claim [env] [--email <addr>]`

Creates this Hub's **first operator**, without a browser. Run it on the Hub, after `cihub register`.

Registration and claiming are two different things, and only one of them was ever headless.
`cihub register` pairs the appliance and writes `ciHubApiKey` and `ciHubOrganizationId` into
`state/settings.json`. It does **not** create a row in the `user` table — that row was written only
by an interactive Portal sign-in landing on `/api/auth/portal/callback`, and `POST /api/auth/register`
cannot finish unattended because Portal answers it with `requiresEmailVerification`.

A Hub in that state is paired, keyed, and unable to authenticate anybody: the device key is accepted,
there is no operator for it to speak as, and every guarded route answers **409
`AUTH_ERROR_HUB_NOT_CLAIMED`** — *"This Hub is registered but has no operator yet"*. It used to answer
`401 SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN`, which is why twelve of sixteen nodes on the Hub Pool fleet
were diagnosed for a week as having bad device keys. The keys were fine.

What `claim` requires, and why none of it is a new way in:

| Gate | Why it is not a weakening |
|---|---|
| The host-local device key | It lives in `<data-dir>/state/settings.json`; presenting it means you can already read the Hub's credentials off the disk |
| The Hub must be registered | Pairing is what proved organization membership; an unpaired Hub has no organization for an operator to belong to |
| There must be no operator yet | First-operator bootstrap is the one admission that skips the Portal membership check, so it happens at most once |

The row itself is written by `admitHubPerson` — the same function the browser path calls — so there
is exactly one place that decides who may become an operator on this appliance.

**Safe to re-run.** A Hub that already has an operator is reported and the command exits `0`, the
same shape `cihub register` takes when the Hub is already registered, so an installer replaying the
whole flow does not trip on the one step that is done. With no terminal and no `--email` it exits `2`
naming the flag rather than blocking on a stdin that will never answer.

```bash
cihub claim --email you@example.com
```

Afterwards, sign in through CI Portal with the same address for a browser session; anyone else in
the organization is admitted the normal way, membership-checked.


### `cihub login [--scope <scope>]`

Signs this machine in to Companion Portal and stores an organization developer token in
`~/.config/cihub/portal-login.json` (mode `0600`). One browser approval, once — the token is what
later commands present.

```bash
cihub login                            # catalog:write, for cihub submit
cihub login --scope device:pair        # register devices without a browser
cihub login --scope device:manage      # …and list, re-register or release them (cihub fleet devices)
cihub login --device                   # device-code flow; automatic over SSH
```

| Scope | What the token may do |
| --- | --- |
| `catalog:write` (default) | Submit apps to the marketplace catalog (`cihub submit`) |
| `device:pair` | Register devices into the organization, which is what mints pairing codes |
| `device:manage` | Everything `device:pair` may, plus list the organization's devices, mint a replacement pairing code for one, and delete one — what [`cihub fleet devices`](#cihub-fleet-devices) needs |

**They do not overlap upward.** A `catalog:write` token cannot register a device and a `device:pair`
token cannot publish an app or delete a device; each is refused with `401` by the other's routes.
`device:manage` is its own scope rather than a widening of `device:pair` so that a fleet install,
which only needs to enrol machines, never holds a token that can destroy their records. All are
org-scoped and revocable from Portal, and none is a device key — pairing is what mints one of those.

A token reaches exactly the organizations its holder is a member of. Portal runs the same membership
check it runs for a browser session, so signing in headlessly removes the human, not the
authorization.

### Registering a fleet without a browser

`cihub register` wants a pairing code, and a code is one device. Minting fourteen of them by hand is
fourteen trips through the Portal UI, which is why `cihub fleet install` mints its own once a
`device:pair` login is stored:

```bash
cihub login --scope device:pair
export CIHUB_POSTGRES_PASSWORD=...
cihub fleet install --nodes core-1,core-2 --user ci --execute
```

Each node is registered under its roster name and gets its own code. Two guardrails are worth
knowing, because both fail in ways a dry run does not show:

- **`--code` with more than one node is refused**, not spent. One code enrolls one device, so using
  it across a fleet would enroll the first machine and fail the rest on a code Portal had already
  burned — halfway through installing on real hardware.
- **A node that cannot be registered is reported and skipped**, not aborted on. A name already taken
  in the org (usually: this node was enrolled before) says so by name, and the rest of the fleet
  continues.

Without a stored `device:pair` login, `--code` still works for a single node exactly as before.

### `cihub status --write-status-file`

Copies this node's status report to the operator's Desktop as `CI_HUB_STATUS.md` — connection
details, the LLM backends running, the models installed, the containerized workloads, and system
status, for auditing a fleet without opening a dashboard per box.

```bash
cihub status --write-status-file
```

**The Hub writes the report; this command only delivers it.** Every service that knows the answers
lives in the backend process, and the CLI holds no credential for the guarded routes that expose
them (`pool/status`, `apps/installed` and `system-inspector` are all behind `AuthGuard`), so
composing it here would mean provisioning an API key on every node just to audit it. The backend
writes `<data-dir>/state/CI_HUB_STATUS.md` every 15 minutes; `fleet install` installs a systemd user
timer that copies it to the Desktop on the same cadence.

Two things the output tells you that the file alone would not:

- **Where it went.** `~/Desktop` is not a given — `xdg-user-dirs` is often unset on a server
  install, the directory is localised, and an appliance brought up with `sudo` has `root` as the
  host user. With no Desktop the file stays in the data dir and the command says so, rather than
  inventing a path.
- **How old it is.** The report carries its own `Generated` timestamp. A stale one means the Hub
  that writes it is not running, so the contents describe when it last ran — not what is running
  now. Past 45 minutes the command says so out loud.

The report distinguishes an unreadable section from an empty one throughout. "No workloads" means
none are installed; a section that could not be read says so and is listed at the top of the file.
It also prints the Hub's own belief about an app beside the live container state, so the case that
matters to an audit — an app the Hub calls `running` with nothing actually up — is visible rather
than averaged away.

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

## Keeping the CLI and the stack together

`cihub` and the Hub stack image ship on **two independent channels**, and moving one has never moved
the other:

| | Artifact | Moved by |
|---|---|---|
| CLI | `cihub` — inside the desktop package, as a Homebrew cask / Scoop app, or as a standalone `cihub-<os>-<arch>` release asset | `companion-hub update`, `brew upgrade --cask companion-hub`, `scoop update companion-hub`, `cihub self-update` |
| Stack | `ghcr.io/companionintelligence/ci-hub:<tag>` | `cihub pool update`, the Hub's own [stack self-update](hub-stack-self-update.md), `cihub fleet update --hub` |

Drift between them is silent and it breaks runbooks. Measured on `beta-max`, 2026-09-21: `cihub
version` said `0.2.72`, the running stack was an untagged GHCR index matching no published tag, and
`cihub pool ceiling` — merged, released and documented — answered `Unknown pool subcommand`. Every
local check was green.

Three commands now report it, and they all give the same answer:

- **`cihub doctor`** carries a `CLI vs stack` line naming both versions.
- **`cihub update`** prints the comparison before it does anything.
- **`cihub pool update`** prints it after the redeploy — the moment the skew is created.

### How the two sides are identified

The CLI reports the version stamped into it at build time, plus the commit when the build stamped
one (`cihub version` shows `cihub 0.2.73 (abc123def)` on a `dev` or pre-tag build).

The stack is read off the running container and **never** from `CI_HUB_VERSION` — that value comes
from the install's env file, no build writes it, and it was wrong on 10 of 16 fleet Hubs on
2026-09-17. In order: a version tag in the image reference, then `org.opencontainers.image.version`
when it is version-shaped, then the highest version tag Docker holds locally for the same image.

A `:dev` image, a digest pin and a local build match none of those, so the commit
(`org.opencontainers.image.revision`) is compared instead. When neither a version nor a commit is
available on both sides, that is reported as **cannot be compared** rather than as a match.

**Only a proven mismatch fails `cihub doctor`** — two builds that each name a release and name
different ones. A `:dev` node whose image carries no release tag is a yellow note, because that state
is normal there.

### `cihub self-update`

```bash
cihub self-update                 # install the release the running stack is on
cihub self-update --to 0.2.73     # install a specific release
cihub self-update --check         # report what would be installed; change nothing
```

Replaces **a standalone `cihub` binary** with a release asset, in place. It is the missing half on a
headless appliance, where the CLI arrives once through `cihub fleet install` and nothing ever moves
it again. It does not touch the Hub stack — `cihub pool update` is that half.

The default target is the release the **stack** runs, not the newest one: the point is to end the
skew on this machine, and pulling `latest` onto a node pinned two releases back would just invert it.
When the stack names no release, it falls back to the newest and says so.

It refuses, with the right command instead, when:

| Situation | Why |
|---|---|
| Installed by Homebrew or Scoop | Overwriting the file leaves the manifest claiming a version that is not on disk, and the next upgrade reverts it |
| Shipped inside the desktop app | The desktop updater replaces the app and its bundled CLI as one artifact |
| Running from a source checkout | There is no binary to replace — `git pull`, then `node scripts/build-standalone-cli.cjs` |
| Windows | Windows cannot replace a running executable |
| No `GH_TOKEN`/`GITHUB_TOKEN` | The CI-Hub releases are **private**; unauthenticated the API answers 404, which reads like "no such release" |

Before anything is replaced, the downloaded asset is staged beside the target on the same
filesystem, run once to make it identify itself, and checked against the version that was asked for.
A candidate that will not run — a wrong-architecture asset exits 126 — is discarded and the existing
`cihub` is left exactly where it was.

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
cihub api-key create --name "laptop"                        # MCP key (the default scope)
cihub api-key create --name "fleet-qa" --scope qa:read      # read-only test key (see below)
cihub api-key create --name "laptop-zed" --scope inference  # editor or SDK key (see below)
cihub api-key list                                          # id, name, scopes, capability, prefix
```

The raw key is printed **once** at creation; store it immediately. Revoke keys in
**Settings → Security**.

`--scope` and `--scopes` are the same flag; give one, not both. A `qa:read` key reads pool status, the pool routing log,
one app's status (without its config), and the install queue. Every other GET answers it 403, and any write
answers 401, because the Hub only looks the key up on a read.
Mint it for a test harness or a monitor instead of handing out the device key. It must be the only
scope on its key, and it is stored as `read`. A Hub built before `qa:read` existed accepts the row
but authenticates nothing with it. See
[Reading these without an operator credential](hub-pool.md#reading-these-without-an-operator-credential).

An `inference` key opens the OpenAI-compatible routes under `/api/inference/v1` and the app-facing
pool proxy under `/api/inference/pool`, and nothing else. The Hub reads it only when a request
arrives from outside the appliance network — through the Cloudflare tunnel, or from a public
address — so an editor on the LAN or tailnet is admitted by origin and the key is never looked up.
It must be the only scope on its key and is stored as `read`; capability gates MCP tools only, so
`--capability write|full` is refused. A Hub built before `inference` existed accepts the row but
authenticates nothing with it. See [Use your Hub from your editor](editor-inference.md).

`create` also accepts `--capability read|write|full`, which decides what the key may do on the
surfaces its scopes opened — `write` is the default. Raise or lower an existing key's capability in
**Settings → Security**; the CLI has `create` and `list` only.

A key you create with the CLI records no creator, because nobody is signed in. It keeps its per-app
reach on every app, and it can't change an app's custom domain. **Settings → Security** marks it
"Creator unknown". A key created in **Settings → Security** acts with the grants and role of the
person who created it, so create a key there to limit it to one person's access.

Operator keys carry `mcp`, `qa:read`, or `inference` — the last two alone on their key. The `app`
scope belongs to **managed** keys the Hub provisions to installed apps and revokes on uninstall —
the callback guard resolves the key's owning app, so an operator key carrying `app` would
authenticate nothing. Names beginning `app:` are reserved for the same reason.

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
cihub pool doctor [env] [--check-latency]     # preflight: can this node be a pool member, and will peers reach it
cihub pool update [env]                       # pull the published image and redeploy — no build toolchain needed
cihub pool peers [env]                        # paired peers: status, last seen, queue depth, models
cihub pool discover [env]                     # unpaired CI-Hub nodes, from every source
cihub pool probe <address> [env]              # is there a CI-Hub at this LAN address?
cihub pool pairing-pin [env]                  # mint the six digits the other Hub will need
cihub pool cancel-pin [env]                   # revoke the outstanding PIN before it expires
cihub pool pair <node> [--name <label>]       # send a pairing request (the other Hub must approve)
cihub pool pair <address> --pin <digits>      # ...or pair by LAN address, no OAuth credential needed
cihub pool approve <id>                       # accept a pending inbound request
cihub pool reject <id>                        # refuse one
cihub pool unpair <id>                        # remove a peer and revoke both tokens
cihub pool pin <node|local> [--model <id>]    # prefer one node for a model, or for everything
cihub pool unpin [--model <id>]               # drop that preference and rank by load again
cihub pool ceiling <tokens>|clear [env]       # longer prompts go to another node when one can serve them
cihub pool context-cap <tokens>|clear [env]   # cap the num_ctx handed to this node's apps at the engine's context
cihub pool slots <n>|clear [env]              # state how many requests this node's Ollama runs at once (OLLAMA_NUM_PARALLEL)
cihub pool log [env] [--limit N]              # recent routing decisions, failovers marked
cihub pool enable [env] | cihub pool disable  # flip the persisted kill switch
cihub pool enable --outbound | --inbound      # ...or just one direction
cihub pool peer-enable <id> | peer-disable    # take one peer in or out of the pool
```

| Flag | Effect |
| ---- | ------ |
| `--yes` | Skip the confirmation prompt. Required for `pair`/`approve`/`reject`/`unpair`/`enable`/`disable` on a non-interactive terminal |
| `--name <label>` | `pair` only: a display label for the peer |
| `--model <id>` | `pin`/`unpin` only: which model the pin covers. Omit it for the pool-wide pin. Compared verbatim against the engine's inventory, so case matters |
| `--pin <digits>` | `pair` only: the six digits minted on the *other* Hub. Required when the target is an address |
| `--limit N` | `log` only: how many decisions to show, 1–200 (default: all 200 retained) |
| `--check-latency` | `doctor` only: also measure non-streaming first-byte latency. Spends GPU time, so it is skipped otherwise |

**It runs on the Hub it manages.** Every call goes to `http://127.0.0.1:<API_PORT>` — `cihub pool` on
machine A cannot manage machine B, which matters more than usual for a feature about several Hubs.
Approving a pairing request means running `cihub pool approve` (or clicking Approve) **on the Hub that
received it**.

**It needs the Portal device key**, the same credential the dashboard uses, read from
`state/settings.json`. A Hub that has never run `cihub register` has none, and the command says so
instead of returning a bare 401. A key from `cihub api-key create` is *not* accepted here whatever
its scope: `mcp` opens the MCP endpoint, `qa:read` reads status and the routing log, and
`inference` opens the [inference routes](editor-inference.md); none of them is an operator credential.

### `cihub pool status`

The whole operator picture for one node, and the only place pins, the outstanding PIN, and peer
authentication modes are listed — there is no `pool pins` subcommand to keep in step with it.

| Block | What it answers |
| --- | --- |
| `Pooling` / `Outbound` / `Inbound` | Whether work moves, in each direction, and which switch is responsible |
| `Peers` / `Discovery` / `Settings` | Counts, whether the Tailscale Admin API credential is set, and the persisted settings |
| `This node` | Name, tailnet, hardware tier, live queue depth, engines, and this node's pool **identity fingerprint** |
| `Pairing` | Only when a PIN is outstanding: until when, and how to revoke it. Never the digits |
| `Pins` | Each pin with its target resolved, and whether it can apply right now |
| `Peers` table | Per peer: id prefix, name, direction, status (with strikes and `/off`), last seen, queue, **context cap**, engines |
| `Context caps` | Only once any node is capped: this node's cap and every connected peer's, side by side, with a warning when they disagree enough to change where a request goes |
| `Ceiling` / `Prompt ceilings` | Only when set: this node's prompt ceiling (and whether the `.env` sets it), and each peer's advertised one |
| `Measured speed` | Only once something has been timed: prompt and output rates per node, engine and model, with each peer shown as timed here and as it reported itself |
| `Peer auth` | Which peers are still on the legacy bearer token — the precondition for `poolRequireSignedPeers` |
| `Peers refusing this Hub` | Only when a peer answers but refuses this Hub: **identity changed** (its database was recreated) or **credentials refused**, since when, when it is next probed, and the exact re-pair commands. See [A peer whose identity changed](./hub-pool.md#a-peer-whose-identity-changed) |

The `CONTEXT` column and the `Context caps` block exist because a cap is an input to placement: an
app is handed the largest cap among the nodes serving its model, and every node capped below that
window is then placed behind. Three readings, and they never share a cell — a **number** is the cap
routing applies, **`none`** is a peer that answered and named no cap (routing reads that as "takes
any window", so the large windows land there), and **`?`** is a cap nobody here knows, from a peer
never probed or a Hub predating the field. An absent cap is never drawn as a number, and `none` is
never drawn as `?`. The block's warnings distinguish a deliberate spread (a batch-tier node capped
low, which placement is built for) from an uncapped node among capped ones, which is the one that
collects windows its own `OLLAMA_CONTEXT_LENGTH` may not run. `cihub pool peers` carries the same
column, and one line when the peers disagree. `cihub pool doctor` decides the same question as
check **F2**.

The `Peer auth` block exists because turning on `poolRequireSignedPeers` while any peer is still on a
bearer token takes **both** directions of that pairing down. The upgrade runs on a health poll by
itself, so the block names the peers not there yet, and says plainly when the switch has become safe
to set. Peers that have not finished pairing are not counted either way.

### `cihub pool ceiling`

`cihub pool ceiling 16000` asks the pool not to send this node prompts estimated over 16000 tokens
while another node can serve them; `cihub pool ceiling clear` removes it. Use it on a node that serves
a model on CPU, where prefill slows as the context grows. See
[Prompt ceilings](./hub-pool.md#prompt-ceilings) for how it is applied.

The value is a whole number from 1024 to 1048576 — no `16k`, which means different numbers to different
people. The box reports the ceiling actually in force after the write: when
`HUB_POOL_MAX_PROMPT_TOKENS` is set in the Hub's environment it wins, and the box says the command
changed nothing in effect.

### `cihub pool context-cap`

`cihub pool context-cap 16384` caps the context window (`num_ctx`) this node's Hub hands its apps at
16384 tokens; `cihub pool context-cap clear` removes the cap. It is the Hub's half of Ollama's
`OLLAMA_CONTEXT_LENGTH`: set both to the same number and no app asks for a window the engine does
not run, so nothing reloads — see
[Context caps](./hub-pool.md#context-caps-the-window-an-app-asks-for-is-the-window-the-engine-runs)
for the 25 GB → 44 GB reload that made it a setting. Across a fleet, `cihub fleet backends
--ollama-context N --execute` sets both halves on every node ([below](#ollamas-runtime-environment-a-second-file-restarted-only-on-change));
this command is the single-node form, for a node whose engine was configured some other way.

The value is a whole number from 2048 to 1048576, digits only. Confirmed like `ceiling`, because it
is a state change — and one that restarts the AI apps whose env it changes. The command reads
`GET /api/inference/preferences` before the write (a cap that already reads as requested is left
alone, so nothing restarts) and again after it, and the box reports the cap in force rather than the
one requested. The write goes through `PATCH /api/inference/preferences`, the route that can remove
the key; a Hub whose preferences carry no `maxNumCtx` predates the cap and is told so without a
write. `cihub pool status` shows the cap under **This node**, and every connected peer's next to it
under **Context caps**.

### `cihub pool slots`

`cihub pool slots 4` states that this node's Ollama runs 4 requests at once; `cihub pool slots clear`
withdraws the statement. It is the Hub's half of Ollama's `OLLAMA_NUM_PARALLEL`, the way `context-cap`
is the half of `OLLAMA_CONTEXT_LENGTH`: the pool ranks by queue depth and cannot otherwise tell a
full 2-slot engine from a half-empty 4-slot one, and with `poolSlotAwareness` switched on an entry
node places behind every node that still has a free slot before a node whose slots are full — see
[Slot-aware placement](./hub-pool.md#slot-aware-placement) for the 0.47 s → 9.0 s first-token wait
that made it a setting. Across a fleet, `cihub fleet backends --ollama-parallel N --ollama-context C
--ollama-keep-alive D --execute` sets both halves on every node
([below](#ollamas-runtime-environment-a-second-file-restarted-only-on-change)) — with the node's
other runtime flags on the same line, because that file is rendered whole from the flags it is
given and `--ollama-parallel N` alone would drop `OLLAMA_KEEP_ALIVE` and `OLLAMA_CONTEXT_LENGTH`
from every node it touches; this command is the single-node form, and touches no daemon.

The value is a whole number from 1 to 64, digits only, the bounds `--ollama-parallel` accepts.
Confirmed like `context-cap`, because it is a state change — though unlike the cap it restarts
nothing: it changes what this node advertises to peers and how the pool ranks it, not any app's
environment. The command reads `GET /api/inference/preferences` before the write (a count already in
force is left alone) and again after it, and the box reports the count in force rather than the one
requested. The write goes through `PATCH /api/inference/preferences`, the route that can remove the
key; a Hub whose preferences carry no `ollamaSlots` predates the setting and is told so without a
write. `cihub pool status` shows the count under **This node**, with whether `poolSlotAwareness` is
on here.

### Identifying a peer

`approve`, `reject` and `unpair` take the 8-character `ID` from the peers table, the full row uuid, or
the peer's FQDN. An ambiguous prefix is refused rather than guessed.

`pair` takes either the MagicDNS name a peer publishes on the tailnet
(`hub-b.example-tailnet.ts.net`), or a LAN address with `--pin`. Anything that is not a plausible
MagicDNS name is read as an address, and an address without a PIN is refused with the reason: an
address can reach the other Hub but cannot *name* it, and a peer is stored under its tailnet name.

### `cihub pool discover`

Lists every unpaired candidate this Hub can *name*, from up to three directories: the local Tailscale
daemon's peer map, the Tailscale Admin API when a credential is configured, and the CI Portal device
registry on a registered Hub. A node two of them both name is listed once.

**In practice only the two Tailscale directories return anything.** The Portal leg is refused (it
presents a device key to a route that wants a browser session) and would name nothing anyway (Portal
stores no MagicDNS field), and it fails silently — so an empty list is not evidence your Hub is
unregistered. See
[`hub-pool.md` → Where pairing candidates come from](hub-pool.md#where-pairing-candidates-come-from). A Hub found with
`cihub pool probe` is **not** here and never will be: entries are paired with by handing their name
to `pool pair`, and an address has no name until the PIN exchange produces one.

A Tailscale OAuth client (`TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET`,
`devices:core:read`) enumerates the whole tailnet at once and is worth having when a pool spans
several networks. It is **optional**, and it is the only one of the three that needs a credential:
a tailnet-connected Hub already lists the peers its own daemon can see. Without the OAuth client, the
empty-list output points at `cihub pool probe` first and names the variables second.

The `Discovery` line in `cihub pool status` reports **only** the Tailscale credential, because that is
the only candidate directory `GET status` reports on — the daemon peer map and the Portal registry are
not in that response (the `Tailscale` line below it is the daemon leg's precondition, not its result).
It is not a report on whether discovery works.

A Hub your CI account knows only by LAN address is not listed: a peer is stored under its tailnet
name, and an IP literal can never be one. Pair with it by address instead. See
[`hub-pool.md` → Where pairing candidates come from](hub-pool.md#where-pairing-candidates-come-from).

### `cihub pool probe` and pairing by address

```
cihub pool probe 192.168.1.42
cihub pool probe 192.168.1.42:5010     # a Hub that moved its published API port
cihub pool probe mini-pc.lan
```

Asks whether a CI-Hub is at that address and which pool protocol it speaks. It does **not** report a
name, and the output says so: `GET /api/inference/pool/identify` is unauthenticated and reachable
through the public tunnel, so it discloses no MagicDNS name to anybody.

The name comes from pairing, gated on a PIN:

```
on the other Hub:  cihub pool pairing-pin              # six digits, ten minutes, single-use
here:              cihub pool pair 192.168.1.42 --pin 123456
```

The PIN authenticates the request; the reply carries that Hub's tailnet name (and its node UUID and
public key, so the pairing starts out signed rather than on a bearer token). The peer is stored under
that name, and every pooled request goes to `https://<name>` with the same TLS and the same
credentials. The address was only ever a way to reach the handshake.

Refused: any address that is not RFC1918, CGNAT or IPv6 ULA; a hostname where *any* resolved address
is public; loopback and link-local. With no explicit port it tries 5002 then 3000, and cannot infer a
published port that was moved — name it if so. A Hub running an older pool protocol is reported as
found-but-not-pairable-by-address, because it cannot answer a PIN with its name; pair with it by
MagicDNS name instead.

### `cihub pool pairing-pin`

Mints the six digits that let another Hub pair with **this** one by address, and prints the
`cihub pool pair` line to run on that other machine.

```
cihub pool pairing-pin   # mint: six digits, ten minutes, single use
cihub pool cancel-pin    # revoke the outstanding PIN now
```

**It runs on the Hub that will receive the request** — the opposite side from every other pool
command, and the one thing that is easy to get backwards. Mint here, type there.

The digits are returned **once**, by this command. `cihub pool status` reports only that a PIN is
outstanding and when it expires, so an operator who loses the digits mints a new one — and minting
*replaces* the outstanding PIN rather than adding a second, which invalidates any digits still on
screen elsewhere. A PIN also dies on its fifth wrong guess.

The output includes this node's **key fingerprint**, because minting is the moment both machines are
usually in front of the same person: the far Hub pins that key during the handshake and gets no
second chance to check it. A Hub whose identity failed to bootstrap says so here instead, and pairs
on a bearer token.

Minting a PIN is **not** pre-approval. The inbound request still lands as `pending` and still needs
`cihub pool approve <id>` on this Hub.

Headless appliances need this command: pairing by address is the path that requires no Tailscale
OAuth credential, and a machine with no dashboard has no other way to mint a PIN.

### `cihub pool doctor`

A preflight for the failures that are **silent**: the ones where the node keeps reporting itself healthy
to its own operator while peers quietly stop using it. Every check traces to a failure a real fleet
rollout hit. Read-only — it never pairs, unpairs, writes a setting, restarts anything, or moves a git ref
— and it degrades rather than aborting, so it still produces a full report on a machine with no Docker, no
Tailscale and no Hub. That machine is the one being set up.

| Check | Question | The silent failure it catches |
| ----- | -------- | ----------------------------- |
| **A1** | Does the env file define `API_PORT` and `ROOT_FOLDER_HOST`? | A stub env file. Nothing downstream can recover them, and there is no non-interactive way to write one — so the fix printed is the literal lines to append |
| **A2** | Does the Hub answer `GET /api/health`? | Told apart from "the port is held by something else", which needs a different fix |
| **A3** | Does this **build** have Hub Pool, and which protocol? | Three outcomes, three meanings: `404` predates Hub Pool; `200` with no `poolProtocol` is protocol 1 and will not pair by address with a v2 node; `200` + `poolProtocol` reports the number |
| **A4** | Can the container user write the data dirs? | Docker creates missing bind-mount sources as `root:root`; the Hub then dies `EACCES` on `/data/state/settings.json` with an unhealthy container and no operator-facing reason. Checked by `stat`, so it works with no Docker. A directory that could not be read is reported as unread, never as absent — and the recursive `chown` is withheld for a tree this run never saw |
| **B1** | Does this checkout match the image the container runs? | A node sat on a July checkout while its container ran a build from dev tip, so its `cihub` answered `✗ Unknown command: pool` while its own Hub served the pool routes all day. Decided from the image's `org.opencontainers.image.revision` label where there is one; with no label it says only what two build dates can prove, and otherwise reports that it cannot correlate them — never a version comparison inferred from an ordering |
| **B2** | Can this node even tell that it is behind? | A node that cannot `git fetch` has a **frozen** `origin/dev`, so `git rev-list --count HEAD..origin/dev` answers 0 forever. Measured on a fleet node: auth failed, the count read 0, HEAD was two months old. Asks the remote with `ls-remote` — read-only, and deliberately not a fetch, which would repair the condition being looked at — and reports behind as *unknown*, never as 0. Both sides of the difference are counted, so a checkout carrying local commits is called diverged and is not handed a `pull --ff-only` that git will refuse |
| **B3** | Does the running container match what its compose declares? | A node took a new image under an appliance compose written months earlier and so was missing the host Tailscale socket and CLI that #1279 added: `/identify` returned `nodeFqdn: null`, pairing could never complete, and nothing reported the mismatch. Compared against the file the container was **created from**, found from its own `com.docker.compose.project.config_files` label — an appliance keeps its compose outside the repo — and each missing mount and backend URL var is named |
| **B4** | Does the Hub this CLI drives serve every pool route this CLI calls? | GET pool routes are probed for existence (a `401` proves a route is there; only a `404` says it is not). One direction, because only one is observable: a CLI old enough to lag its Hub answers `✗ Unknown command: pool` and never reaches this check at all, so that skew is B1's to measure, not this one's |
| **C1** | Is the tailnet up, and does this node have a MagicDNS name? | Peer callbacks are `https://<nodeFqdn>` with **no** fallback, so an unnamed node is unreachable however healthy it is |
| **C2** | Is `tailscale serve` publishing this Hub? | `serve` needs an operator grant. Without it the Hub logs one line at boot and behaves normally forever while no peer can reach it. Decided from `tailscale serve status --json`, and it takes a handler at `/` on the `:443` listener proxying to this Hub's port — exactly the path a peer callback takes, so a `/hub` mount, another listener or a raw TCP forward is not accepted as publishing. A node cannot reach its own serve listener, so a self-probe that succeeds is used and one that fails decides nothing; the first HTTPS request after enabling serve blocks ~30s on cert issuance and is retried before it is reported |
| **D1** | Does a **cold** capabilities build fit the 8 s peer probe budget? | Measured at 10.02 s on a real node: every peer probe timed out, the node went `unreachable` fleet-wide, nothing routed to it — and it reported `healthy` throughout. Prints a per-backend breakdown so the slow one is named |
| **D2** | Do the backend URLs resolve, and resolve fast? | An unresolvable compose service name fails **instantly under curl** but blocks ~5 s in `getaddrinfo`, which is what the Hub actually uses. Two of those is the whole D1 budget. Probed with `dns.lookup` from inside the Hub container where one is running — the only vantage that tells a compose-internal name from a broken one. The URLs themselves are read from the container's environment, which is where compose sets them — with no container to read, an empty list is reported as *could not determine*, never as a pass |
| **D3** | Non-streaming first-byte latency vs the 15 s peer connect timeout | A warm 27B model could not return **headers** in 15 s non-streaming while the identical streaming request answered in ~1 s. Measured against a model an engine is actually holding (`loaded`/`pinned`, text modality) — a model on disk would time its cold load, and an embedding model would answer 400 — and asks for a few hundred tokens, because the defect is buffering the whole completion and one token has nothing to buffer. Opt-in behind `--check-latency`; otherwise reported as skipped with the reason |
| **E1** | Can the Hub container reach the host's inference backends? | The existing bridge section, reused unchanged: `ufw` silently blocked container→host Ollama on a node with 8 models and the Hub reported an empty inventory with no error |
| **F1** | Does every paired peer still accept this node as the Hub it paired with? | beta-max's database volume was recreated, which gave it a new pool identity. Every peer answered each poll with a 401 for 28 hours, showed only `unreachable`, and passed every check above. Reads the Hub's own classification from `GET /api/inference/pool/status`: a changed identity fails, a bare 401 warns, and the notes carry the re-pair commands. It never probes or unpairs a peer itself |
| **F2** | Do the nodes this one would route to agree on a context window? | Measured across the fleet on 2026-09-21, `OLLAMA_CONTEXT_LENGTH` ran from 8192 to 65536, and nothing anywhere said so — the only way to see it was to ssh to seventeen boxes and grep their systemd drop-ins. Since a cap became an input to placement, a disagreement decides which nodes a large window may go to. A spread is reported with the nodes it places behind (deliberate on a batch tier, a surprise otherwise); a node advertising **no** cap among capped ones is the harder finding, because "no cap" reads as "takes any window" in both rules, so it collects exactly the windows its own engine may not run. A cap nobody knows is never read as an absent one |

Section **B** is written to one rule: an unprovable claim is not made. Where the evidence supports only
"the repo has commits the image cannot contain", that is what it prints; where it supports nothing, it says
it cannot correlate the two and stops. A node that cannot read its upstream reports how far behind it is as
*unknown* — repeating the frozen number is the bug, not the report.

D1 is measured **cold** by construction: `getOwnInventory`'s 20 s TTL is below the ~30 s peer poll, so
every real probe rebuilds the inventory too, and the routes the doctor times call straight through to the
inference router with no cache in front. Both concurrent fan-outs are timed together, because that is what
`Promise.all([getStatus(), listModels()])` actually costs.

A verdict is one of five, and each has its own glyph: `✓` passed, `!` warned, `✗` failed, `?` could not
be determined, `-` was skipped. Colour is never the difference, because it is stripped the moment the
report is piped, redirected or pasted into a bug — which is how a fleet report travels. **Only decided
failures count as issues** — "I could not look" and "I looked and it is broken" never share an encoding,
or an unequipped machine reports a fleet-wide outage.

A fault inside one section collapses that section alone: the others are still collected and printed, and
the run counts an issue for the section it lost, so a half-collected report can never come out all-clear.
Sections are announced as they land once a run passes three seconds, so a slow node shows progress rather
than a frozen terminal.

No secret is ever printed. The operator key is read from `<ROOT_FOLDER_HOST>/state/settings.json` to reach
the authenticated routes behind the per-backend breakdown; it is never echoed, and neither is a PIN, a peer
token, or any `TAILSCALE_OAUTH_*` value.

### `cihub pool update`

Pull `ghcr.io/companionintelligence/ci-hub:<env>` and redeploy. Unlike `cihub up`/`cihub setup`, this
never passes `--build` — it exists for the fleet node that has no GitHub Packages token and therefore
cannot build the image at all, which used to mean shipping a `docker save | docker load` by hand,
per node, every update.

It touches a git checkout only when doing so is certain to be lossless: a clean tree already on `dev`
gets fast-forwarded (`git fetch` + `git merge --ff-only`); anything else — uncommitted changes, a
different branch, no checkout at all — is left untouched and reported, never reset or stashed on your
behalf. After the pull and redeploy it polls `/api/health` for up to ~20s, then reads `poolProtocol`
off `/api/inference/pool/identify` so you know at a glance whether the redeploy landed and whether this
build has Hub Pool at all.

#### Which image it deploys

The command exports `CI_HUB_IMAGE` into the `docker compose` child's **environment**, and Compose
gives the process environment precedence over `--env-file`. So whatever this command resolves
overrides the pin in the env file Compose was handed, and the resolution order is the whole story:

| Order | Source | Meaning |
|---|---|---|
| 1 | `CI_HUB_IMAGE` in the command's environment | `CI_HUB_IMAGE=<ref> cihub pool update` — a deliberate one-off roll |
| 2 | `CI_HUB_IMAGE` in the env file **Compose actually reads** | the node's standing pin |
| 3 | `ghcr.io/companionintelligence/ci-hub:<env>` | last resort, for a node that pins nothing |

Source 2 is read from the file named by the running container's
`com.docker.compose.project.environment_file` label, not from the file this CLI would otherwise
guess — on the fleet those are `.env.dev` and `.env` respectively. The line printed before the pull
names the reference **and** which of the three sources chose it.

Before this order existed the env file was not consulted at all, so an explicit digest an operator
had written lost to the channel tag — which on an appliance is a **downgrade**, since
`resolveHubContext` forces `prod` whatever env argument was typed and the fleet does not publish to
`:prod`.

#### It records what it deployed

Once `/api/health` answers, the deployed reference is written back to that same env file as
`CI_HUB_IMAGE`. Without this the value lived only in the command's environment: on 2026-09-21
fifteen fleet appliances were rolled onto a new `:dev` digest while their env files went on naming an
older one, leaving every node one reboot away from silently reverting to the build it had been moved
off. `cihub doctor`'s `Image pin` line reports that state wherever it already exists.

The write-back preserves the channel — it records the reference that was deployed, so a `:dev` node
stays on `:dev` and a digest-pinned node stays on its digest. A redeploy that does **not** come up
healthy writes nothing, so the pin keeps naming the build that was serving.

#### The `[env]` argument on an appliance

`cihub pool update dev` on a packaged install runs as `[prod]`: outside a checkout there is one
stack, and `resolveHubContext` infers `prod` for it. The argument is now reported as ignored instead
of quietly disagreeing with the banner. **The env argument does not select a release channel** —
`CI_HUB_IMAGE` in the env file does.

Runs before the device-key gate, like `doctor` — the node most likely to need it has no key yet either.

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

## Fleet

Every other command in this CLI acts on the machine it runs on. `cihub fleet` is the one group that
acts on **other** machines, over SSH — which is the first thing to know about it, and the reason the
read-only subcommands are the default and the rest need `--execute`.

```bash
cihub fleet scan [--all-tailnet] [--lan] [--write-roster] [--json]  # re-probe the roster, or find machines, and what each will allow
cihub fleet list [--json]                              # the saved roster, and what a run would skip
cihub fleet status [--nodes a,b] [--json]              # re-probe every rostered node
cihub fleet preflight [--nodes a,b] [--touches-boot]   # is each node safe to hand a package transaction?
cihub fleet backends [--backends a,b] [--execute]      # what each node can run for inference, then install it
cihub fleet backends [--backends a,b] [--bind tailnet|all|local] [--execute]  # what each node can run for inference, then install it
cihub fleet backends --ollama-parallel 4 --ollama-keep-alive 24h [--ollama-context N] [--ollama-igpu on|off] [--ollama-max-loaded N] [--execute]  # Ollama's runtime env, one file, restart only on change
cihub fleet backends --backends omlx|vllm|lemonade|ollama [--execute]  # install only an engine this machine can run
cihub fleet install [--user <acct>] [--cihub-binary <path>] [--execute]   # stand a Hub up on each node and register it
cihub fleet update [--hub] [--ollama] [--gpu-probe] [--models a,b] [--execute]  # refresh the Hub image, pin Ollama, install the GPU probe timer, pull models
cihub fleet update [--hub] [--models a,b|recommended] [--execute]  # refresh the Hub image, pull models (per node's own Hub with `recommended`)
cihub fleet update [--hub] [--models a,b] [--execute]  # refresh the Hub image, pull models
cihub fleet update --hub [--pin-digest <repo@sha256:…> | --to-majority] --execute   # pin the Hub build
cihub fleet apps [--apps a,b] [--endpoint pool|local]  # can each node serve an agent its credentials
cihub fleet rdp [--nodes a,b] [--execute]              # remote desktop on each Linux node, tailnet-only
```

**`scan`, `list` and `status` change nothing, anywhere; `apps` reads and installs nothing.**
`backends`, `install`, `update` and `rdp` require `--execute`; without it they print the plan they
would run, touch nothing, and exit `0`. A tool that can reach fourteen machines should make the destructive
cihub fleet cert [--nodes a,b] [--execute]             # the tailscale TLS cert each node needs to pool
cihub fleet devices list | release <d> | re-register <d>  # what Portal knows about the org's devices; fix it without a browser
```

**`scan`, `list` and `status` change nothing, anywhere; `apps` reads and installs nothing.**
`backends`, `install`, `update` and `cert` require `--execute`; without it they print the plan they
would run, touch nothing, and exit `0`. A tool that can reach fourteen machines should make the destructive
cihub fleet boot-params [--i-have-console] [--execute] # gfx1151 GTT kernel params: live vs staged, and the GRUB edit
```

**`scan`, `list` and `status` change nothing, anywhere; `apps` reads and installs nothing.**
`backends`, `install`, `update` and `boot-params` require `--execute`; without it they print the plan
they would run, touch nothing, and exit `0`. A tool that can reach fourteen machines should make the destructive
**`scan`, `list`, `status` and `preflight` change nothing, anywhere; `apps` reads and installs nothing.**
`backends`, `install` and `update` require `--execute`; without it they print the plan they would
run, touch nothing, and exit `0`. A tool that can reach fourteen machines should make the destructive
path the one you have to ask for.

**Authentication is the tailnet, not a key you manage.** There is no `-i`, no agent forwarding and
no password path. Every remote call runs `BatchMode=yes`, so a node that would prompt fails fast
instead of hanging a fourteen-machine sweep on a TTY nobody is watching, and access stays an ACL
decision you can read and audit.

These commands take no `[env]` argument — they act on remote machines, not on one of this machine's
environments. `cihub fleet scan prod` is an argument error, not a retarget.

### `--user`, and why you usually need it

The tailnet grants SSH to *specific accounts*, and rarely the one you are logged in as locally: this
fleet grants `root` where the QA harness assumes `ci`. There is deliberately no baked-in default —
guessing would be wrong half the time and silently. Pass `--user <account>`, or set `FLEET_SSH_USER`;
a roster entry may also carry its own `user`, which wins for that node.

`scan` tells the two SSH refusals apart, because they need opposite responses:

- **`acl-wrong-user`** — the node is administrable and you named the wrong account. Re-run with
  `--user`. The scan says so by name and prints the flag.
- **`acl-denied`** — the ACL grants you no SSH here at all, and no flag fixes it. That node can serve
  inference perfectly while being unadministrable, which is exactly the state two machines on this
  fleet sat in unnoticed for an unknown period.

That is also why the scan reports **SSH**, **HUB** and **ENGINES** as three separate columns. They
are independent questions, and every fleet tool that collapsed them into one "online" column has
been wrong in the same direction.

### The roster

`<data-dir>/fleet.json` — on Linux `~/.local/share/companion-hub/fleet.json`, on macOS
`~/Library/Application Support/companion-hub/`, on Windows `%APPDATA%\companion-hub\`, or wherever
`CI_HUB_DATA_DIR` points. It sits beside the Hub's other state rather than in a checkout, because
`cihub` is installed on appliances that have no repo.

**Only `cihub fleet scan --write-roster` writes it**, and every other subcommand reads it and acts on
nothing else. A machine that has never been scanned into the roster is invisible to `status`,
`backends`, `install`, `update` and `apps`.

**No roster is a refusal, not a fallback.** Every subcommand that dials a machine — everything but
`scan` and `list` — stops on a missing or unreadable `fleet.json`, names the path, names
`cihub fleet scan --write-roster`, and exits 1, so a script wrapped around `preflight` cannot read
"nothing to check" as a pass. It never substitutes the tailnet's peer list for the file. That
substitution is how a 57-row roster came to hold `Aine`, `Beam Pro` and `Bennett's MacBook Pro`,
with no `skip` on any of them: the tailnet is shared, its peers are colleagues' laptops, phones and
headsets alongside the appliances, and once a scan had seeded the file with everyone, every later
command inherited them. A roster that exists and lists nobody is a different finding — a state the
operator arrived at — and is reported without an error exit.

Two properties of the file are load-bearing:

- **`ip` is the identity; `name` is only a label.** Every merge and lookup keys on the address,
  because the rosters this replaces gave one machine five different names across two files and had a
  row whose name and address disagreed outright. `--nodes` matches either, since an operator types
  whichever they remember.
- **A node can be excluded, and say why.** `"skip"` takes `llm-only` (serves inference, grants no
  SSH), `unreachable` (known down, awaiting hands-on recovery) or `excluded` (deliberately out of
  scope). Skipped nodes are printed with the reason instead of being re-attempted at a timeout each
  and landing in the report looking like a machine that broke this morning. A re-scan never clears a
  `skip`, a `note` or a name you chose — discovery fills fields that are absent and corrects
  `tailnetName`, which is a fact about the network rather than a preference.

A malformed row costs that row and names it, not the whole file: running against nineteen nodes
while believing it was twenty is the worse failure. A `"skip"` outside those three values is the
exception — every fleet subcommand, `list` and `scan` included, refuses the whole roster on it,
names each row and the value it holds, and exits 1. Unknown values used to read as "attempt it":
on 2026-09-26 22 of 23 rows marked `"skip": "excluded-tmp"` to narrow an install to one node were
all installed on. To act on some nodes only, pass `--nodes`.

### Flags

| Flag | Effect |
| ---- | ------ |
| `--execute` | `backends`/`install`/`update`/`boot-params` only: actually apply. Without it, the plan is printed and nothing changes |
| `--nodes a,b` | Restrict the run to these roster entries, by name **or** address |
| `--user <account>` | Remote account to SSH as. `FLEET_SSH_USER` sets the same thing; a roster entry's own `user` wins |
| `--json` | Machine-readable report — `scan`, `list`, `status`, `backends`, `install`, `apps`, and `update --models` (per node: provenance and each model's outcome) |
| `--all-tailnet` | `scan` only: enumerate every tailnet peer as a candidate. Off by default, because the tailnet is shared and a probe is an SSH attempt in each peer's auth log. With `--write-roster`, everything it finds becomes a target — see [`cihub fleet scan`](#cihub-fleet-scan) |
| `--lan` | `scan` only: also sweep the local subnet. Off by default, because touching every address on the operator's subnet is a more intrusive act than listing a tailnet they already belong to |
| `--write-roster` | `scan` only: save the result to `fleet.json` |
| `--timeout <ms>` | Per-probe budget, 250–120000 (default 4000). The Hub's backend-summary route (`/api/inference/health`) gets a 10 s floor on top of this, because it health-checks each backend with a 5 s timeout of its own and a busy engine puts it past 4 s on a healthy Hub; see the **HUB** column under [`cihub fleet scan`](#cihub-fleet-scan) |
| `--concurrency <n>` | Parallel **probes**, 1–32 (default 4). The runners stay serialised regardless |
| `--force` | `install`/`update` only: proceed on a node whose preflight said `block`. The finding is still printed, marked as overridden |
| `--touches-boot` | `preflight`/`install`/`update`: rate the boot-recovery and grub-customizer findings as `block` rather than `warn`, as they are before anything that touches the kernel, initramfs or GRUB |
| `--backends a,b` | `backends` only: from `ollama`, `omlx`, `vllm`, `lemonade`. Omit to plan every engine this machine can run |
| `--bind tailnet\|all\|local` | `backends` only: where Ollama listens (default `all` — `0.0.0.0` behind `ollama-tailnet-guard.service`, which admits the tailnet, loopback and the Docker bridges the Hub container arrives on; `tailnet` is the node's Tailscale IPv4 from `tailscale ip -4`). Written to one drop-in and read back after the restart — see [Ollama's bind](#ollamas-bind-one-file-read-back) |
| `--data-dir <path>` | Where the Hub keeps runner venvs and model dirs on the **remote** machine (default `/var/lib/companion-hub`) |
| `--code <code>` | `install` only: one Portal pairing code, which enrolls exactly one node |
| `--claim-email <addr>` | `install` only: create each Hub's first operator for this CI Account address (`CIHUB_CLAIM_EMAIL`). Omitted, the claim step is **skipped and reported as skipped** — never guessed |
| `--join-pool <node>` | `install` only: pair each installed node into that Hub's pool |
| `--pool-pin <digits>` | `install` only: the PIN minted on the Hub being joined, for pairing by address |
| `--hub` | `update` only: update the Hub image |
| `--models a,b` | `update` only: pull these models on each node. `--models recommended` asks each node's own Hub for its hardware-fitted list instead. Either way `nomic-embed-text` is appended — see [`fleet-setup.md`](fleet-setup.md#models-per-node-not-per-fleet) |
| `--hub` | `update` only: update the Hub image, reading the image ID on each node before and after |
| `--pin-digest <repo@sha256:…>` | `update --hub` only: deploy this exact build instead of whatever the floating tag resolves to. A bare `sha256:…` is completed against `ghcr.io/companionintelligence/ci-hub`; a tag is refused, since a tag is the mutable thing being escaped |
| `--to-majority` | `update --hub` only: pin every targeted node to the build most of the **whole roster** runs. Refused unless that is a strict majority — more than half of all rostered nodes, unknown ones included — and refused on a tie |
| `--models a,b` | `update` only: pull these models on each node |
| `--ollama` | `update` only: bring each node's Ollama to the pinned release via `ollama.com/install.sh`, confirmed at `/api/version` on the node's own bind. Nodes already there are left alone; a node with no Ollama is reported, not installed |
| `--ollama-version <x.y.z>` | `backends`, `update --ollama`, `status`: use this exact release instead of the pin (`OLLAMA_PINNED_VERSION` in `fleet-ollama-version.ts`). `latest` is refused |
| `--apps a,b` | `apps` only: from `hermes-agent`, `openclaw`. Omit for both |
| `--endpoint pool\|local` | `apps` only: which endpoint the report is labelled for (default `pool`). The check itself is the same either way — see below |
| `--i-have-console` | `boot-params` only: lift the refusal on a node with a hidden zero-timeout GRUB menu and no `console` in its roster entry. You are asserting you can reach that machine's console if the next boot fails |

The Postgres password `install` needs is read from **`CIHUB_POSTGRES_PASSWORD`** and has no flag, so
it never lands in a shell history or a process listing.

### `cihub fleet scan`

Probes each candidate on the three axes above and prints a verdict per node. **By default the
candidates are the roster** — a scan re-verifies what you already run. `--all-tailnet` adds every
tailnet peer and `--lan` every address on the local subnet that answers on an engine or Hub port.
It writes nothing unless `--write-roster` is passed, and says so at the end rather than leaving you
to wonder. With no Tailscale CLI it says that too, and enumerates nothing — set `TAILSCALE_CLI` if
yours is somewhere unusual.

The **HUB** column is a probe outcome, not a yes/no, because a probe that ran out of time once looked
identical to a port with nothing on it. On 2026-09-20 four Hubs under inference load read `—` under
HUB and PORTAL while each was serving, registered, and answering `/api/registration/phase` within a
second; it was `/api/inference/health` — which health-checks every backend the Hub fronts, each with
its own 5 s timeout — that had outrun the 4 s budget. The cell now says which:

| HUB | Meaning |
|---|---|
| `tier high, 6 backends` (`status`) / `yes` (`scan`) | Both routes answered |
| `yes, slow` | A Hub is there — the phase route answered, so PORTAL is filled in — but its backend summary did not arrive in time. Usually inference load |
| `timeout` | Nothing answered on the Hub port within `--timeout`, and nothing refused the connection either. A Hub may be listening; the probe cannot say, and the verdict does not nominate the node for an install |
| `error` | The port answered, but not as a Hub: a non-2xx status or a body that is not JSON |
| `—` | The connection was refused (or the host unreachable). Nothing is listening. The only outcome that means "no Hub" |

The summary route gets a floor of 10 s regardless of `--timeout`, the way SSH gets 8 s; the phase
route keeps the flag's budget. `--json` carries the outcome as `probe.hubProbe`
(`ok` · `slow` · `timeout` · `refused` · `error`). A footer names every `timeout` and `yes, slow`
node and the flag that separates a busy Hub from an absent one.

**`--all-tailnet` is how a machine gets into the roster, and it is asked for by name** because the
tailnet is shared: its peers are colleagues' laptops, phones and headsets alongside the appliances,
and no ACL tag tells them apart (`tag:ci-server` is an internal test tag, not an inventory). The
scan lists every peer the roster does not know, and with `--write-roster` says it is adding them
*as targets* — that list is the one to prune afterwards, with `"skip": "excluded"` on each row that
is not a fleet machine. A fleet command never dials an excluded row, and a default scan does not
re-probe one either (`unreachable` may have recovered and `llm-only` is a verdict the scan can
confirm, so those two still get a probe); it is counted in the footer and left alone until
`--all-tailnet`.

### `cihub fleet list` and `cihub fleet status`

`list` prints the roster as saved, plus the nodes a run would skip and why. `status` re-probes them:
administrable, running a Hub, serving engines, and which Ollama each is serving — read at the bind
the node resolves for itself, marked when behind the pin, with a one-line fleet summary
(`0.34.0 on 17/18; behind: localhost-0 (0.30.9)`). A node that cannot be read shows `—` and the
reason. Neither touches a node beyond the probe.

The **HUB** column reads `tier high, 6 backends` when both Hub routes answered, `yes, slow` when the
Hub is there but its backend summary outran the budget (PORTAL is still filled in), `timeout` when
nothing answered and nothing refused, and `—` only when the port refused the connection — the
outcomes are listed under [`cihub fleet scan`](#cihub-fleet-scan). Before 2026-09-20 a Hub busy
with inference and a node with no Hub printed the same `—`.
administrable, running a Hub, serving engines — and which **Hub image** each is actually running,
as a short image ID, with a footer naming the fleet's majority and every node off it:

```
hub image d5ff45d9 on 12/18; drifted: core-3 (9a38714f), core-6 (9a38714f); unknown: core-17 (unreachable)
```

The column exists because every node runs the same floating tag, so `docker ps` cannot show drift
and the image ID can. A node SSH could not reach, one without Docker, and one with no `ci-hub`
container are each `unknown` with that reason — never counted on either side of the line. Neither
command touches a node beyond the probe. See
[`fleet-setup.md` → Which build the fleet is running](fleet-setup.md#which-build-the-fleet-is-running).
administrable, running a Hub, serving engines, and — for every node it can SSH to — whether the
tailscale TLS certificate pooling depends on is in the node's store. Neither touches a node beyond
the probe.

The **TLS CERT** column never goes blank. `ok, 62d left` is a certificate seen with privilege;
`absent` is a store listed with privilege that lacks the file; everything else is `—` followed by
what stopped the measurement: `unreadable without sudo`, `HTTPS not enabled on tailnet`, `no
tailscale`, `ssh failed (acl-denied)`. The distinction is not cosmetic. tailscaled's store at
`/var/lib/tailscale/certs` is `drwx------ root`, so an unprivileged `ls` prints nothing, and the
first probe of this fleet reported zero certificates on eighteen nodes that had fourteen. Pass
`--user root` (or an account with passwordless sudo) to measure it.
administrable, running a Hub, serving engines, and — for every node it can SSH to — where Ollama
binds and **which drop-in decided it** (`100.64.0.9:11434 ← zzzzz-cihub-bind.conf`), with a
`CONFLICT` flag when more than one file sets `OLLAMA_HOST` and the winner is not the canonical one.
Neither touches a node beyond the probe.

The **RESIDENT** column is what each Ollama has loaded right now, from `/api/ps`, and **where**: a
model whose `size_vram` is less than half its size on a node that has a GPU is marked
`qwen3-coder:30b ⚠ CPU`, and a footer names the reason and the fix. It exists because on
2026-09-21 six Strix Halo nodes served qwen3-coder:30b from the CPU — 37.5 tok/s against 75–79 on
the GPU — with every other column green: version at pin, bind managed, engine answering. `size_vram:
0` was the only tell, and nothing printed it. `—` is a daemon with nothing loaded; `?` is a node
whose `/api/ps` could not be read (the reason is in `--json` under `residency.reason`). A CPU-only
box running a model on its CPU is not marked. The reading and the GPU evidence come from the node
itself over SSH; a node without SSH is read from here on `:11434`, which lists its models but,
knowing nothing about its GPU or environment, never flags one. See
[Vulkan and the iGPU key](#strix-halo-vulkan-and-the-igpu-key-in-the-bind-file) for the case the
marker was built around.

### `cihub fleet preflight`

Per node, in one SSH round trip: `sudo -n true`, `dpkg --audit`, `apt-get check`, a listing of
`/etc/grub.d`, `/etc/default/grub`, `/sys/class/ipmi`, and the package lock table. Reads only — there
is no `--execute` because there is nothing to execute. `install` and `update` run the same five checks
on each node before touching it; this is the standalone view, for looking before a pass rather than
being refused partway through one. Exits `1` if any node would be refused, so `cihub fleet preflight
&& cihub fleet install --execute` is a gate.

| Check | Reads | Finding |
|---|---|---|
| `sudo` | `sudo -n true` | **block** when the account cannot become root without a prompt — `ssh -n` has no TTY, so the install would fail six steps in. **info**, never block, on CI OS, whose account is unprivileged by design |
| `dpkg` | `dpkg --audit`, `apt-get check` | **block** on any half-configured package or unmet dependency: every package operation on the node fails until it is cleared. A lock or permission failure from `apt-get check` is not counted here |
| `grub-customizer` | `ls /etc/grub.d` | `*_proxy` scripts or `.script_sources.txt`. **warn**; **block** with `--touches-boot`. Once a kernel they name is removed they emit an invalid `grub.cfg`, `update-grub` refuses it, and every kernel postinst fails — the wedge one node sat in for weeks under a wrong diagnosis |
| `boot-recovery` | `/etc/default/grub`, `/sys/class/ipmi`, roster `oob` | `GRUB_TIMEOUT_STYLE=hidden` + `GRUB_TIMEOUT=0` with no IPMI on the host and no `oob` console in the roster: a boot that fails needs a trip. **warn**; **block** with `--touches-boot` |
| `apt-lock` | `lslocks`, `ps` | **block** while something holds `/var/lib/dpkg/lock*`; **warn** for a lists/archive lock. `unattended-upgrade-shutdown --wait-for-signal` is the idle boot-time hook, holds no lock, and is reported as such rather than flagged — it was read as a 24-hour stuck upgrade once |

A check the probe never reached — the SSH budget ran out mid-script — is reported as **not
measured** and rated `warn`, never as a pass.

The roster's `"oob"` field is where an out-of-band console goes (`"ipmi 10.0.0.9"`, `"nanokvm
192.168.0.115"`); its presence is what the boot-recovery check reads. The host cannot see a KVM
plugged into it, so this is the only way to tell the tool.

### `cihub fleet backends`

Reads each node's hardware — OS, arch, GPUs and whether their drivers are alive, load — and decides
per backend whether it would **install** it, **adopt** one already answering, or **skip** a machine
that cannot run it, with the reason. The dry run is most of the value even when nothing is installed.

Serialised across nodes on purpose: a backend install pulls gigabytes of CUDA wheels and GPU images,
and running several at once saturates the link they share and blocks the nodes' own HTTP listeners
long enough to look absent to everything else.

#### Ollama's bind: one file, read back

Where Ollama listens was, measured across this fleet, three different things — the Tailscale
address, `0.0.0.0`, loopback — decided by whichever drop-in under
`/etc/systemd/system/ollama.service.d/` happened to sort last. systemd applies drop-ins in **byte
order of filename** and the last `Environment=` assignment wins, so `zzzz-bind-all.conf` outranks
`zzz-tailnet-bind.conf` by one letter, and `override.conf` outranks `10-tailnet-bind.conf` because
`o` sorts after `1`. `backends` therefore writes exactly one file for the bind,
**`zzzzz-cihub-bind.conf`**, whose name sorts after every legacy name seen on the fleet, and it moves
each `*.conf` that set `OLLAMA_HOST` and nothing else to `<name>.disabled-by-cihub-<date>` — renamed,
never deleted, and no longer read because it no longer ends in `.conf`. A file that also sets
something else (an `OLLAMA_MODELS` repoint, say) is left exactly where it is and outranked. After the
restart the step re-reads `systemctl show ollama -p Environment` and **fails if the merged value is
not the one requested**; the dry run lists every file it would move, by name, and names the guard it
would install (`all`) or remove (`tailnet`, `local`) before the restart.

Two refusals, both facts about the machine rather than failures: a node whose `:11434` belongs to a
**user-scope** unit (beta-1 runs `ollama-local.service` under the `ci` user's `systemd --user`, with
the system unit disabled) is skipped with the reason, because `systemctl enable --now ollama` there
starts a second daemon that collides on the port — and ollama.com's own installer runs that command,
so the check happens *before* anything is downloaded. And `--bind tailnet` on a node with no tailnet
address fails rather than silently binding somewhere else.

That skip is decided by **who holds the listening socket**, not by a unit's name. The probe reads
the cgroup `ss -e` reports for the socket on `:11434` (printed to any user, pid or no pid) and
classifies it: the system `ollama.service`, a user unit, a container, some other system unit. A
user-scope unit whose name matches `ollama*` stops being the reason to skip in exactly one case:
the **system** `ollama.service` is the thing serving the port. core-2 is the case that taught this
(2026-09-21): it runs `ollama-tunnel.service` under `ci`'s `systemd --user` — an `ssh -L` to beta-1,
listening on `:11435` — while the system `ollama.service` serves `:11434`; a guard that went by the
name printed *"ollama-tunnel.service is running under ci's systemd --user; the system ollama.service
path would start a second daemon"* and managed nothing on the node. Now the system unit there is
managed, and the line says why the unit you can see in `systemctl --user` did not stop the run:

```
bind: ollama-tunnel.service is active under ci's systemd --user, but the system ollama.service (uid 997) is what serves :11434 — that unit is not the daemon; managing the system unit
```

Everywhere else the name refuses as it always did, on purpose. **Nothing listening** on `:11434`
beside an active `ollama*` user unit is still a skip: that is exactly what beta-1 looks like for
the second between `systemctl --user restart ollama-local` stopping the daemon and the new one
binding, and the probe's `systemctl --user list-units` rows carry no `OLLAMA_HOST` that could tell a
tunnel from a daemon that has not bound yet — so a free port is not treated as proof. Something
listening whose owner the probe **cannot see** (no pid, no cgroup — an `ss` before iproute2 5.10)
is a skip too, unless the socket's uid belongs to no login user at all; a login user's socket may
be the unit's, or anyone's hand-started `ollama serve`. A socket whose cgroup `ss` prints as a bare
`/` or as `unreachable:` names nothing and is read from `/proc/<pid>/cgroup` instead when a pid is
disclosed. On `--execute` the same guard runs as root at the top of the install and adopt shells,
and refuses or notes on the same evidence.

An Ollama that is already answering is **adopted**, and the same bind policy is applied to it — the
nodes that already run one are exactly where the arrangements diverge. A node that already reads back
as `zzzzz-cihub-bind.conf` with the requested bind — and, for `all`, with `ollama-tailnet-guard.service`
active — is not touched; a `0.0.0.0` whose guard is down is work, not a no-op. `fleet status` shows every node's
effective bind and the file that set it, and flags a conflict (several setters, none of them the
canonical file) without changing anything.

> A Hub container on the same node reaches its host Ollama at `host.docker.internal:11434`, which is
> the Docker bridge gateway — an address a tailnet-only bind does **not** listen on. That is why the
> default is `--bind all` behind `ollama-tailnet-guard.service`: the daemon listens everywhere, and
> the guard admits `lo`, `tailscale0`, `docker0` and `br-+` and resets the rest. `fleet status`
> marks a `0.0.0.0` bind whose guard is not active as **EXPOSED**. Use `--bind tailnet` only on a
> node that runs no Hub container.

#### Strix Halo: Vulkan and the iGPU key, in the bind file

On gfx1151 (Strix Halo) the bind file carries two more lines beside `OLLAMA_HOST`, both derived
from the hardware and both **required**:

```
Environment="OLLAMA_LLM_LIBRARY=vulkan"
Environment="OLLAMA_IGPU_ENABLE=1"
```

`OLLAMA_LLM_LIBRARY=vulkan` because ROCm on gfx1151 runs NO_VMM and cannot back a large contiguous
allocation with GTT: the driver advertises the whole ~60 GB pool as free and then fails to allocate
21 GB, so every model above the ~2 GB VRAM carve-out fails to load. Six nodes returned HTTP 500 on
every real model until it was forced. `OLLAMA_IGPU_ENABLE=1` because Vulkan alone is not enough:
Ollama 0.34's runner **drops an integrated GPU** unless that key is set (`dropping integrated GPU;
to enable, set OLLAMA_IGPU_ENABLE=1` in the journal), and then loads the model on the CPU and
serves it at HTTP 200. Measured 2026-09-21 on ci, core-4, core-6, core-14, core-17 and fzzy:
qwen3-coder:30b at `size_vram 0`, 37.5 tok/s decode and 109 tok/s prefill; with the key, 75–79 tok/s
and ~530 tok/s prefill on the same nodes.

The iGPU key used to live only in the runtime file, written when `--ollama-igpu on` was passed —
and that file is rendered whole from the flags on every run, so a later run with `--ollama-parallel`
alone rendered it away. That is how the six nodes lost it. A key the hardware requires now lives
with the other key the hardware requires, in the file that is rendered from the hardware; no runtime
flag can remove it. A gfx1151 node whose bind file predates this is not a no-op: the plan says
`write zzzzz-cihub-bind.conf with OLLAMA_HOST=0.0.0.0:11434 OLLAMA_LLM_LIBRARY=vulkan OLLAMA_IGPU_ENABLE=1`
and `--execute` restarts the daemon once to make it so.

**Precedence.** systemd applies drop-ins in byte order of filename, last assignment winning, and
`zzzzz-cihub-bind.conf` sorts before `zzzzz-cihub-runtime.conf` (`b` < `r`). So the bind file's
`OLLAMA_IGPU_ENABLE=1` is the hardware default, and `--ollama-igpu on|off` in the runtime file is
the operator override that wins when given — `off` writes `0`, which outranks the `1`. `--ollama-igpu
unset` (or no flag) leaves the key out of the runtime file and the bind file's default in force. A
test pins that ordering; if either file is ever renamed, it is the test that says the override
stopped working. The two files assign no other key in common.

**The check.** Every `fleet backends` run — dry or `--execute`, flags or no flags — reads `/api/ps`
on each Ollama it can reach and prints one `resident:` line under the plan: `resident: none`,
`resident: qwen3-coder:30b (18.6 GiB, GPU)`, or, on a node with a GPU, a warning:

```
! qwen3-coder:30b resident on CPU — size_vram 0 of 18.6 GiB: OLLAMA_LLM_LIBRARY=vulkan with OLLAMA_IGPU_ENABLE unset — Ollama drops an integrated GPU unless OLLAMA_IGPU_ENABLE=1, so the model loaded on the CPU; run 'cihub fleet backends --backends ollama --execute' — the managed bind file now carries OLLAMA_IGPU_ENABLE=1 beside OLLAMA_LLM_LIBRARY=vulkan on gfx1151
```

The reason is named only when every part of it is in evidence — Vulkan forced, the key not `1`,
an integrated AMD part — from the merged environment the daemon resolved, never from a file. Any
other model with less than half its bytes in VRAM on a GPU node is flagged as measured but not
explained, pointing at `journalctl -u ollama`. On `--execute` the read happens after the daemon is
up; a run that restarted it reads `none`, since a restart unloads everything. `--json` carries the
reading under `residency`, findings under `residency.cpuResident` with `cause` set to
`vulkan-without-igpu` or `unknown`. `fleet status` shows the same reading as its RESIDENT column.

#### Ollama's runtime environment: a second file, restarted only on change

Measured on 2026-09-20: no node on the fleet set `OLLAMA_NUM_PARALLEL`, so every Ollama served one
sequence at a time and the pool's ceiling was the sum of fifteen single streams. Five flags manage
the settings that change that, and they write **one separate drop-in**,
`/etc/systemd/system/ollama.service.d/zzzzz-cihub-runtime.conf` — never the bind file, and never a
file that mentions `OLLAMA_HOST`, so the bind step's "move aside anything that sets the bind" rule
can never touch it:

| flag | key | value |
|---|---|---|
| `--ollama-parallel N` | `OLLAMA_NUM_PARALLEL` | 1–64 |
| `--ollama-keep-alive D` | `OLLAMA_KEEP_ALIVE` | a duration: `24h`, `30m`, `1h30m`, `-1` (forever) |
| `--ollama-context N` | `OLLAMA_CONTEXT_LENGTH` | 512–1048576 |
| `--ollama-igpu on\|off` | `OLLAMA_IGPU_ENABLE` | `1` or `0` — the operator override; on gfx1151 the bind file already sets `1`, see [above](#strix-halo-vulkan-and-the-igpu-key-in-the-bind-file) |
| `--ollama-max-loaded N` | `OLLAMA_MAX_LOADED_MODELS` | 1–16 (`0` is refused: Ollama reads it as 3 × GPUs, not a cap — use `unset`) |

Every flag also accepts **`unset`**, which leaves that key out of the file. The file is rendered
whole from the five values on every run: a key you did not pass is not in it, and falls back to
Ollama's default or to whatever another drop-in sets — so a run is reproducible from its command
line, and `--ollama-parallel unset` is how you revert. With none of the five flags the runtime file
is not touched at all.

**Every run reports what each node's daemon runs now, flags or no flags.** The bind probe already
reads the merged environment, so `cihub fleet backends --backends ollama` — no runtime flag, nothing
written — prints one `runtime: now …` line per node with all five keys, `<unset>` included and in a
fixed order, so two nodes' lines line up:

```
core-3   runtime: now OLLAMA_NUM_PARALLEL=<unset> OLLAMA_KEEP_ALIVE=<unset> OLLAMA_CONTEXT_LENGTH=8192 OLLAMA_IGPU_ENABLE=<unset> OLLAMA_MAX_LOADED_MODELS=<unset>
core-14  runtime: now OLLAMA_NUM_PARALLEL=2 OLLAMA_KEEP_ALIVE=24h OLLAMA_CONTEXT_LENGTH=32768 OLLAMA_IGPU_ENABLE=<unset> OLLAMA_MAX_LOADED_MODELS=2
```

That is the fleet-wide inventory of `OLLAMA_CONTEXT_LENGTH`, and `--json` carries the same values
under each node's `bind.runtime.now`. It exists because there was no such inventory: on 2026-09-21
the fleet's contexts ran from 8192 to 65536, and reading them meant an ssh and a `grep` on each of
seventeen boxes. A node this run may not touch — a user-scope unit, a container — still reports its
environment, since it still serves inference.

**It reports the value the daemon resolved, not the one in a file — read it this way and nothing
else.** The line comes from `systemctl show ollama -p Environment`, which is the merged environment
after every drop-in. `grep`ping `/etc/systemd/system/ollama.service.d/*.conf` does NOT answer this
question: a node may carry several drop-ins assigning the same key, systemd merges them in lexical
filename order, and the LAST assignment wins. core-14 carries both a `10-ci-tuning.conf` setting
8192 and `zzzzz-cihub-runtime.conf` setting 32768 — a grep that takes the first match reports 8192
for a node that has been running 32768 all along. That failure mode is invisible unless you already
know to look for a second file, and it misreported seven of sixteen nodes the one time it was tried.
The `zzzzz` prefix exists precisely so cihub's file sorts last and wins; a drop-in that would sort
after it is the only real conflict, and `--ollama-context` reports that one as `CANNOT WIN`.

`--ollama-max-loaded` is the other half of `--ollama-keep-alive`. A 24h keep-alive with no cap on
resident models is a slow leak: on 2026-09-21 three 27–30B models had piled up on batch-tier Strix
Halo nodes next to the other engines that node was running — core-7 at 122/123 GB with swap full, core-17's
kernel OOM-killing a model server and dbus. `OLLAMA_MAX_LOADED_MODELS=2`, set by hand, freed
122 → 56 GB (core-7), 109 → 72 (core-17), 95 → 49 (core-14) and 102 → 56 (fzzy). Pass it on every
run that manages it: a run with `--ollama-parallel` alone renders the file without the key, and
Ollama's default (3 × GPU count) is back in force after the restart.

On `--execute` the step writes the file only if its bytes differ from what is on disk, and only then
runs `daemon-reload` and `restart` — a restart unloads every resident model, and a fleet command
will be re-run. Whatever it did, it re-reads `systemctl show ollama -p Environment` and prints the
previous and new effective value of every managed key (`runtime OLLAMA_NUM_PARALLEL <unset> → 4`);
a managed key that reads back with a different value fails the node, naming the later drop-in that
must be overriding it. "Nothing to do" is judged on what the daemon runs, not on the file alone: a
file whose bytes already match while `systemctl show` resolves a managed key to something else is
still applied — if systemd reports it never loaded the file (a previous run cut off before
`daemon-reload`), it is reloaded and Ollama restarted; otherwise the read-back fails the node as
above. The dry run prints the same plan — what is in effect now, whether the file would change, or
what the daemon resolves instead — and runs nothing. A node whose `:11434` belongs to a user-scope unit (beta-1's
`ollama-local.service`) is skipped with the reason: a drop-in under `ollama.service.d/` configures
nothing there, and that unit carries its own environment. A user-scope unit that merely *looks* like
one (core-2's `ollama-tunnel.service`, an ssh forward beside a **serving** system unit) is not a
skip — [the listener decides](#ollamas-bind-one-file-read-back); the same unit with nobody on the
port is, because a free port is also what the real daemon looks like mid-restart.

```bash
cihub fleet backends --backends ollama                                                        # inventory only: every node's runtime env, nothing written
cihub fleet backends --backends ollama --ollama-parallel 4 --ollama-keep-alive 24h            # plan
cihub fleet backends --backends ollama --ollama-parallel 4 --ollama-keep-alive 24h --execute  # apply, restart where changed
cihub fleet backends --backends ollama --ollama-parallel 4 --ollama-keep-alive 24h --execute  # again: unchanged, no restart
cihub fleet backends --backends ollama --ollama-parallel 2 --ollama-keep-alive 24h --ollama-context 32768 --ollama-max-loaded 2 --execute  # the batch tier: 2 slots × 32k, at most 2 resident
```

**`--ollama-context` also sets each node's Hub context cap.** The Hub does not read this file, and
Ollama's API does not expose `OLLAMA_CONTEXT_LENGTH`, so on every node where the runtime step applied
or was already in effect, the same run tells that node's Hub the same number —
`inferenceMaxNumCtx`, written over the node's own loopback API with the node's own device key (read
inside the `ci-hub` container, or from `--data-dir`'s `state/settings.json`; never printed, never
carried back). The Hub then hands its apps `min(model window, memory-sized recommendation, N)`
instead of a window that reloads the model — on core-2 an uncapped 65536 handout against four 16384
slots took `qwen3-coder:30b` from 25 GB to 44 GB, and every request at another size reloaded it
again. See
[Context caps](./hub-pool.md#context-caps-the-window-an-app-asks-for-is-the-window-the-engine-runs).

The step runs after the drop-in, so the daemon runs the context before the Hub is told about it, and
prints its own `hub` line per node: `applied — context cap none → 16384 (PATCH /api/user-settings
200)`, `unchanged — context cap already 16384`, or `failed` with the HTTP code (a non-2xx fails the
node, like a drop-in that read back wrong). A cap is reported applied only after
`GET /api/inference/preferences` reads it back — an older Hub's settings schema strips a key it does
not know and answers 200 having stored nothing, and a Hub whose preferences carry no `maxNumCtx` at
all is failed as predating the cap, with `cihub fleet update --hub` as the fix. The dry run prints
`hub: would set inferenceMaxNumCtx=16384 …` under the runtime plan and dials no Hub.

`--ollama-context unset` clears the cap as well, through `PATCH /api/inference/preferences
{"backend": <current>, "maxNumCtx": null}` — `/api/user-settings` cannot remove a key — and skips the
write on a Hub that has none, because that route restarts every AI app on any write. The cap is
touched **only when `--ollama-context` is passed**: a run with just `--ollama-keep-alive` renders the
file without `OLLAMA_CONTEXT_LENGTH` but leaves the Hub's cap alone, so pass the flag on every run
that manages it, the way the file's own reproducibility already asks. A node the runtime step
skipped (user-scope unit) or failed keeps whatever cap it had; its line already says why.

**`--ollama-parallel` also sets each node's Hub slot count**, on exactly the same terms: the same
run tells the node's Hub `inferenceOllamaSlots=N` after the drop-in applies, so the pool knows how
many requests the daemon runs at once and — with `poolSlotAwareness` on — places behind every node
with a free slot before one whose slots are full (see
[Slot-aware placement](./hub-pool.md#slot-aware-placement)). Same loopback write, same `hub` line
(`applied — slot count none → 4 (PATCH /api/user-settings 200)`), same read-back before anything is
called applied, same `unset` clearing through the preferences route, and a Hub whose preferences
carry no `ollamaSlots` is failed as predating the setting. When both flags are given the cap is
written first, then the slot count, each as its own `hub` line.

```bash
cihub fleet backends --backends ollama --ollama-parallel 4 --ollama-context 16384 --ollama-keep-alive 24h --execute   # drop-in + each Hub's inferenceOllamaSlots=4 and inferenceMaxNumCtx=16384
cihub fleet backends --backends ollama --ollama-parallel 4 --ollama-context unset --ollama-keep-alive 24h --execute   # drop the context key from the file, clear each Hub's cap; slots still 4
cihub pool context-cap 16384                                                                                           # the same cap, on this node only
cihub pool slots 4                                                                                                     # the same slot count, on this node only
```

Both `fleet backends` lines carry `--ollama-keep-alive 24h` because the file is rendered whole from
the flags on the line: a run that names only `--ollama-parallel` and `--ollama-context` would drop
`OLLAMA_KEEP_ALIVE` from every node and restart each daemon to make it so. Roll the Hubs
(`cihub fleet update --hub --execute`) before the first run that passes `--ollama-parallel`: on a
Hub that predates the slot count, the drop-in applies and then the `hub` line fails as above, which
leaves that node's daemon at N slots with its Hub stating nothing.

#### llama-server is not a Hub backend

The fleet does not install a separate llama-server. Ollama is how that engine ships. `--backends` accepts `ollama`, `omlx`, `vllm`, and `lemonade`. oMLX is Apple Silicon (`brew install jundot/omlx/omlx`, then `omlx start`). vLLM is NVIDIA only. Lemonade is AMD or NPU and stays operator-managed.

#### Firewall rules for the Hub's engine probes

Every pooled request runs a live health probe against each local engine port before it ranks
candidates — one probe per engine Hub still offers, each with a 5 s timeout. On a node whose `ufw` silently **drops** the
Docker-bridge SYN to an engine port, the probe cannot get a reset and waits out the whole timeout:
measured 2026-09-20 as a flat 5.0 s pool TTFT on beta-nas, beta-1, core-6 and core-5, against
22–100 ms once the port answered. Only `:11434` had ever been allowed through.

So `backends` also plans, for every node where ufw is active,
`ufw allow from 172.16.0.0/12 to any port <p> proto tcp` for each port the Hub probes — **11434**
(Ollama), **8000** (oMLX or vLLM), and **13305** (Lemonade) —
next to the existing bridge rule. A silent DROP costs 5 s per pooled request. `172.16.0.0/12` is Docker's whole default
address pool, so compose networks are covered without enumerating them. It reads `ufw status` the way ufw
does — top down, first match wins, and `ufw allow` appends — so a port the table already decides
for the bridge gets nothing added: an `ALLOW` (from that CIDR or wider, or from `Anywhere`, alone
or in a list such as `8000,8080,13305/tcp`) is reported as present, and a `DENY` or `REJECT` the
operator placed (the audit's `ufw reject … port 8000,8080,13305` on beta-1, beta-nas, core-6 and
core-5, kept as reject on beta-1's `:8000` on purpose) is reported as failing fast and left alone —
an allow appended behind it would never fire. After adding, the step re-reads the whole table and
fails the node if the first rule matching a planned port is still not an allow, however many allow
rows sit below. Nothing is planned where ufw is inactive or absent — nothing drops the probes there
— and a node whose `ufw status` needs root the account does not have says so rather than guessing.
`--execute` only, like everything else here; the dry run prints the exact commands per node.

### `cihub fleet install`

Per node, in order: probe hardware → **load gate** → Linux and Docker check → **preflight** →
install `cihub` → **portal device** → `hub up` and register → **claim** → install the status-file
timer → install the GPU probe timer → **tailscale cert** → optionally join a pool. Each step re-checks the state it claims to have
produced, because a step that trusts an exit code is how a fleet ends up believing it registered
machines it never reached. `hub up` reads the port the Hub was actually given (`API_PORT`, which a
port heal can move) and fails when nothing answers there or the answer does not say `registered`.

The **`cihub` binary** comes from this machine, not from the node. The release assets live in a
private repository, so a node cannot fetch them; the first installer had each node try and every
node got a 404. Either set `GH_TOKEN` (for example `GH_TOKEN="$(gh auth token)"`) and the run
fetches the release asset here — once per architecture, verified to be an ELF binary — and streams
it down the SSH session it already holds, or pass `--cihub-binary <path>` to a `cihub-linux-x64` /
`cihub-linux-arm64` asset already on disk (`--cihub-version <tag>` pins which release the token
fetches; default `latest`). The token never reaches a node. Before any node is dialled, the run
resolves what it has to a version: `latest` becomes the tag GitHub names right now, printed on the
summary line as `release v0.2.72 (latest)`, and a `--cihub-binary` is run here with `version`. Every
node then compares against that one real version, never the word `latest`. A `cihub` already on the
node is adopted only when it is not older than it — a forgotten `~/.local/bin/cihub` from months ago
once drove a fresh install and ran `up` against service names that no longer existed, and a July
build adopted against `latest`, with a current release in hand, did not know how to seed a headless
Hub — and a copy that would shadow `/usr/local/bin/cihub` on the login shell's PATH is moved aside
(renamed, never deleted) so the node runs the one that was just installed. When nothing comparable is
on offer — no token and no file, a release lookup the token cannot do, or a `--cihub-binary` that
will not run on this machine (an arm64 asset on an x64 laptop; `--cihub-version` then names what it
is) — an existing `cihub` is still adopted, and the node's line says `version not compared` and why,
rather than reading like a check that passed.

The **portal device** step mints the node's pairing code as late as possible: after every gate and
after the binary is on the node, immediately before `register`. A code is one device's credential
and Portal refuses a second device by the same name, so minting first meant one failed download
left an orphan device in Portal and a name the next attempt could not use. A minted code is kept
in `~/.config/cihub/fleet-pending-pairing-codes.json` (owner-readable only, scoped to the org of the
login that minted it) until the Hub reports registered, and a retry reuses it. A kept code that a
later `cihub fleet devices re-register` replaced is refused, naming the re-register, rather than
sent — Portal honours only the newest (see `fleet devices` below). A `409` on mint names the two
things it can mean — an orphan from an earlier attempt, or a node registered under another org —
because only a person in Portal can tell which; when this machine re-registered the device, the
`409` says that instead, and to pass the code with `--code`.

A kept code is reused for a day, and every reuse says how old it is. One kept longer than 24 hours
is dropped and replaced before anything is sent: a fresh mint, or — when that `409`s because the
device row outlived its code — a re-register of that row with a `device:manage` login (a
`device:pair` login stops the node and names the scope). Portal's own lifetime for a code is seven
days, which its source calls a guess to be shortened; a code a day old belongs to an attempt nobody
retried, and the only other test of it is a twenty-minute `hub up` ending at `register` (core-6 on
2026-09-26 went out "reusing the code minted 2026-09-23T03:14", three days on, with nothing to say
so). `fleet devices release` forgets the released device's kept code, since its row is gone. The dry
run lists the nodes it would install on as a table led by `Would install on N of M rostered
node(s)`, says per node whether it would mint, reuse or replace a kept code, and lists the rows the
roster holds back with their reasons.

A code Portal *refuses* is a different failure, and until 2026-09-22 it was the one with no way out:
fifteen nodes failed with `410 PAIRING_CODE_INVALID`, and the two retries that followed re-sent every
one of those dead codes — same code, same mint timestamp on the line — because the kept code was
never dropped, not even after all fifteen devices were released in Portal. Now `register`'s answer is
read. A refusal (`no longer valid`, `PAIRING_CODE_WRONG_DEVICE`, `DEVICE_PROOF_REQUIRED`) drops the
kept code, and where the stored login is `device:manage` the run re-registers the device for a live
code and sends that one, once — a re-register rather than a second mint, because the device row
already exists and `POST /api/devices` would answer `409`. With a `device:pair` login there is
nothing to re-register with, so the node's line says so and names the scope; the dead code is dropped
either way, so the next run mints instead of re-sending it. The dry run says which of the two the
stored login is before anything is dialled.

A failure *after* Portal accepted the code is not retried at all. Portal claims a pairing code at
validation and provisions the Cloudflare tunnel and DNS record afterwards, so a `DNS provider error
while creating record` — despite its own "Please retry" — arrives with the code already spent, and a
replacement meets the same wall: one node burned three freshly minted codes on three identical DNS
errors. Those failures drop the kept code and stop the node, saying the code was spent and that the
failure under it is what needs fixing. A failure that never reached Portal at all (`hub up` died
first, the Portal was unreachable) leaves the kept code alone, to be reused on the next run.

The **claim** step is the one this list used to be missing. Registering a node does not give it an
operator, and a Hub with no operator answers `409 AUTH_ERROR_HUB_NOT_CLAIMED` to its own device key —
the state twelve of sixteen Hub Pool nodes were in while it was being read as a key failure. Pass
`--claim-email <addr>` to run it; without it the step is skipped and says so on the node's line, because
guessing whose CI Account owns fourteen appliances is not a default anything should hold. It is safe to
re-run: a Hub that already has an operator reports it and the step passes.

The **load gate** refuses any node above 1.5× cores of one-minute load. A fleet-wide pass caught one
machine mid-inference at load 108–116 on 32 cores; its package transaction stalled rebuilding an
initramfs it could never get CPU for, and the box needed physical recovery. Nothing in that pass
checked load first.

The **tailscale cert** step is the same thing [`cihub fleet cert`](#cihub-fleet-cert) does, run
once per node: pooling dials every peer at `https://<its MagicDNS name>`, and until this step
nothing in the install path provisioned the certificate behind that URL. It is best-effort in the
same way as the timer — a node whose tailnet has HTTPS off, or that has no tailscale, is still an
installed Hub and the line says why it cannot pool yet — but a node where `tailscale cert` ran and
the store still lacks the file is a failed step.
The **preflight** step is the five checks of [`cihub fleet preflight`](#cihub-fleet-preflight), run
against the node just before the first thing that changes it. A `block` ends that node's install
there, with the finding on its line; `--force` goes ahead and prints the finding marked as
overridden. `update` runs the same gate before its first change.

Pairing codes are covered under
[Registering a fleet without a browser](#registering-a-fleet-without-a-browser): a stored
`device:pair` login mints one per node, `--code` enrolls a single node, and any other combination is
refused before anything is dialled. `--join-pool` leaves the pairing **pending** — the receiving Hub
still has to approve it, and the step output says so.

### `cihub fleet update`

`--hub` runs [`cihub pool update`](#cihub-pool-update) on each node — the published-image redeploy,
so a node with no build toolchain takes an update the same way as one with a checkout. The image ID
is read before and after, and each node's line says what moved: `d5ff45d9 → 7370f6f3`, or
`(unchanged)`. Without a pin, each node gets whatever `:dev` points at when its turn comes, which on
a slow pass has been two different builds. `--pin-digest <repo@sha256:…>` deploys one named build on
every node; `--to-majority` reads the whole roster first and pins to the build most of it already
runs, refusing when that is half the fleet or less, or a tie, so that "majority" is never a euphemism
for "plurality". A pinned update whose node completes but is not running the pinned image is a
failure, whatever `pool update` said. The pin holds for that run only — it reaches `pool update` as
`CI_HUB_IMAGE` and is not written to the node — and the run ends by saying so.

`--models a,b` pulls each model, trying the Hub-managed container, then a host `ollama` binary, then
the HTTP API, because this fleet runs Ollama three different ways. Pass at least one of the flags,
or the command says there is nothing to do and exits `0`.

`--gpu-probe` installs the per-process GPU VRAM probe on each node — the same step `fleet install`
runs, alone, so it can be rolled onto a fleet that is otherwise untouched. It writes the checked-in
`scripts/host-probes/cihub-gpu-processes.{sh,service,timer}` (bundled into the CLI) to the SSH
account's `~/.local/bin` and `~/.config/systemd/user`, takes one sample, enables lingering, and
enables the timer: `nvidia-smi` or `rocm-smi` on the host every 15 seconds into
`<data-dir>/state/hardware/gpu_processes.json`, which the Hub container reads; the container itself
has neither tool. A node with neither tool is reported as skipped, not failed. The Hub needs no
restart and no new `cihub` binary on the node. What the file means and how the Hub uses it is in
[`fleet-setup.md`](fleet-setup.md#per-process-gpu-vram-a-host-timer-the-hub-reads).

`--models recommended` asks **each node's own Hub** for the list it already computes for that
hardware, rather than applying one list to every machine — the flat list is how this fleet drifted
to between 2 and 23 models per node. The dry run reads from every node (read-only, not offline) and
prints each list with its provenance; `--execute` pulls what the Hub's live tag list says is missing
and reports each model as pulled, already present, or failed. `nomic-embed-text` is appended to every
node's list under either form, because CI-Server will not boot without it. The mechanics, the three
provenances, and the 409-vs-401 distinction are in
[`fleet-setup.md`](fleet-setup.md#models-per-node-not-per-fleet).

Model pulls are serialised for a measured reason: concurrent cold loads of 20–50 GB blocked the
nodes' own HTTP listeners long enough that the tooling reported them absent while they were working.

### `cihub fleet apps`

Deliberately a **check, not an installer**. Per node it asks whether the Hub will serve
`hermes-agent` / `openclaw` their credentials at all, and reports the inference **base URL** those
credentials carry — never the key, which is the Hub operator credential and would be spread further
by a fleet log than by the install itself. Whether that node's Hub has pool routes is reported
separately, on the node's own line, because the two disagree in the direction that matters: a base
URL is baked in at install time, so an app installed before a peer was paired keeps pointing at the
local backend even once the pool is live. `--endpoint` names which of the two the run is *about*; it
does not change what is fetched.

Installing is not offered here because every installed app receives the Hub device key in its
environment, so installing one grants Hub operator authority. That belongs behind the Hub's own
entitlement checks, in the UI or API, not fanned out blind across a fleet — and the command prints
the same warning when it finishes.

### `cihub fleet rdp`

Remote desktop on each Linux node, reachable **from the tailnet only**. The dry run prints, per
node, who owns tcp/3389 (`none`, `xrdp`, `gnome-remote-desktop`, `other`, or `unknown` when the probe
could not run as root), what it is bound to, and the plan. `--execute` applies the plan and then
re-reads `ss -ltn`: the node **fails if anything off the tailnet can still reach 3389**, whatever the
install script exited with.

The plan is decided by the owner. Nothing on the port, or `xrdp` bound wider than the tailnet,
installs `xrdp xfce4 xfce4-terminal dbus-x11`, writes `startxfce4` to the SSH account's
`~/.xsession`, and sets `port=tcp://<tailnet-ip>:3389` in `/etc/xrdp/xrdp.ini`. `gnome-remote-desktop`
cannot bind an address, so it gets `rdp-tailnet-guard.service` — an iptables chain that accepts
tcp/3389 from `tailscale0` and `lo` and rejects everything else with a TCP reset. Anything else on the
port is refused by name. There is **no flag to bind `*:3389`**. Background, and the `address=` trap
that makes this command necessary, in [`fleet-setup.md` → Remote desktop](fleet-setup.md#remote-desktop-tailnet-only).
### `cihub fleet cert`

A Hub Pool peer is stored under its tailnet FQDN and reached at `https://<fqdn>`, so
[`hub-pool-fleet-testing.md` §1.2](hub-pool-fleet-testing.md#12-each-node-can-reach-the-others-hub-over-tls)
is a hard gate: a TLS error there means nothing downstream can pass. The certificate behind that URL
is `tailscale cert <fqdn>` on the node, and no tooling had ever run it — when measured, fourteen of
eighteen nodes had one because someone had done it by hand.

Per node, in order: is there a `tailscale` CLI → is the daemon running → does `tailscale status
--json` report any `CertDomains` (empty means HTTPS is off for the whole tailnet, and no per-node
command helps) → which name is this node's (`Self.DNSName`, trailing dot removed) → can this session
read the store (root, or `sudo -n`) → is `<fqdn>.crt` there, and what does `openssl x509 -enddate`
say. Each answer carries how it was learned, in the `--json` output as `{ value, via }`, so
"unreadable without sudo" can never be mistaken for "absent".

The dry run prints, per node, the exact command it would run — `sudo tailscale cert <fqdn>` — or the
reason it would not. With `--execute` it runs that command and then **re-reads the store**, because
the exit code says what `tailscale cert` believed and the store says what the Hub will find. The
issue is idempotent: tailscaled returns the cached certificate while it is valid and only goes to
the CA when it needs to, so re-running across a fleet that already has certificates is a local call
per node. The CLI is told `--cert-file /dev/null --key-file /dev/null` on purpose — without those it
also drops `<fqdn>.crt` and `<fqdn>.key` into the current directory on every node, and with `-` it
would print the private key into the SSH session's captured output.

Non-Linux nodes, nodes without tailscale, and nodes where this session has neither root nor
passwordless sudo are skipped with the reason on their line. The local node is never dialled; run
`sudo tailscale cert` on it by hand.

### `cihub fleet devices`

```bash
cihub fleet devices list [--org <id>] [--json]
cihub fleet devices release <name|slug|id> [--org <id>] [--yes]
cihub fleet devices re-register <name|slug|id> [--org <id>]
```

What Portal knows about the organization's devices, and the two changes to it a fleet operator
needs without a browser. None of these dials a node; they talk to Portal with a stored
`cihub login --scope device:manage`, and refuse — naming that command — with anything less.

`release` deletes the Portal record and everything under it (tunnel, DNS, installed apps'
registrations, OAuth client), exactly as the browser's delete does, and asks first unless `--yes`.
It is for a device this organization no longer owns. Reinstalling fifteen nodes from scratch on
2026-09-18 left three that Portal still knew under their old organization — `cihub register`
answered `403 DEVICE_PROOF_REQUIRED` on every attempt, because Portal keys devices globally by
device ID and the wipe had destroyed the key that would prove ownership — and one whose name an
earlier failed attempt had taken. Each needed a person in Portal; now `release` from a login in the
old organization frees it, and `fleet install` enrols it into the new one.

`re-register` keeps the record and mints a replacement pairing code, marking the device inactive
until it pairs again: for a node that is staying in this organization but has lost its key. The
code is printed with the `cihub register --code` line to run on the node.

Portal honours only the newest code, so a re-register also kills any code a `fleet install` on
this machine had kept for the node (see `fleet install` above). On 2026-09-20 a re-register of
core-1 was followed by `fleet install --nodes core-1`, which reused the code it had kept from the
day before and failed at register with "Pairing failed". Now `re-register` writes the new code
into the kept-codes file under the roster node whose name is the device's name or slug — the
same mapping `fleet install` uses when it mints — replacing the stale one, and prints the
`fleet install --nodes <node> --execute` line that will reuse it. If no roster node carries the
name, it says so; pass the code to the next install with `--code`. Every re-register is also
recorded, so a `fleet install` that still finds a kept code older than a re-register for that
device refuses it and names the re-register, instead of sending a dead code. A re-register run on
another machine leaves no record here.

Targets must match exactly one device by name, slug or Portal id — `core-1` never matches
`core-17` — and an ambiguous name is refused with the candidates listed, because this precedes a
delete. `--org` names another organization the login's holder belongs to; the default is the one
the login was minted for.
### `cihub fleet boot-params`

Brings AMD Strix Halo (gfx1151) nodes up to the kernel parameters CI-OS now sets at first boot —
`iommu=pt amdgpu.gttsize=<N> ttm.pages_limit=<M>` — which let the GPU address the bulk of unified
memory instead of the firmware VRAM carve-out. CI-OS applies them **at first boot only**, and ten of
this fleet's twelve gfx1151 nodes were provisioned before that shipped. Nodes that are not gfx1151
are reported and left alone.

Per node the dry run prints **live** (`/proc/cmdline`, what the running kernel got) and **staged**
(`/etc/default/grub`, what the next boot will get) as `full`, `partial` or `absent` — separately,
because they disagree in both directions: staged-but-not-live needs only a reboot, live-but-not-staged
loses the parameters on its next one. Then the target, sized from RAM with CI-OS's own formula
(`reserve = max(4 GiB, total/8)`, `gttsize = total − reserve`, `pages_limit = gttsize × 256`, nothing
below 30 000 MiB), and the one-line diff to `GRUB_CMDLINE_LINUX_DEFAULT`. Re-running on a node that is
already at target plans no change.

`--execute` writes `/etc/default/grub` with a copy at `grub.bak-<stamp>` beside it, runs
`update-grub`, and **never reboots** — it ends with a "reboot required" list for you to work through
one node at a time. The write refuses if the file changed since it was read, and the edit refuses
outright, exactly as CI-OS does, on a `GRUB_CMDLINE_LINUX_DEFAULT` line that is not plainly
double-quoted: a single-quoted line once got silently re-wrapped into a corrupted file and handed to
`update-grub` with no error, and this tool would rather do nothing than guess. It also refuses when a
`/etc/default/grub.d/*.cfg` overrides the line, since the edit would then change nothing while looking
staged.

The **console gate**: a node with `GRUB_TIMEOUT=0` and `GRUB_TIMEOUT_STYLE=hidden` shows no menu on
boot, so if the kernel fails to come up on the new parameters there is nothing to catch it at — and
without an out-of-band console, nobody who could. Two gfx1151 nodes here are in exactly that state.
Such a node is refused unless its `fleet.json` entry carries a `console` (a NanoKVM/PiKVM address, an
IPMI host, `physical`) or you pass `--i-have-console`. The refusal says which in one sentence.

---

## Maintenance

```bash
cihub doctor [env]         # validate env files, Docker access, bind mounts, and registration health
cihub clean [env] [--yes]  # remove generated host-state files for one environment
cihub reset [env] [--yes]  # remove runtime state for one environment
cihub uninstall [--yes]    # full machine cleanup of CI-Hub runtime state
```

`reset` is the environment-focused cleanup path. `uninstall` is the full machine cleanup path.

`doctor` also fails on a `DEVICE_ID` copied from another machine: a machine-ID-shaped value in the env
file that is not this host's `/etc/machine-id`. The Hub refuses to pair with Portal under such an ID,
and `register` stops before it asks for a pairing code. The fix differs for a Hub that is already
registered under the ID. See [One device ID per machine](./fleet-setup.md#one-device-id-per-machine).

---

## Exit codes

The exit code is something a script can rely on. It was not always: `cihub doctor && deploy` walked
straight through a broken Docker bridge, and a fleet run that installed on 0 of 14 machines exited
`0`, so the next step in the chain ran anyway.

| Command | Exits `1` when |
| --- | --- |
| `doctor` | A **decided failure**: Docker or Compose unavailable, a compose file missing, a network/bridge check that ran and failed, a registered Hub with no operator, or a Hub `degraded` for a reason only pairing clears (`portal_rejected`, `tunnel_token_missing`). Registration health comes from `GET /api/registration/phase`, which sends no check-in; see [`portal-check-in.md`](portal-check-in.md) |
| `fleet backends` / `install` / `update` / `apps` / `rdp` | Any node failed. It is counted per node, so 13 of 14 is still a failure. For `rdp --execute`, "failed" includes a node whose 3389 is still reachable off the tailnet after the install |
| `fleet backends` / `install` / `update` / `apps` / `cert` | Any node failed. It is counted per node, so 13 of 14 is still a failure. For `cert`, a node that could not be measured at all, or where `tailscale cert` ran and the store still lacks the file; a node skipped with a reason is not a failure |
| `fleet backends` / `install` / `update` / `apps` | Any node failed. It is counted per node, so 13 of 14 is still a failure |
| `fleet boot-params --execute` | Any node failed, or was **refused** — by the quoting check or the console gate. A refusal is work the run did not do, and a chain must not read it as done. The dry run exits `1` only for a node it could not read |
| `fleet preflight` | Any node would be refused by `install`/`update` — a `block` finding, or a probe that could not run |
| `pool context-cap` | The Hub's build predates the cap (nothing was written), or the cap read back after the write is not the one requested |
| `pool slots` | The Hub's build predates the slot count (nothing was written), or the count read back after the write is not the one requested |
| `models list` / `install` / `rm` | There is no Ollama container to talk to |
| `app status <name>` | That named container is not there |
| `app inspect <name>` | `docker inspect` could not read the container |
| `public-web repair` | A repair step failed |
| `uninstall` | A directory or command failed, so state you asked to be gone is still on the machine |
| `status --write-status-file` | The report could not be delivered |
| `connect openclaw\|hermes` | A probe failed and nothing was written (`2` if a write failed and the backup was restored) |

`app status` with no name on a machine with no containers is an **answer**, not a failure, and exits
`0`. So does a `fleet` dry run — `install` and `update` without `--execute` changed nothing and
reported a plan. Both `public-web` subcommands exit `1` if the Hub cannot be reached at all.

**A yellow box is not a failure.** `doctor` separates a failure from a note, and the distinction is
the one already drawn on screen: `✗` is a machine that cannot run the stack, `○` is state doctor
exists to report. A missing env file before `setup`, an absent root folder, no tunnel token — those
colour the box yellow and exit `0`, because they are answers rather than faults. A check that could
not run counts as an issue but not as a failure either: "could not tell" is not "broken", or an
unequipped machine would report a fleet-wide outage.

Exit codes are set after the box is printed, so trailing output — a fleet skip list, a `--json`
report — still reaches you on a failing run.

### Exit `2` — the command never ran

`2` means the invocation was refused, not that an operation failed:

- **Usage errors.** An unknown command or subcommand, or a flag whose value is missing. In
  `api-key create --name k --capability=full` the inline `=` spelling used to be invisible to the
  parser: the key was minted at the default `write` and the confirmation reported `full` back. Both
  spellings are read now, and a flag that decides privilege is refused when its value is missing
  rather than falling back to a default.
- **A confirmation nobody can answer.** With no terminal and no `--yes` (or `CI_HUB_ASSUME_YES=1`),
  a destructive command exits `2` instead of blocking on a read. "There is no terminal" must never
  by itself mean "yes".
- **`cihub register` over SSH.** The pairing-code prompt needs a TTY and `ssh -n` has none, so
  `register` now refuses immediately naming `--code` rather than hanging on a stdin that will never
  answer and eventually exiting `0` having registered nothing. There is no assume-yes opt-in here:
  assuming yes cannot invent a pairing code, which only your CI Account can produce.
- **`cihub claim` with no terminal and no `--email`.** Same rule as `register`, for the same reason:
  the prompt cannot be answered over `ssh -n`, so it refuses naming the flag.
- **`fleet install --execute` with no way to get a pairing code**, or a Postgres password shorter
  than 8 characters. Both are checked before the first node is dialled.

One inconsistency worth knowing rather than being surprised by: a malformed `fleet` **flag** exits
`1`, not `2`, unlike the rest of the CLI's usage errors.

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
| `cli-claim.ts` | `claim` |
| `cli-app.ts` | `app` |
| `cli-models.ts` | `models`, `mcp`, `public-web` |
| `cli-pool.ts` | `pool` |
| `cli-fleet.ts` | `fleet` |
| `cli-api-key.ts` | `api-key` |
| `cli-update.ts` | `version`, `update`, `self-update`, `connect` |
| `cli-wizard.ts` | `wizard` |
| `catalog-submit.ts` | `login`, `logout`, `submit` |

Shared pieces: `cli-args.ts` (flags and env resolution), `cli-repo-context.ts` (checkout vs packaged
appliance), `hub-context.ts` (env file, compose files, and working directory for the resolved
context), `cli-prompt.ts` (every confirmation, so the non-TTY refusal is worded the same everywhere),
`cli-proc.ts` (process execution), `cli-ui.ts` (colors, boxes, help and man rendering),
`cli-compose-env.ts` (env file and compose profile handling), `docker-engine.ts` (engine discovery
and pinning), `cli-version-skew.ts` (the CLI-vs-stack comparison the three update entry points
share) and `cli-self-update.ts` (which channel owns this binary, and the in-place replacement).

`cli-fleet.ts` owns argument parsing and the eight subcommand runners only; the work is in
`fleet-roster.ts` (the saved fleet), `fleet-discover.ts` (the three probe axes), `fleet-ssh.ts` (the
single SSH transport, so hosts cannot fail differently depending on which function reached them),
`fleet-hardware.ts` (host facts and the load gate), `fleet-backends.ts`, `fleet-install.ts`,
`fleet-apps.ts` and `fleet-rdp.ts` (tailnet-only remote desktop: the `ss` owner probe, the pure
`xrdp.ini` rewrite, the guard unit, and the post-apply verification).
`fleet-apps.ts` and `fleet-boot-params.ts` (the gfx1151 GTT formula, GRUB classification and the
console gate — all pure).
`fleet-hardware.ts` (host facts and the load gate), `fleet-preflight.ts` (the five pre-transaction
checks and the gate `install`/`update` apply), `fleet-backends.ts`, `fleet-install.ts` and
`fleet-apps.ts`.

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
executable for six targets, which is what the desktop app bundles and installs onto `PATH`. The
bundle stamps both `CIHUB_BUILD_VERSION` and `CIHUB_BUILD_REVISION`, so a build with no release tag
still has an identity the Hub image's `org.opencontainers.image.revision` can be compared against —
see [Keeping the CLI and the stack together](#keeping-the-cli-and-the-stack-together).

---

## Environments

The commands that target one environment accept an optional `[env]` argument — `wizard`, `setup`,
`register`, `device-id`, `up`, `down`, `restart`, `recreate`, `status`, `logs`, `config`, `doctor`,
`clean`, `reset`, and the `mcp`, `public-web` and `pool` subcommands:

| Value | Env file | Compose files |
|-------|----------|---------------|
| `local` (default) | `.env.local` | `docker-compose.local.yml` |
| `dev` | `.env.dev` | `docker-compose.prod.yml` |
| `staging` | `.env.staging` | `docker-compose.prod.yml` + `docker-compose.staging.yml` |
| `prod` | `.env.prod` | `docker-compose.prod.yml` |

Every other command takes none, and passing one is not a way to retarget an environment. `fleet`
refuses it outright — `cihub fleet scan prod` is an argument error, because fleet commands act on
remote machines rather than on one of this machine's environments. `app`, `models` and `api-key`
read it as a subcommand name and fail; `connect`, `update`, `self-update`, `uninstall`, `login`/`logout`/`submit`
and `status --write-status-file` ignore it.

Run outside a CI-Hub checkout (a packaged install), `up`/`down`/`reset`/`clean` infer `prod` and
target the canonical desktop data dir, and any `[env]` argument is ignored.
