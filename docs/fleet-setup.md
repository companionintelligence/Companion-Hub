# Fleet and account setup

How to go from one machine to a working fleet: a Companion account, one or more registered devices,
the operators who sign in to each, a private network joining them, and inference capacity pooled
across them.

Each subsystem has its own reference — this page is the order to do them in, what each one actually
buys you, and where the seams are.

| Step | Reference |
|---|---|
| 1. Account and device registration | [`security/hub-portal-trust.md`](security/hub-portal-trust.md), CI-Portal `docs/DEVICE_REGISTRATION.md` |
| 2. Operators on each Hub | [Operators and accounts](#operators-and-accounts-three-identity-planes) below |
| 3. Private network | [`private-vpn.md`](private-vpn.md) |
| 4. Inference backends and models | [`MODEL_REGISTRY.md`](MODEL_REGISTRY.md), [`inference-supervision.md`](inference-supervision.md) |
| 5. Pool the nodes | [`hub-pool.md`](hub-pool.md), [`CLI.md` → Hub Pool](CLI.md#hub-pool) |
| 6. Validate | [`hub-pool-fleet-testing.md`](hub-pool-fleet-testing.md) |
| Optional: remote desktop | [Remote desktop (tailnet-only)](#remote-desktop-tailnet-only) below, [`CLI.md` → `cihub fleet rdp`](CLI.md#cihub-fleet-rdp) |

Every step works headlessly. A Hub reached only over SSH has no dashboard, so the `cihub` commands
below are the whole surface — see [`CLI.md` → Headless](CLI.md#headless--no-graphical-session-required).

## The one-node path

Do this on each machine before any of them are pooled. A single Hub is fully functional on its own;
nothing here is fleet-only.

```bash
cihub up                     # start the stack
cihub register --code <c>    # pair with Companion Portal
cihub claim --email <you>    # create this Hub's first operator
cihub status                 # containers, tunnel, VPN, models
cihub doctor                 # env files, Docker access, bind mounts, operator
```

`cihub register` prints the device ID and Portal URL, then prompts for the six-character pairing code
you generate in the Portal UI. Pass `--code` to skip the prompt in a script. Pairing provisions the
Cloudflare tunnel and DNS, which is why it takes a minute or two rather than being instant.

**Registered is not claimed, and this step used to be missing from this page.** `register` writes the
device key and the organization id and stops; it does not create a row in the Hub's `user` table. That
row was written only by an interactive Portal sign-in in a browser, which is exactly what a machine
reached over SSH does not have. A Hub in between is paired, keyed, and unable to authenticate anybody:
its device key is accepted and there is no operator for it to speak as, so every operator-authenticated
route answers `409 AUTH_ERROR_HUB_NOT_CLAIMED`. Twelve of this fleet's sixteen nodes sat in that state
while the 401 it used to answer was read, fleet-wide, as a device-key problem. The keys were fine.
`cihub claim` is the missing step; `cihub doctor` now fails a registered Hub that has no operator.

**Registration is not optional if you want the marketplace.** Portal issues a device key at pairing,
and Hub stores it as `ciHubApiKey`. Compose downloads and registry JWTs both require it. Without it,
installs fail and tag lists come back empty, so the store looks slow rather than unauthorized. See
[`security/hub-portal-trust.md`](security/hub-portal-trust.md).

## One device ID per machine

Portal knows a Hub only by its device ID. If you copy an env file from one node to another, the
`DEVICE_ID` line comes with it, and Portal then sees two machines as one device. The second one to pair
takes over the first one's registration or is refused. On 2026-09-17 beta-red and beta-nas carried
the same `DEVICE_ID`, and it was neither machine's `/etc/machine-id`. A check of the rest of the fleet
that day found three more nodes, beta-ms-a2, core-14, and core-17, whose machine-ID-shaped
`DEVICE_ID` matched no identifier of their own hardware. Each of those was unique among the nodes
checked, and core-14 was already registered under its ID.

The Hub refuses to pair with Portal (`cihub register`, the registration form, and the Portal link on
the registration page) when `DEVICE_ID` has the shape of a machine ID and matches none of this host's
identifiers. It also logs a warning at every start, and `cihub doctor` fails. `cihub register` stops
before it asks for a pairing code.

The check is skipped when the Hub runs in Docker Desktop's VM or under WSL 2. There, the container's
`/etc/machine-id` belongs to the VM, not to the machine, so a mismatch proves nothing.

If the Hub is not registered yet, give it its own ID:

1. Set `DEVICE_ID` to this machine's own ID in the env file the stack uses, for example
   `sed -i "s/^DEVICE_ID=.*/DEVICE_ID=$(cat /etc/machine-id)/" .env.prod`.
2. Recreate the Hub container so it reads the new value: `cihub up <env>`.
3. Pair it as its own device: `cihub register --code <code>`.

If the Hub is already registered under the ID, it keeps working, and nothing refuses it until it
pairs again. Changing its `DEVICE_ID` means registering it again as a new device, so first find out
whether another Hub carries the same ID:

- If no other Hub does, keep the ID: set `HUB_ALLOW_FOREIGN_DEVICE_ID=true` in the same env file and
  recreate the Hub container. `cihub doctor` then reports the ID as kept from another machine and does
  not fail.
- If another Hub does, decide which one keeps the Portal device. Give the other one its own ID with the
  steps above, and reset its registration from **Settings** before you pair it again.

If you moved a Hub to new hardware on purpose and it must keep its Portal device, set
`HUB_ALLOW_FOREIGN_DEVICE_ID=true` as well.

## Operators and accounts: three identity planes

These are separate, and conflating them is the most common setup mistake. A person can hold all
three and they are still three.

| Plane | Lives in | What it authenticates | Created by |
|---|---|---|---|
| **Portal user** | Portal (cloud) | Buying, org membership, and which devices you may manage | Sign-up at the Portal |
| **Hub operator** | The Hub's own Postgres (`user`, with `operator: true`) | Signing in to *that one* Hub's dashboard, and every operator API route | First-run onboarding in a browser, **or** `cihub claim --email <addr>` on the appliance |
| **Device key** | `state/settings.json` on the appliance (`ciHubApiKey`) | The appliance itself, to Portal | Portal, at pairing |

Each Hub has its own operator table. Creating an operator on one Hub creates nothing on any other —
there is no fleet-wide operator account, and adding a node means onboarding it separately.

A Hub operator is linked to a Portal user through `federated_identity`, keyed on the verified
`(issuer, subject)` OIDC pair. That link is what lets Portal evaluate org grants for the person in
front of a Hub session. An operator with no federated row is treated as a compiled member rather than
an owner. See CI-Engineering `architecture/identity/unified-identity-plan.md`.

**A device key is not a user, and an API key is neither.** `cihub api-key create` mints an MCP-scoped
key for tools; it is refused by the pool routes and by Portal. Two narrower scopes exist, each alone
on its key: `--scope qa:read` reads pool status and the routing log and nothing else, and
`--scope inference` opens the [OpenAI-compatible inference routes](editor-inference.md) for an editor
or SDK and nothing else. Neither is an operator credential. Keep the three planes apart when debugging a
401 — the answer is usually that the right credential was never in play.

> **Every installed app receives the device key in its environment.** Treat app installation as
> granting Hub operator authority. See the operator-key note in
> [`security/hub-portal-trust.md`](security/hub-portal-trust.md).

## What Portal stores about your fleet

Account and device management runs on Portal's D1 (SQLite) database. Hub reads none of it directly —
every fact below reaches Hub over the API, authenticated with the device key.

| Table | Holds | Notes |
|---|---|---|
| `device` | `device_id` (primary key), `api_key`, `name`, `slug`, `status`, `pairing_code` (unique), `catalog_channel`, manufacture and ship dates | One row per appliance. `pairing_code` is the six characters `cihub register` asks for, and it is a bearer credential — Portal rate-limits `GET /api/devices/pair` because the keyspace is otherwise enumerable |
| `device_registration` | `id`, `device_id`, `organization_id`, `last_seen`, `paired_at` | Joins a device to an organization. A device in two orgs has two rows |
| `organization`, `org_plan`, `org_plan_addon` | Membership and the platform plan | Decides device and subdomain allowances |
| `app_entitlement` | Org-scoped marketplace grants | Separate plane from the platform plan — a Pro org is not entitled to every app |
| `organization_acl_policy` | Which member may do what to which app | Evaluated by Portal WhoIs, cached by Hub for UX only |

**`paired_at` is the device allowance charge**, not a timestamp you can read as "when this was set
up". It is `NULL` until the hardware actually pairs, so a registration row created ahead of time
provisions nothing and is not billed. Only `DeviceRegistrationService.claimAllowance` may set it, by
atomic conditional update — that is what makes the allowance a real limit. Usage is counted as
distinct devices, not registration rows, so the number a user is shown and the number they are
refused against agree.

**There is no tailnet data in Portal.** The `device` table has no MagicDNS or Tailscale address
column. This matters for pooling, and is why the Portal discovery leg contributes nothing today — see
[Pooling the fleet](#pooling-the-fleet) below.

### Two different things are called a peer

Keep these apart when reading code or logs:

| "Peer" | Where | What it means |
|---|---|---|
| **Hub Pool peer** | `hub_pool_peer`, on each Hub's own Postgres | Another Hub *you operate* that shares inference capacity with this one. Keyed on tailnet FQDN |
| **Portal peer directory** | `peer_directory`, in Portal's D1 | A public `@handle` → Companion endpoint lookup, for Companion-to-Companion asks between *different people* |

They share no data and serve unrelated features. Portal's peer directory is deliberately a phone book:
it holds handles, endpoints, and OIDC identity, and no relationships, grants, or answers — those stay
on the two boxes involved. Listing is opt-in (`discoverable`), so a user is never enumerable by
default, though resolution by exact handle always works.

## Joining the machines

Hub Pool has no networking of its own. Every node must be on the same tailnet first, and a peer is
stored and dialed by its MagicDNS name.

1. Connect Tailscale on each Hub — browser sign-in from **Settings → Network**, or `TAILSCALE_AUTHKEY`
   for unattended provisioning. See [`private-vpn.md`](private-vpn.md).
2. Confirm each node reports connected: `cihub pool status` shows a `Tailscale` line under **This node**.
3. Give each node its TLS certificate: `cihub fleet cert --user root --execute`, or `sudo tailscale
   cert <this node's MagicDNS name>` by hand on the node. See [The TLS certificate](#the-tls-certificate) below.

A Hub that has not joined a tailnet cannot pool, whatever else is configured.

## Remote desktop (tailnet-only)

Optional, Linux nodes only, and it comes after the tailnet step because it binds to the tailnet
address — a node that has not joined one has nothing to bind to.

```bash
cihub fleet rdp                     # per node: who owns tcp/3389, what it is bound to, and the plan
cihub fleet rdp --execute           # apply, then re-read ss and fail any node still reachable off the tailnet
cihub fleet rdp --nodes fzzy,beta-1 # a subset
```

**Tailnet-only is mandatory, not a default.** Access to these machines is a tailnet ACL decision —
that is the whole basis of `cihub fleet` (see [`CLI.md` → Fleet](CLI.md#fleet)). An RDP listener on
the LAN is a second front door the ACL does not cover, answered by a password prompt on a service
with a long CVE history. On 2026-09-10 the fleet was found with RDP on three nodes, every one on
`*:3389`. There is no flag to widen the bind; the run fails if the re-read shows one.

**What gets installed** depends on what already owns the port:

| Owner of 3389 | Plan |
|---|---|
| nothing, or `xrdp` bound wider than the tailnet | `apt-get install xrdp xfce4 xfce4-terminal dbus-x11`; `startxfce4` into the SSH account's `~/.xsession`; `port=tcp://<tailnet-ip>:3389` in `/etc/xrdp/xrdp.ini`; `adduser xrdp ssl-cert`; enable and **restart** `xrdp`. Proven on eleven Ubuntu nodes |
| `gnome-remote-desktop` (`--system` mode; `fzzy` and `beta-1`) | `rdp-tailnet-guard.service`: an iptables chain on tcp/3389 that accepts from `tailscale0` and `lo` and **rejects with `tcp-reset`** — a LAN client sees "refused", not a hang. Idempotent oneshot; `ExecStop` removes the chain |
| anything else | refused, by name. This tool manages the two servers it knows and does not evict a third |

**The `address=` trap.** xrdp 0.10 accepts the legacy `address=` key and **silently ignores it**.
Set `address=100.x.y.z` with `port=3389` and the daemon still listens on `*:3389`, while the config
reads as if it should not. The bind lives in the `port` directive as a URL — `port=tcp://<ip>:3389`
— and nowhere else. The rewrite `cihub fleet rdp` performs therefore sets that URL **and removes any
`address=` line**, so nobody reads the file later and trusts it. Verify by hand with `ss -ltn`: the
only address on `3389` should be the node's `100.x` address.

**Why gnome-remote-desktop gets a firewall rather than a bind.** Its `--system` daemon has no
listen-address option at all, so the socket is `*:3389` for as long as the service runs. The guard is
judged on its **rules**, not on the unit being active: `ufw enable` and firewall reloads flush user
chains and leave the unit reporting `active` over nothing, which is why `--execute` reads
`iptables -S RDP_TAILNET_GUARD` back and why the unit rebuilds the chain from scratch on every start.
The rule that rejects must say `-p tcp` **before** `--reject-with tcp-reset`; the first hand attempt
did not and iptables refused it. The tailnet is 100.64.0.0/10 (and `fd7a:115c:a1e0::/48` for v6),
but the guard keys on the interface rather than the range, so v6 arrives through the same accept.

**What the command will not do.** It does not create an RDP user (the session belongs to the SSH
account); it does not install a desktop on macOS or Windows nodes (refused as Linux-only — those have
Screen Sharing and their own RDP); and it does not run while a node is under load, for the same
reason `fleet backends` does not — an apt transaction on a saturated box has needed hands-on recovery
here before.
### The TLS certificate

Every peer is dialled at `https://<fqdn>` — pairing callbacks, health polls, every proxied request —
and the certificate behind that URL is a `tailscale cert` on the node. Nothing provisioned it until
`cihub fleet cert` and the matching step in `cihub fleet install`; when measured on this fleet,
fourteen of eighteen nodes had one because someone had run the command by hand, and four did not.
Those four fail [`hub-pool-fleet-testing.md` §1.2](hub-pool-fleet-testing.md#12-each-node-can-reach-the-others-hub-over-tls)
with a TLS error, and that gate is hard: nothing after it can pass.

```bash
cihub fleet cert --user root            # per node: present / absent / why it could not be measured
cihub fleet cert --user root --execute  # sudo tailscale cert <fqdn> where needed, then re-read the store
cihub fleet status --user root          # the TLS CERT column, on every re-probe from now on
```

Two things about measuring it:

- **HTTPS is a tailnet setting first.** `tailscale status --json` reports `CertDomains`; an empty list
  means HTTPS is not enabled in the admin console and `tailscale cert` refuses on every node. The tool
  checks that before anything else and reports it as its own state — an older note here claimed this
  tailnet had no HTTPS, which turned out to be false, but the check is still the right first step.
- **"Unreadable" is not "absent".** tailscaled's store, `/var/lib/tailscale/certs`, is `drwx------
  root`. An unprivileged `ls` prints nothing and exits 2, and the first probe of this fleet reported
  zero certificates on eighteen nodes that had fourteen. Every finding therefore carries how it was
  learned (`{ value, via }` in `--json`), `fleet status` renders anything not measured as `—` with the
  reason, and the word `absent` is reserved for a store that was listed with privilege and lacked the
  file. Pass `--user root`, or an account with passwordless sudo, or the column tells you it could not
  look.

## Pooling the fleet

Full model in [`hub-pool.md`](hub-pool.md). The setup path, in the order it actually happens:

**Find the other Hub.** Two routes, and they are not interchangeable — one learns a name, the other
does not:

```bash
cihub pool discover              # candidates this Hub can name, from the tailnet
cihub pool probe 192.168.1.42    # is there a CI-Hub at this address? (learns no name)
```

`discover` draws on the local Tailscale daemon's peer map, which needs no credential, and on the
Tailscale Admin API when `TAILSCALE_OAUTH_CLIENT_ID` / `TAILSCALE_OAUTH_CLIENT_SECRET` are set. The
OAuth client is optional and earns its keep when a pool spans several networks.

A third directory — the CI Portal device registry — is wired in but **returns nothing today**: the
call presents a device key to a route that wants a browser session, and Portal stores no MagicDNS
field to name a candidate with. It fails silently, so an empty `discover` is not evidence that your
Hub is unregistered. Plan around the tailnet directories and `pool probe`.

**Pair.** By name, from either surface:

```bash
cihub pool pair hub-b.example-tailnet.ts.net --name "Studio"
```

Or by LAN address, which needs no directory and no Tailscale credential — the path for two machines
on one LAN. The PIN is minted on the Hub that will *receive* the request and typed on the one
joining, which is the opposite way round from every other pool command:

```bash
on hub-b:  cihub pool pairing-pin              # six digits, ten minutes, single use
on hub-a:  cihub pool pair 192.168.1.42 --pin 123456
on hub-b:  cihub pool peers && cihub pool approve <id>
```

The PIN authenticates the request; the reply carries hub-b's tailnet name and public key, so the peer
is stored under that name and the pairing starts out signed. The address only ever reached the
handshake — every pooled request afterwards goes to `https://<name>` over the tailnet.

**Approval happens on the receiving Hub.** `cihub pool` manages the machine it runs on and nothing
else, which matters more than usual for a feature about several Hubs.

**Verify.** Once at least one peer is `connected`:

```bash
cihub pool status   # is pooling routing, and if not, which switch is responsible
cihub pool peers    # per-peer health, queue depth, and the models each holds
cihub pool log      # routing decisions, with failovers named
```

An empty routing log means nothing has routed since this Hub started, not that pooling is broken —
the log is in-memory and holds the last 200 decisions.

## Where Ollama listens

One rule and one file, because the alternative was measured on 2026-09-10 and nobody could answer
"what does this node bind" without doing systemd's job by hand:

**systemd applies `ollama.service.d/*.conf` drop-ins in byte order of filename, and the last
`Environment=OLLAMA_HOST=…` wins.** Byte order, not the priority the numeric prefixes suggest: digits
sort before letters, so `10-tailnet-bind.conf` loses to `override.conf`, and `zzzz-bind-all.conf`
outranks `zzz-tailnet-bind.conf` by one letter — which is why beta-red bound `0.0.0.0` while its
tailnet-bind drop-in "was there". Six names set `OLLAMA_HOST` across the fleet, plus a
`.bak-preclaude` copy systemd never reads. An empty `Environment=` line resets everything before it.

`cihub fleet backends` writes the bind to exactly one file, **`zzzzz-cihub-bind.conf`** — the name
sorts after every legacy name, including any future `zzzz-*.conf` — moves aside each `*.conf` that set
`OLLAMA_HOST` and nothing else (renamed to `<name>.disabled-by-cihub-<date>`, never deleted), leaves
any file that also carries other settings in place and outranked, restarts, and then **re-reads
`systemctl show ollama -p Environment` and fails if the merged value is not what it asked for**. The
default is `--bind all` — `0.0.0.0` **behind a firewall guard**; `--bind tailnet` and `--bind local`
are the explicit alternatives. `cihub fleet status` shows each node's effective bind and the file
that set it, flags a conflict read-only, and marks a `0.0.0.0` bind with no active guard **EXPOSED**.

**Why all-plus-guard and not tailnet-only.** The Hub container on the same node reaches its host
Ollama at `host.docker.internal:11434` — the Docker bridge gateway — which a tailnet-only bind does
not listen on. Two nodes measured 2026-09-10 were already tailnet-bound and running ci-hub, and their
Hub→local-Ollama link was dead for exactly that reason. So the daemon binds everywhere, and
`ollama-tailnet-guard.service` — a `RemainAfterExit` oneshot ordered `Before=ollama.service`, so
there is no window — accepts tcp/11434 from `lo`, `tailscale0`, `docker0` and `br-+` (iptables'
wildcard for the bridge compose creates per network) and **rejects everything else with a TCP
reset**, so a LAN client sees "connection refused" rather than a hang. The apply script installs the
guard *before* it restarts the daemon and fails the bind if the guard's INPUT jump is not there
afterwards: a `0.0.0.0` with no guard is the exposure this mode exists to avoid. `--bind tailnet` and
`--bind local` remove a guard an earlier `all` left behind, so switching modes is coherent. The
status probe reads the guard as `systemctl is-active` — no sudo — which for a `RemainAfterExit`
oneshot is evidence, not a hint: rules that failed leave the unit `failed`, not `active`.

Two nodes are deliberately not touched by this path. **beta-1** runs Ollama as a user-scope unit
(`ollama-local.service` under `ci`'s `systemd --user`) with the system unit disabled; enabling the
system unit there would start a second daemon on the same port, so the installer refuses with the
reason — before running ollama.com's installer, which would do exactly that. And a node with no
tailnet address fails the tailnet bind rather than falling back to something else.

When a drop-in seems to have no effect: `systemctl cat ollama` shows the merge order, and
`cihub fleet status` names the winner. Note the seam in [`CLI.md`](CLI.md#ollamas-bind-one-file-read-back):
a Hub container on the same node reaches the host Ollama over the Docker bridge, which a
tailnet-only bind does not listen on.

## Fleet-wide settings worth knowing

Pool settings are **per node**. There is no fleet-wide configuration plane: setting `poolLocalAffinity`
on one Hub changes how that Hub ranks candidates and nothing else. Plan a rollout node by node.

Two settings need coordinating across the fleet rather than set independently:

- **`poolRequireSignedPeers`** turns off the legacy bearer-token path. Setting it while any peer has
  not finished the bearer→signed upgrade takes **both** directions of that pairing down. The upgrade
  runs on a health poll by itself; `cihub pool status` lists the peers not there yet and says when the
  switch has become safe to set.
- **`poolPressureWeight`** only means anything on nodes that can measure GPU pressure, which today is
  Linux AMD with `/sys` bind-mounted. A node that cannot measure reports nothing and ranks mid-band —
  deliberately not idle. On a fleet where most nodes cannot measure, leave the weight at `0`.

## One Ollama version, fleet-wide

`cihub fleet backends` installs Ollama at a **pinned release** — `OLLAMA_PINNED_VERSION` in
`scripts/lib/fleet-ollama-version.ts` — by handing `ollama.com/install.sh` an `OLLAMA_VERSION`, and
reports the install done only after `/api/version` on the node answers with that number. Measured on
2026-09-10, before the pin: eighteen nodes spanned **0.12.11 → 0.33.3**, each running whatever was
current the day it was installed, and nothing had ever printed the spread.

```bash
cihub fleet status                                 # OLLAMA column, "behind pin" marker, one summary line
cihub fleet update --ollama --execute              # bring every node to the pin; nodes already there are left alone
cihub fleet update --ollama --ollama-version 0.33.3 --execute   # roll a specific release instead
```

`--ollama-version` overrides the pin for one run and takes only an exact `x.y.z`; `latest` is refused,
because "whatever is current today" is the policy that produced the spread. `update --ollama` refuses
a node under load (it restarts the daemon), and refuses a node with no Ollama rather than installing
one — that is `backends`' job. The version is always read at the bind the node resolves for itself,
because several nodes here bind `OLLAMA_HOST` to their tailnet address and answer nothing on loopback;
a node that cannot be read shows `—` with the reason, never a stale number.
## Models per node, not per fleet

`cihub fleet update --models a,b` applies one list to every node. On hardware as mixed as this
fleet's — Strix Halo boxes with ~120 GB unified memory next to an 8 GB RTX A1000 — that is how the
model sets drifted to anywhere from 2 to 23 per node, and how one node ended up with no embedding
model at all.

```bash
cihub fleet update --models recommended            # dry run: each node's list and where it came from
cihub fleet update --models recommended --execute  # pull, serialised node by node
```

`recommended` asks **each node's own Hub** for the hardware-fitted list it already computes
(`GET /api/inference/onboarding-profile`, the same recommender the onboarding UI uses), takes its
Ollama picks, and pulls what the Hub's live tag list says is missing. The dry run reads from every
node and changes nothing. Every plan says which of three places it came from:

| Provenance | Meaning |
| ---------- | ------- |
| `hub-recommended` | The node's Hub answered; the list is its top-N for that machine |
| `explicit` | You named the models (`--models a,b`); no Hub is consulted |
| `floor-only` | The Hub could not be asked, and the reason is printed next to it |

Two things hold whatever the provenance:

- **`nomic-embed-text` is always on the list.** CI-Server refuses to boot without a 768-dim embedder
  (it throws on `EMBEDDING_DIMENSION ≠ 768`), so it is a platform requirement appended to every
  node, never a recommendation a smaller machine can lose. Naming it yourself does not pull it twice.
- **A node the Hub cannot speak for gets the floor, not a guess.** The fleet CLI deliberately does not
  assemble a hardware profile from SSH-read facts and run its own sizing: a second recommender that
  disagrees with the node's own Hub is exactly the drift this replaces. Fix the Hub, re-run.

The request runs **on the node** with the device key from its own `state/settings.json` as
`Authorization: Bearer` — the key never crosses the wire and is never printed. That header is the one
the Hub accepts for a device credential (`x-api-key` is not read). Two refusals look alike and are
kept apart because they need opposite fixes: **HTTP 409 `AUTH_ERROR_HUB_NOT_CLAIMED`** means the key
is fine and the Hub has no operator (`cihub claim --email <addr>`); **HTTP 401
`SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN`** means the Hub did not accept the key it was shown.

Per node, `--execute` reports each model as **pulled**, **already present** (per the Hub's tag list,
so no pull is attempted) or **failed**, with the catalog's disk estimate for what was fetched.
`--json` emits the same per node. A node whose Hub could not be asked is a reason on the report; only
a pull that fails makes the run exit non-zero.
## Strix Halo nodes: GTT boot parameters

AMD Strix Halo (gfx1151) boxes expose only the firmware VRAM carve-out to the GPU unless the kernel
is booted with `iommu=pt amdgpu.gttsize=<N> ttm.pages_limit=<M>`. CI-OS sets those **at first boot
only**, so a node provisioned before that shipped — ten of this fleet's twelve, as measured
2026-09-10 — has them absent or partial and loads nothing above its 2 GB carve-out. `cihub fleet
boot-params` is the catch-up path:

```bash
cihub fleet boot-params                      # per gfx1151 node: live vs staged state, target, planned diff
cihub fleet boot-params --execute            # write /etc/default/grub (backup beside it) + update-grub
cihub fleet boot-params --nodes core-10 --i-have-console --execute
```

Three things to know before running it. **It never reboots** — the new parameters take effect on the
next boot, and the run ends with the list of nodes that need one; do them one at a time, when idle,
watching each come back. **Live and staged are reported separately** because they disagree in both
directions: staged-but-not-live is a pending reboot, live-but-not-staged will silently lose the
parameters on the next one. **Two nodes are refused by default.** A hidden zero-timeout GRUB menu
(`GRUB_TIMEOUT=0`, `GRUB_TIMEOUT_STYLE=hidden`) with no out-of-band console means a boot that fails on
the new parameters is recovered at the machine and nowhere else; core-10 and razer are in that state.
Record the console on the node's `fleet.json` entry (`"oob": "nanokvm 192.168.0.115"`) or pass
`--i-have-console` for a node you are physically at. The sizing formula and the refusal on any
`GRUB_CMDLINE_LINUX_DEFAULT` line that is not plainly double-quoted are CI-OS's own, so a node it
provisions and a node this catches up end on a byte-identical line. Full detail in
[`CLI.md` → `cihub fleet boot-params`](CLI.md#cihub-fleet-boot-params).
## Per-process GPU VRAM: a host timer the Hub reads

The Hub container is an Alpine image with no `nvidia-smi` or `rocm-smi` and no GPU device access,
so it cannot see which process holds how much VRAM. Two dashboard figures depend on that reading:
the per-workload GPU chart on the resource monitor, and the model memory budget's measured
"used" figure. Without it the budget falls back to what the engines report about themselves and
marks an engine it cannot size as *not measured*, so the used figure reads as a floor (`≥`).

The reading comes from the host instead, through the same seam the GPU-pressure band uses: a
timer on the node runs the vendor query and writes
`<ROOT_FOLDER_HOST>/state/hardware/gpu_processes.json`, which the Hub reads as
`/data/state/hardware/gpu_processes.json`. A file older than 60 seconds, or absent, reads as
*not measured*, never as zero — a writer that dies must not leave a stale "nothing is loaded"
behind it.

`cihub fleet install` installs it on every new node, and this rolls it onto an existing fleet
(the same step, alone; a dry run without `--execute` prints the plan):

```bash
cihub fleet update --gpu-probe --execute
```

Per node the run writes the three checked-in files (bundled into the CLI, so the standalone `cihub`
carries them) to the SSH account's `~/.local/bin` and `~/.config/systemd/user`, takes one sample,
runs `loginctl enable-linger`, and enables the timer. It reports one of: installed; installed but
only while this user is logged in (lingering was refused); installed but the tool did not answer as
this account (`rocm-smi --showpids` reads the KFD process table, which is root's); no user manager;
neither tool on the node — skipped, not failed, since an Apple or CPU-only node (core-4) is not a
bug. Lingering is enabled *before* `systemctl --user` is tried: on core-3 the user manager only
existed once `enable-linger` had run. Re-running is safe and refreshes the files in place.

By hand, the same install is (the Hub's state directory belongs to the same user, so no root is
needed; the user must be lingering, which `cihub fleet install` nodes are):

```bash
scp scripts/host-probes/cihub-gpu-processes.{sh,service,timer} ci@<node>:/tmp/
ssh ci@<node> 'install -m 0755 /tmp/cihub-gpu-processes.sh ~/.local/bin/ \
  && install -m 0644 /tmp/cihub-gpu-processes.{service,timer} ~/.config/systemd/user/ \
  && systemctl --user daemon-reload && systemctl --user enable --now cihub-gpu-processes.timer'
```

Check it with `systemctl --user list-timers cihub-gpu-processes.timer` and
`docker exec ci-hub cat /data/state/hardware/gpu_processes.json`. On a node whose
`ROOT_FOLDER_HOST` is not `~/.local/share/companion-hub`, set `CI_HUB_STATE_PATH` in a drop-in for
the service. The file is:

```json
{"schemaVersion":1,"sampledAt":"2026-09-21T05:30:53Z","source":"nvidia-smi","vendor":"nvidia",
 "processes":[{"pid":6975,"processName":"VLLM::EngineCore","vramMb":6104},
              {"pid":3161051,"processName":"/usr/local/lib/ollama/llama-server","vramMb":2926}]}
```

`processName` is the vendor tool's own column, verbatim — a full path or process title from
`nvidia-smi`, the 15-character kernel `comm` from `rocm-smi` — because that is what the Hub matches
engines on. Per-process compute *utilization* is not in the file and not coming from these tools:
both report it blank on this fleet's hardware.

The Hub says which source answered. `GET /api/apps/resource-monitor` carries `gpuVramSource` —
`host-file`, `tool` (the vendor CLI run by a Hub outside Docker), or `absent`, meaning nothing on
this node could measure and every workload's `gpuVramMb` is `null` for want of a reading rather than
for want of a workload. The resource dashboard's GPU trend tile and coverage tile print `absent` in
words, with this install step beside it, instead of drawing an empty chart that reads as "nothing
holds VRAM". A fresh file listing no processes is `host-file` with no rows: measured, and idle.

## Before touching a node: preflight

Run this before a fleet install, update, or anything that will install a kernel, a driver or a
`dkms` module. It reads and changes nothing:

```bash
cihub fleet preflight                  # every rostered node, one table
cihub fleet preflight --touches-boot   # rated as it would be before a kernel/initramfs/grub operation
```

`cihub fleet install` and `cihub fleet update` run the same five checks on each node just before the
first thing that changes it, and refuse the node on a `block` (`--force` overrides, and says so in
the log). Reference: [`CLI.md` → `cihub fleet preflight`](CLI.md#cihub-fleet-preflight). The five,
each from a real day on this fleet (2026-09-10, eighteen nodes):

| Check | Why it exists |
|---|---|
| **sudo** | Three nodes had no passwordless sudo for `ci` (sudo-rs; every working node has `/etc/sudoers.d/ci-passwordless`). Installs failed at step six with a message about a terminal. Now they fail at step zero, with the one-line fix. CI OS is unprivileged by design and is reported, not blocked |
| **dpkg** | One node's dpkg was wedged for weeks. `dpkg --audit` and `apt-get check` showed it instantly; nothing had looked. Every package operation on such a box fails until it is cleared |
| **grub-customizer** | The actual cause of that wedge — not the failed kernel removal it was blamed on. grub-customizer's `*_proxy` scripts in `/etc/grub.d` (and `.script_sources.txt`) emit an invalid `grub.cfg` once a kernel they name is gone; `update-grub` refuses it; every kernel postinst fails. Removing the proxies is the fix. Retrying is not |
| **boot-recovery** | Two nodes run `GRUB_TIMEOUT_STYLE=hidden` with `GRUB_TIMEOUT=0`, and one has no IPMI. A kernel that fails to boot there is a trip. Record any console the host cannot see — a NanoKVM, a PiKVM — in the roster as `"oob"`, and the check counts it |
| **apt-lock** | A "24-hour stuck unattended-upgrade" was `unattended-upgrade-shutdown --wait-for-signal`, an idle boot-time hook that holds no lock. The check reads the lock table, not just `ps`, and names that hook for what it is rather than flagging it |

The **load gate** is unchanged and still comes first: the one outage that was blamed on an
initramfs rebuild had, in the journal, a kernel soft-lockup cascade under inference twenty minutes
*before* the rebuild. Load is the cause to gate on; the gate was right.

## Growing and shrinking

- **Adding a node** repeats the whole one-node path: register, **claim** (`cihub claim --email <addr>`,
  or `cihub fleet install --claim-email <addr>`, which runs it for you), join the tailnet, **issue its
  TLS certificate** (`cihub fleet cert --execute`, also run by `fleet install`), install models, then
  pair. Nothing about an existing pool member carries over — including the operator.
- **Taking a node out temporarily** is `cihub pool peer-disable <id>` on the other Hubs, or
  `cihub pool disable` on the node itself. Both keep the pairing and both tokens, so coming back is
  instant and needs no re-approval.
- **Removing a node permanently** is `cihub pool unpair <id>`, which revokes both directional tokens,
  followed by deleting the device in the Portal UI. Unpairing is not how you fix a node that was
  merely offline: an `unreachable` peer keeps being polled and rejoins on its own.
- **Re-imaging a node** means it comes back with a new pool identity. Peers have pinned the old key
  and there is no signed-rotation message in the protocol, so pair it again from scratch.

## Which build the fleet is running

Every node deploys the Hub from the floating tag `ghcr.io/companionintelligence/ci-hub:dev`, which
CI re-points on every merge. That is convenient and it is also why drift is invisible: `docker ps`
prints the same image *name* on every node whatever build is behind it. Measured on 2026-09-10 by
comparing `docker image inspect --format '{{.Id}}'` across the fleet: twelve nodes on one image ID,
two on a second, one each on a third and a fourth — and two of the outliers changed during the
evening, meaning something redeployed them with nothing recording it. Nothing in the fleet tooling
could say "the fleet runs build X", let alone hold it there.

The tag is not the identity. Two are, and they answer different questions:

| Identity | Looks like | Answers |
|---|---|---|
| **Image ID** | `sha256:d5ff45d9…` (`docker image inspect --format '{{.Id}}'`) | Are these two nodes running byte-identical software? This is what `fleet status` compares |
| **Repo digest** | `ghcr.io/companionintelligence/ci-hub@sha256:…` (`RepoDigests`) | What can another node *pull* to get this exact build? An image ID is not addressable in a registry; a digest is. This is what a pin uses |

A locally built image has an ID and no digest, so it can be recognised but never pinned to.

```bash
cihub fleet status                       # IMAGE column, and a footer: "hub image d5ff45d9 on 12/18; drifted: core-3 (9a38714f), …"
cihub fleet update --hub --execute       # floating: each node gets whatever :dev points at when its turn comes; prints before → after per node
cihub fleet update --hub --to-majority --execute            # pin every targeted node to the build most of the roster already runs
cihub fleet update --hub --pin-digest <repo@sha256:…> --execute   # pin to a named build (digest from `fleet status --json`)
```

`--to-majority` measures the **whole roster**, not just `--nodes`, and refuses unless the most common
image is on a strict majority of it — more than half of *all* rostered nodes, unknown ones included.
A node that could not be read is reported `unknown` with the reason and is never counted as agreeing
or as drifting: on the evening this was measured, the unread half of a fleet is exactly where the
surprises were. A tie is refused too, with both contenders named; pick one with `--pin-digest`.

A pin reaches `cihub pool update` as `CI_HUB_IMAGE` for that run only. It is not written to the
node's env file, so a later `cihub pool update` run by hand on the node — or by whatever redeployed
core-3 and core-6 that evening — floats back to the tag. To hold a node, set `CI_HUB_IMAGE` to the
digest in its env file; `pool update` honours it in either place.

## Troubleshooting the seams

| Symptom | Usual cause |
|---|---|
| Store installs fail, catalog looks empty or slow | Not paired, or the device key cannot be stored. Run `cihub register` |
| A correct device key gets `409 AUTH_ERROR_HUB_NOT_CLAIMED` | Registered but never claimed: the `user` table is empty, so there is no operator for the key to speak as. Run `cihub claim --email <addr>` on the node. Before this existed the same state answered `401 SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN`, which is what got twelve nodes diagnosed as key failures |
| `cihub pool` returns "Hub not paired" | Pool routes need the Portal device key, not an `api-key create` key |
| `cihub pool discover` lists nothing | Expected without a tailnet connection or an OAuth client. Use `cihub pool probe` and pair by address |
| `curl https://<fqdn>/...` to a peer fails with a TLS error | No `tailscale cert` on that node. `cihub fleet cert --user root` says which nodes, and `--execute` issues it. If it reports `HTTPS not enabled on tailnet`, turn HTTPS on in the Tailscale admin console first |
| `fleet status` shows `— unreadable without sudo` under TLS CERT | The store is root-only and the SSH account is not. That is a measurement that did not happen, not a missing certificate — re-run with `--user root` |
| Peer stuck `pending` | The request was never approved. Approve it on the Hub that received it |
| Peer flips to `unreachable` | Three failed health polls. It rejoins on the first successful one; no action needed |
| Pooling shows `disabled_by_env` | `HUB_POOL_USER_DISABLED=true` in the env file wins over the in-product switch, and needs a restart |
| A pin appears to do nothing | Pins reorder, they never force. `cihub pool status` marks a pin whose target cannot serve right now |
| `xrdp` still on `*:3389` after editing `xrdp.ini` | You set `address=`; xrdp 0.10 ignores it silently. Put the address in `port=tcp://<tailnet-ip>:3389`, or run `cihub fleet rdp --execute`, which does exactly that and removes the misleading key |
| `cihub fleet rdp` says `owner unknown` | The probe could not run as root, so `ss -p` could not attribute the socket. Pass `--user` with an account that has passwordless sudo |
| RDP from the LAN hangs instead of refusing | The guard is missing or was flushed. `cihub fleet rdp --execute` rebuilds `RDP_TAILNET_GUARD`; a proper reject answers with a TCP reset |
