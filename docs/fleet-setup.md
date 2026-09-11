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
key for tools; it is refused by the pool routes and by Portal. Keep the three apart when debugging a
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

A Hub that has not joined a tailnet cannot pool, whatever else is configured.

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

## Growing and shrinking

- **Adding a node** repeats the whole one-node path: register, **claim** (`cihub claim --email <addr>`,
  or `cihub fleet install --claim-email <addr>`, which runs it for you), join the tailnet, install
  models, then pair. Nothing about an existing pool member carries over — including the operator.
- **Taking a node out temporarily** is `cihub pool peer-disable <id>` on the other Hubs, or
  `cihub pool disable` on the node itself. Both keep the pairing and both tokens, so coming back is
  instant and needs no re-approval.
- **Removing a node permanently** is `cihub pool unpair <id>`, which revokes both directional tokens,
  followed by deleting the device in the Portal UI. Unpairing is not how you fix a node that was
  merely offline: an `unreachable` peer keeps being polled and rejoins on its own.
- **Re-imaging a node** means it comes back with a new pool identity. Peers have pinned the old key
  and there is no signed-rotation message in the protocol, so pair it again from scratch.

## Troubleshooting the seams

| Symptom | Usual cause |
|---|---|
| Store installs fail, catalog looks empty or slow | Not paired, or the device key cannot be stored. Run `cihub register` |
| A correct device key gets `409 AUTH_ERROR_HUB_NOT_CLAIMED` | Registered but never claimed: the `user` table is empty, so there is no operator for the key to speak as. Run `cihub claim --email <addr>` on the node. Before this existed the same state answered `401 SYSTEM_ERROR_YOU_MUST_BE_LOGGED_IN`, which is what got twelve nodes diagnosed as key failures |
| `cihub pool` returns "Hub not paired" | Pool routes need the Portal device key, not an `api-key create` key |
| `cihub pool discover` lists nothing | Expected without a tailnet connection or an OAuth client. Use `cihub pool probe` and pair by address |
| Peer stuck `pending` | The request was never approved. Approve it on the Hub that received it |
| Peer flips to `unreachable` | Three failed health polls. It rejoins on the first successful one; no action needed |
| Pooling shows `disabled_by_env` | `HUB_POOL_USER_DISABLED=true` in the env file wins over the in-product switch, and needs a restart |
| A pin appears to do nothing | Pins reorder, they never force. `cihub pool status` marks a pin whose target cannot serve right now |
