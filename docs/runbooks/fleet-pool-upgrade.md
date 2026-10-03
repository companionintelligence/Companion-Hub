# Upgrading the fleet so Hub Pool has peers

Today exactly one fleet node — `core-3` — answers `GET /api/inference/pool/identify`. Every other
Hub on the tailnet runs a build that predates [Hub Pool](../hub-pool.md), so `cihub pool discover`
finds nothing to pair with and pooling can never leave a single node.

This runbook takes the fleet from one pool-capable Hub to several. Budget about an hour, most of it
waiting on a container build.

## Why this needs a release first

Hub Pool merged to `dev` on 2026-09-05 and is in **no release tag**. Every published image predates
it:

| Image tag | Built | Pool-capable |
|---|---|---|
| `ghcr.io/companionintelligence/ci-hub:dev` | 2026-08-29 | No |
| `…:latest` / `…:0.2.62` | 2026-08-31 | No |
| `…:staging` | 2026-06-27 | No |
| `…:nightly` | does not exist | — |

So `docker pull` on a fleet node gets a non-pool build **whichever tag it asks for**, and no amount of
restarting changes that. `core-3` is the exception because it was built from a `dev` checkout on the
box rather than pulled. The first half of this runbook exists to produce an image worth pulling.

The nightly job that would otherwise cover this is gated to manual dispatch by `ci-local` to cut
GitHub Actions billing, which is deliberate — leave it gated.

## Fill these in first

| Placeholder | What it is | Example |
|---|---|---|
| `<version>` | The tag cut in step 2 | `v0.4.0` |
| `<image>` | Versioned image the release publishes | `ghcr.io/companionintelligence/ci-hub:0.4.0` |
| `<node>` | MagicDNS name of the node being upgraded | `hub-a.example-tailnet.ts.net` |
| `<data-dir>` | That node's Hub data directory | `~/.local/share/companion-hub` |
| `<env-file>` | Env file in `<data-dir>` | `.env.dev` on Linux, `.env` on Windows |

The image tag is **unprefixed** — `0.4.0`, not `v0.4.0`. `hub_env.rs` strips the `v` when composing
its pin, so a `v`-prefixed reference is unpullable.

---

## 1. Land the `cihub models` fix first

`findComposeName` is imported by `scripts/lib/cli-models.ts` and `scripts/cihub-cli.ts` but is not
exported from `scripts/lib/cli-doctor.ts` on `dev`. Every `cihub models` subcommand therefore dies on
`TypeError: (0 , import_cli_doctor.findComposeName) is not a function` — a raw stack trace where every
neighbouring command prints a message box.

Nothing catches it: `turbo run tsc` runs per package and `scripts/` is not one, and tsx transpiles
without typechecking, so the missing export survives to runtime.

Cutting `<version>` from `dev` as it stands ships that bug to every appliance this runbook upgrades.
Land the one-word fix and its regression test before step 2.

**PASS:** `cihub models list` prints a message box rather than a stack trace.

## 2. Cut the release tag

`semver-tag.yml` is **not** gated — it fires on push to `staging`, reads conventional commits since
the last tag, bumps, and pushes the tag.

```bash
git checkout staging && git merge --ff-only origin/dev && git push origin staging
```

With 130 commits since `v0.3.0` carrying 19 `feat:` and no breaking changes, it computes a **minor**
bump: `v0.3.0` → `v0.4.0`. It also commits the `package.json` bump and pushes the tag alone, so the
workflow does not retrigger itself.

**PASS:** `git fetch --tags && git tag --contains 6597fdbb2` names your new tag. That commit is
`feat(hub-pool): pool inference across Hub nodes over Tailscale` — if the tag does not contain it,
the release will not be pool-capable and everything downstream is wasted.

## 3. Publish the versioned image

The tag alone ships nothing. Dispatch the container build against it:

```bash
gh workflow run build-container.yml --repo companionintelligence/CI-Hub \
  --ref <version> -f environment=production -f tag=<version>
```

`environment=production` is what makes the resolver emit a versioned tag at all — `dev` and `staging`
publish only their channel tag. This publishes `<image>` **and moves `latest`**, so plan it as a
release, not a test.

Use `desktop-release.yml` instead only if you also want signed desktop bundles; it calls this same
workflow and additionally needs the six Azure signing secrets on the `production` environment.

**PASS:**

```bash
curl -s "https://ghcr.io/token?scope=repository:companionintelligence/ci-hub:pull&service=ghcr.io" \
  | jq -r .token | xargs -I{} curl -s -H "Authorization: Bearer {}" \
  https://ghcr.io/v2/companionintelligence/ci-hub/tags/list | jq '.tags'
```

lists the unprefixed version. GHCR reads anonymously, so this works from any machine.

---

## 4. Upgrade each node

Repeat for `core-2`, `bench-2`, and `beta-max`. `everxr-01` is Windows — see the note below.
`core-3` is already pool-capable; leave it alone.

Each appliance resolves its image in this order (`resolveApplianceHubImage`):

1. `CI_HUB_IMAGE` from the env file, if set
2. otherwise the installed `companion-hub` package version
3. otherwise `:latest`

That gives two routes. **Prefer the package route** — it keeps the CLI, the desktop binary, and the
container on one version. Use the pin route when you want a specific image without moving the package.

### Package route

```bash
ssh <node>
sudo apt update && sudo apt install --only-upgrade companion-hub
cihub restart
```

### Pin route

```bash
ssh <node>
cd <data-dir>
cp <env-file> <env-file>.bak.$(date +%s)          # rollback in step 6 depends on this
sed -i 's|^CI_HUB_IMAGE=.*|CI_HUB_IMAGE=<image>|' <env-file>
grep -q '^CI_HUB_IMAGE=' <env-file> || echo 'CI_HUB_IMAGE=<image>' >> <env-file>
docker compose --env-file <env-file> -f docker-compose.prod.yml pull ci-hub
docker compose --env-file <env-file> -f docker-compose.prod.yml up -d ci-hub
```

Only the `ci-hub` service is recreated. Postgres, RabbitMQ, and Traefik keep running, and installed
apps are untouched.

**PASS, from any machine on the tailnet:**

```bash
curl -s http://<node>:5002/api/inference/pool/identify
# {"isCiHub":true,"nodeFqdn":...}
```

A `404` here means the node is still on a pre-pool build: the pull silently no-opped, or
`CI_HUB_IMAGE` did not take. Check `docker inspect ci-hub --format '{{.Config.Image}}'` before
retrying.

### everxr-01 (Windows)

Its env file is `.env`, not `.env.dev`, and it has no `apt`. Take the pin route with the same
`docker compose` commands from PowerShell, or upgrade the Companion Hub desktop app and let it
rewrite the pin. Do it last — it is the one node whose failure mode differs from the rest.

## 5. Pair the pool

Discovery needs a Tailscale OAuth client with the `devices:core:read` scope on **whichever Hub does
the discovering** — one is enough, and a Hub without the credential can still be paired *with*.

```bash
# on the discovering Hub
cihub pool discover
cihub pool pair <node>

# on the receiving Hub — approval cannot be delegated
cihub pool peers
cihub pool approve <id>
```

`cihub` always talks to `127.0.0.1`, so the prompt is part of the instruction: it can never approve on
another node's behalf.

**PASS:** `cihub pool status` on both sides shows the peer `connected` and `routingActive: true`.

Then walk [`hub-pool-fleet-testing.md`](../hub-pool-fleet-testing.md) for routing, load handoff,
failover, recovery, and the kill switch. `<model-beta>` in that plan wants a model on exactly one
node — the fleet's single-node large models suit it.

## 6. Rollback

Per node, in the order that matches how you upgraded:

```bash
# pin route
cd <data-dir> && cp <env-file>.bak.<stamp> <env-file>
docker compose --env-file <env-file> -f docker-compose.prod.yml up -d ci-hub

# package route
sudo apt install companion-hub=<previous-version>
```

Unpairing is **not** rollback. A peer on an older image simply stops answering capability probes and
is marked `unreachable`; paired Hubs keep polling it and it rejoins on the first successful probe.
Unpair only to remove a node from the pool for good.
