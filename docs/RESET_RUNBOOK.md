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
cihub down dev              # optional — reset also tears down containers
cihub reset dev --dry-run   # optional — list what the reset would remove, change nothing
cihub reset dev --yes       # or: cihub reset prod --yes
cihub up dev --detached
```

What it does:

0. Lists the apps and containers it will remove (step 1) before it asks for confirmation. `--dry-run` prints that list and the host data it would delete, including any folder in it that you cannot delete as your user (step 5), then stops. If Docker cannot list containers, the reset stops without removing anything: an app with a restart policy would come back with the daemon, against the deleted data.
1. Removes every installed app: the containers, networks, and named volumes of each compose project labelled `ci-hub.managed=true` or `ci-os-hub.managed=true`. Apps are separate compose projects, so the next step does not reach them, and apps left running keep bind mounts into the deleted data directory and Hub credentials the reset Hub rejects.
   It also removes any other container attached to the Hub network (`ci-hub_network`, `ci-os-hub_network`, or their underscore spellings) that is not part of the Hub's own compose project. The Hub never installed these, so it has no record of them before or after the reset. Only the container goes; no named volume can be traced to it, and its bind mounts under the data directory go with step 4. On beta-max (2026-09-22) four containers started with `docker run` under Hub-style app names ran on `ci-hub_network` against `app-data/`, invisible to the Hub, which could not stop, expose, or uninstall them.
2. `docker compose down -v --remove-orphans` — removes Hub containers **and** named volumes such as `ci_hub_pgdata`
3. Verifies lingering Hub volumes (`ci_hub_pgdata`, `ci_hub_app_data`, `hub_tailscale_state`) and removes any leftovers
4. Deletes host `hub-data` / tunnel directories (repo dev), or on a prod appliance the canonical `companion-hub` tree and the Hub's files in the `tunnel` folder beside it (`~/.local/share/tunnel` on Linux). Compose mounts `${ROOT_FOLDER_HOST}/../tunnel`, so an appliance keeps its Cloudflare `token` and `registration.json` there, outside the data dir; left behind, they let the next `cihub up` start the previous Hub's tunnel before the fresh Hub is paired. `tunnel` is a generic name, so reset deletes only what `cihub uninstall` deletes there: the token when it is a cloudflared token, `registration.json` and `leftover.json` when they carry a `tunnelId`, `.user-cleared-token`, then `certs/` and the folder once they are empty. A symlinked `tunnel` folder is not followed.
5. If a folder or tunnel file survives because containers wrote into it as root (EACCES), retries through a root container, `docker run --rm -v <folder>:/d alpine rm -rf /d/*` (for a tunnel file, its folder is mounted and the file deleted by name), in both modes. With rootless Docker that container's root is your user, so it cannot delete files owned by root either.
6. Checks that the apps' containers and volumes, the Hub's containers, the Hub volumes, and the host folders and tunnel files are gone. It prints **Reset complete** only when they are. Otherwise it prints **Reset incomplete**, lists each survivor (for a folder, the folders inside it that stopped the delete, the errno, and the owner), prints the commands that finish the job, such as `sudo rm -rf -- '<folder>'`, and exits 1. `cihub recreate` then does not start a Hub on the old data.

Every `docker` call in steps 1 to 6 goes to the Docker engine the Hub is pinned to (`state/docker-engine.json` in the data dir, shared with the desktop app), as `docker compose down` already did. The pin is read before anything is deleted. Before this, on a machine with two engines (Docker Desktop beside colima or a WSL engine) the app teardown, the final check, and the root container went to the default engine, so reset could remove nothing from the Hub's engine and find nothing left on the other.

In a checkout, a root folder or tunnel folder that is the repository, holds it, is your home directory, or lies outside both is refused and reported, never deleted. Paths are compared after resolving symlinks, so `ROOT_FOLDER_HOST=.`, `..`, `$HOME`, or a symlinked spelling of the repository cannot turn `cihub clean` into `rm -rf` of the checkout.

During the 2026-09-26 fleet rebuild, reset hit EACCES on the data dir on 3 of 17 nodes (core-2, core-3, fzzy), still printed "host data were removed", and exited 0. On 13 of the other 14 the data dir was deleted, and a `companion-hub` folder was back within seconds anyway: the GPU probe timer (`cihub-gpu-processes.timer`, see [fleet-setup.md](fleet-setup.md)) writes `state/hardware/gpu_processes.json` every 15 s and creates the folders it needs (on core-6 the desktop app also wrote `logs/`). That folder is harmless and does not need to be moved aside: `cihub up` and `fleet install` seed a fresh install whenever `.env` and the compose file are missing, whatever else the folder holds. When the timer is installed, **Reset complete** says so.

Use this when the Hub API is down, Docker state is corrupted, or you want the same outcome as a factory install.

Step 1 assumes one Hub per Docker daemon, because the managed labels do not say which Hub installed an app.

`cihub clean` removes installed app containers and their networks, and the other containers on the Hub network, before it deletes the data directory, and keeps their named volumes. `cihub down` stops only the Hub's own project, so without this step `cihub down && cihub clean` left apps running against deleted bind mounts. Clean deletes host folders, and on an appliance the Hub's tunnel files, as in steps 4 and 5; if one survives, it lists what is left in the same way and exits 1.

The legacy `scripts/nuke.sh` and `scripts/unsafe-cleanup.sh` also remove installed apps before they delete Hub state. If Docker cannot list containers, they stop without deleting anything, because apps with a restart policy come back with the daemon. To keep the apps, run `sudo scripts/nuke.sh --keep-apps`; the script lists them and what they still depend on.

## Settings: Factory reset Hub

**Settings → General → Factory reset Hub**

- Requires an **operator** login
- Requires typing the confirmation phrase: `factory-reset`
- Calls `POST /api/system/factory-reset`
- Tears down installed apps, wipes Postgres tables (including `user` and every API key, so agents and `cihub api-key` users need new keys afterwards), clears `settings.json`, app data mounts, repos, backups, and registration artifacts
- Does **not** remove Docker named volumes — use `cihub reset --yes` if you also need `ci_hub_pgdata` removed while containers are stopped

Best when the Hub is healthy but auth/setup is stuck after a partial reset.

## Settings: Remove this Hub from my account

**Settings → Network → This Hub in your account → Remove from account**

- Opens CI Portal at `/home?remove_device=<device id>`, where an owner or admin confirms deleting the device
- Deleting the device in CI Portal removes its web addresses and apps from the account
- While the page stays open, the Hub checks in about every 30 seconds for up to 15 minutes. When CI Portal answers `DEVICE_NOT_ACTIVE`, the Hub resets and opens the pairing screen
- If the page closes first, the hourly check-in resets the Hub the same way

The Hub cannot remove itself from CI Portal. Its device key is also held by first-party apps, so CI Portal accepts removal only from a signed-in owner or admin.

## Settings: Reset this Hub only

**Settings → Network → This Hub in your account → Reset this Hub only**

- Clears `device_registration`, tunnel token, `tunnel/registration.json`, and resolved env, and stops `cloudflared`
- **Does not** delete the operator account
- **Does not** change CI Portal: the device, its web addresses, and its apps stay in the account
- Use when you only need to pair again with CI Portal, not wipe local users/apps

The API is `POST /api/registration/reset`. It accepts only a person signed in to the Hub; the Portal device key, the CLI JWT, and app or MCP keys get 403.

To pair again, complete device registration at `/device-registration`.

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

Local factory reset / CLI reset clears **Hub-side** registration artifacts. The device record in CI Portal stays until you re-pair, or an owner or admin deletes it in CI Portal (see [Remove this Hub from my account](#settings-remove-this-hub-from-my-account)). Portal-side re-register behaviour is handled in the separate `ci-portal` repository.
