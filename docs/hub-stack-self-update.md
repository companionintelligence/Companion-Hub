# Hub stack self-update

The Hub can replace its own container with a newer release. Settings → Update, the MCP tool `hub_perform_update`, and a daily timer all go through `SystemUpdateService` (`packages/backend/src/modules/system-update/`). This page covers what that updater changes, what it refuses to change, and how you turn it off on a node.

The desktop app binary has its own updater; see [`DESKTOP-AUTO-UPDATE.md`](DESKTOP-AUTO-UPDATE.md).

## What the updater moves

The updater only advances a **release pin**: a Hub whose running image and whose `CI_HUB_IMAGE` are both `ghcr.io/companionintelligence/ci-hub:<version>`, such as `ci-hub:0.2.70`.

It leaves every other node alone and says why:

| `CI_HUB_IMAGE` or running image | What the updater does |
|---|---|
| `ci-hub:0.2.70` | Moves the pin to the newest stable release, for example `0.2.72`. A pre-release pin such as `0.2.73-rc.1` can also move to a newer pre-release. |
| `ci-hub:dev`, `ci-hub:staging`, `ci-hub:latest`, or any other tag that is not a version | Refuses. The node stays on its channel. |
| `ci-hub@sha256:…` | Refuses. |
| A local build or another registry, such as `ci-hub-ci-hub:latest` | Refuses. |

There is no override. To move a node between channels, edit `CI_HUB_IMAGE` in the Hub env file and recreate the Hub, for example with `cihub pool update`.

A refused manual update returns HTTP 409 with the reason. `GET /api/system/update/check` reports the same reason in `updateBlockedReason` and never offers an update to a refused node.

### How the updater knows what runs

The updater reads the running container through the Docker socket. It never uses `CI_HUB_VERSION`, which comes from the install's env file and was wrong on 10 of 16 fleet Hubs on 2026-09-17.

- The **release** comes from a version tag in the image reference, then from the `org.opencontainers.image.version` label, then from a version tag Docker holds for the same image. A `dev` build has none of these, so `current` reads `dev@<commit>`.
- The **commit** comes from `org.opencontainers.image.revision`.

Release images published before this change, 0.2.71 included, carry `org.opencontainers.image.version=latest`, so on those the version tag is the only source.

## How the updater recreates the Hub

The updater recreates the Hub the way compose created it, not the way a standard install would lay it out.

1. It reads the running container's `com.docker.compose.*` labels: project, service (`ci-hub`, or `ci-os-hub` on older compose files), working directory, compose files, and env file. A label that names a path inside the Hub container, such as `/data/.env`, is translated to the host path through the container's bind mounts.
1. It pulls the target image. If the pull fails, nothing else happens.
1. It writes `CI_HUB_IMAGE` and `CI_HUB_VERSION` to the env file.
1. It starts a short-lived updater container named `<hub container>-stack-updater`. The container binds each host path at the same path, so the compose client reads the same files the Docker daemon mounts. Compose runs with only the env file, the target image, and absolute `ENV_FILE` and `COMPOSE_FILE_HOST` values; the Hub's own process environment does not reach it.
1. The updater container checks that the env file is readable and that compose resolves the Hub service to the target image. Then it runs `docker compose up -d --no-deps --force-recreate --no-build <service>`. It does not recreate the queue or database and does not remove orphans.

If any step in the updater container fails, it starts every container of the project that was running when it began. If the Hub container is not on the target image, it restores the previous env file.

The updater refuses with HTTP 409, and leaves the env file as it was, when it cannot reproduce the stack:

- The Hub container has no compose labels.
- Compose read a different env file than the one mounted at `/data/.env`.
- A compose path is not an absolute POSIX path, contains a comma, or overlaps a directory the updater container needs.

If the updater container cannot start at all, the Hub restores the env file and returns HTTP 500.

When the desktop host listener accepts the update, the Hub writes the new pin and the desktop app stops the stack and pulls on its next start; steps 2, 4, and 5 do not run. The channel check still applies first.

## Turn off auto-update on a node

The daily check updates a release-pinned node only while `autoUpdates` is on. It defaults to on.

To turn it off, use any one of these:

- In the Hub UI, open **Settings** and turn off **Auto-update stack**.
- Call `POST /api/system/update/auto-updates` with `{"enabled": false}` as an authenticated user.
- Call the MCP tool `hub_set_auto_updates` with `{"enabled": false}`.
- On the host, set `"autoUpdates": false` in `<ROOT_FOLDER_HOST>/state/settings.json`.

The Hub reads the file at every check, so the change applies without a restart. Other settings writes keep the value. A node on a channel such as `:dev` never auto-updates, whatever this switch says.

## Where to look when an update fails

- `<ROOT_FOLDER_HOST>/logs/hub-stack-update.log` has one block per attempt. Lines from the updater container start with `stack-updater:` and the block ends with `result=ok` or `result=failed`.
- The Hub log records every refusal as `Hub stack update refused:` and every skipped daily check as `Auto-update skipped:`.
