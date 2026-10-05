# Apple container (experimental)

Hub can run on [Apple container](https://github.com/apple/container), Apple's runtime that runs each Linux container in its own lightweight VM on a Mac. Apple container has no Docker socket, so Hub reaches it through [socktainer](https://github.com/socktainer/socktainer), which serves a Docker-compatible API on top of it.

**Status: experimental.** The engine discovery, detection, and guards described here have unit tests. They have not been run against a real Apple container engine, and no full Hub stack has been started on one. Treat the gaps below as the known ones, not the complete list.

## Requirements

- A Mac with Apple silicon on macOS 26 or later. Apple container needs macOS 26 for container-to-container networking and custom networks.
- [Apple container](https://github.com/apple/container) installed, from its signed installer package.
- socktainer, installed with `brew install socktainer`. Its README names the Apple container version it targets, so read the socktainer release notes before you upgrade either one.

## Set up

1. Start socktainer. It starts the Apple container service if that is not running, and creates the socket at `~/.socktainer/container.sock` and a Docker context named `socktainer`.

   ```bash
   socktainer
   ```

2. Check that Docker clients reach it.

   ```bash
   DOCKER_HOST=unix://$HOME/.socktainer/container.sock docker version --format '{{.Server.Platform.Name}}'
   ```

   The output is `socktainer`.

3. Start Hub. The desktop app finds the socket on its own. To select it explicitly, set `CI_HUB_DOCKER_HOST` before you start the Hub.

   ```bash
   export CI_HUB_DOCKER_HOST=unix://$HOME/.socktainer/container.sock
   ```

## How the desktop app chooses an engine

Apple container is the last choice on a fresh install:

- If Docker Desktop or another Docker engine answers, the desktop app uses that engine, even when socktainer is also running.
- If socktainer is the only engine that answers, the desktop app uses it and records that it is experimental in `state/docker-engine.json`.
- If a Hub stack already exists on socktainer, the desktop app keeps it there. Moving it would start a second stack on the same host ports.
- `CI_HUB_DOCKER_HOST` and `DOCKER_HOST` override all of the above.

The desktop app does not edit Docker Desktop's VM memory, CPU, or disk settings when Apple container is the pinned engine. Apple container has no shared VM to tune.

## What differs from Docker

| Area | On Apple container | Effect on Hub |
|------|--------------------|---------------|
| Joining a running container to a network | socktainer accepts `network connect` and `disconnect` and does nothing. Networks are fixed when a container is created. | Hub does not attach itself to app networks or Traefik to the edge network, and logs a warning once. A service that is not on the shared Hub network cannot resolve `ci-hub`, so an app that calls Hub inference from such a service fails with `ENOTFOUND`. A Traefik created before the edge network existed is reported as `failed` until you recreate it with `cihub up`. |
| Memory | Each container is a VM with 1 GiB of memory unless you set a limit. There is no unlimited mode. | Hub sets a memory limit only when the app or the install form provides one. An app that needs more than 1 GiB can run out of memory until you set a limit. |
| CPUs | A fractional `cpus` value rounds down to whole cores, with a minimum of 1. | None to configure. |
| Restart policies | The socktainer process enforces them. They do not survive a socktainer restart or a reboot. | Start socktainer again, then start the Hub stack. |
| Static container IPs | socktainer cannot honor them. | A compose file that pins an address does not get that address. Use service names instead. |
| Pause and unpause | Not supported. | None. |
| GPU | `container run` has no GPU option. | Hub reports the engine as `apple-container` in the hardware profile. Run inference on the host. |

For the full list, see the limitations section of the [socktainer README](https://github.com/socktainer/socktainer#readme) and the [Apple container networking guide](https://github.com/apple/container/blob/main/docs/networking.md).

## What Hub detects

Hub reads `GET /version` from the engine. socktainer answers with the platform name `socktainer`, which Hub treats as Apple container. A daemon that does not answer is not treated as Docker: Hub asks again on the next call.

On detection Hub logs one warning that lists the gaps above. Each skipped network attach logs its own warning once.

## Known gaps

- **Network attach at create time.** Hub could attach services to the networks it needs when it creates them, which Apple container supports. That changes compose generation on every platform and needs a real Apple container run to validate, so it is not done.
- **Settings → System guidance.** The memory guidance still tells you to open Docker Desktop. On Apple container, set per-app memory limits instead.
- **End-to-end verification.** The socktainer behavior in this page comes from its documentation and source, not from a Hub run.
