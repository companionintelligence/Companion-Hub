# CI-Hub reset runbook

Companion Hub has several reset surfaces. They are **not** equivalent — pick the one that matches how much state you need to remove.

## Quick reference

| Goal | Use this | Removes users? | Removes apps/data? | Removes Portal pairing? |
|------|----------|----------------|--------------------|-------------------------|
| Full wipe (first-operator flow) | `cihub reset <env> --yes` | Yes | Yes | Yes (local artifacts) |
| Full wipe while Hub is running | Settings → **Factory reset Hub** | Yes | Yes | Yes (local artifacts) |
| Re-pair device only | Settings → Network → **Re-register Device** | No | No | Yes (local pairing only) |
| Clear local tunnel token | Desktop tray → **Clear Tunnel Token** | No | No | Partial (token file only) |

After any **full** reset, start the stack again (`cihub up dev`, `cihub up prod`, or launch Companion Hub desktop) and open `http://localhost:5002/login` — you should see the first-operator setup flow (`isConfigured: false`).

`cihub up prod` run outside a CI-Hub checkout (appliance mode) will recreate `~/.local/share/companion-hub` if it is missing. It prompts interactively for a database password (`POSTGRES_PASSWORD`); set that variable in the environment to skip the prompt.

## CLI: `cihub reset`

From the CI-Hub repository (dev) or from any directory in appliance/prod mode:

```bash
cihub down dev          # optional — reset also tears down containers
cihub reset dev --yes   # or: cihub reset prod --yes
cihub up dev --detached
```

What it does:

1. `docker compose down -v --remove-orphans` — removes containers **and** named volumes such as `ci_hub_pgdata`
2. Verifies lingering Hub volumes (`ci_hub_pgdata`, `ci_hub_app_data`, `hub_tailscale_state`) and removes any leftovers
3. Deletes host `hub-data` / tunnel directories (repo dev) or the canonical `companion-hub` tree (prod appliance)
4. If `hub-data` contains root-owned files (EACCES), retries cleanup via `docker run --rm -v <path>:/d alpine rm -rf /d/*`

Use this when the Hub API is down, Docker state is corrupted, or you want the same outcome as a factory install.

## Settings: Factory reset Hub

**Settings → General → Factory reset Hub**

- Requires an **operator** login
- Requires typing the confirmation phrase: `factory-reset`
- Calls `POST /api/system/factory-reset`
- Tears down installed apps, wipes Postgres tables (including `user` and every API key, so agents and `cihub api-key` users need new keys afterwards), clears `settings.json`, app data mounts, repos, backups, and registration artifacts
- Does **not** remove Docker named volumes — use `cihub reset --yes` if you also need `ci_hub_pgdata` removed while containers are stopped

Best when the Hub is healthy but auth/setup is stuck after a partial reset.

## Settings: Re-register Device

**Settings → Network → Re-register Device**

- Clears `device_registration`, tunnel token, `tunnel/registration.json`, and resolved env, and stops `cloudflared`
- **Does not** delete the operator account
- Use when you only need to pair again with CI Portal, not wipe local users/apps

### Paired reset (Hub + Portal)

When the device is still registered in CI Portal but Hub local pairing is broken (or you need a clean re-pair without wiping apps/users):

1. **Settings → Network → Re-register Device** — clears Hub-side pairing artifacts only
2. Complete device registration again at `/device-registration`

The API is `POST /api/registration/reset`. For a full Portal deregister during factory reset flows, the backend supports `deregisterFromPortal: true` on the registration reset path used by operator tooling — local Settings re-register does **not** remove the Portal device record automatically.

If you need the device removed from Portal as well, delete it from **Account Management** in CI Portal, or use operator/CLI reset tooling that passes `deregisterFromPortal`.

## Desktop tray: Clear Tunnel Token

**Tray menu → Clear Tunnel Token (not full reset)**

- Stops the Hub compose project (best effort)
- Stops managed app containers (best effort)
- Deletes the Cloudflare tunnel token file on disk
- **Does not** truncate Postgres or remove operators

Labelled explicitly so it is not confused with a full reset.

## Verify a full reset worked

```bash
# Postgres volume should be gone after CLI reset
docker volume ls | grep ci_hub_pgdata || echo "pg volume gone OK"

# After `cihub up`, user table should be empty
docker exec ci-hub-db psql -h localhost -p 6543 -U companion -d companiondb \
  -c 'SELECT COUNT(*) FROM "user";'

# API should report unconfigured
curl -s http://localhost:5002/api/user-context | jq '.isConfigured, .isLoggedIn'
```

Expected: `isConfigured: false`, `isLoggedIn: false`, user count `0`.

## CI Portal note

Local factory reset / CLI reset clears **Hub-side** registration artifacts. The device record in CI Portal may still exist until you re-pair or remove it from Account Management. Portal-side re-register behaviour is handled in the separate `ci-portal` repository.
