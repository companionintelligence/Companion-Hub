# [Companion Hub](https://ci.computer/hub)

Companion Hub is the self-hosted app hub in the Companion Intelligence product model. This repository is the source of truth for the Hub itself, while CI Cloud handles device registration and release orchestration.

Part of the [Companion Intelligence](https://github.com/companionintelligence) ecosystem. Licensed under the [GNU Affero General Public License](LICENSE).

## Choose the guide that matches your job

| If you are… | Start here |
| --- | --- |
| Installing or running a Hub on a device | [Canonical first-run guide](#canonical-first-run-guide) |
| Developing the Hub locally | [docs/DEVELOPER-SETUP.md](docs/DEVELOPER-SETUP.md) |
| Operating releases or environments | [docs/RELEASE-ARCHITECTURE.md](docs/RELEASE-ARCHITECTURE.md) |
| Cleaning up legacy names and compatibility surfaces | [docs/COMPATIBILITY-NOTES.md](docs/COMPATIBILITY-NOTES.md) |
| Working on the native desktop shell | [packages/desktop/README.md](packages/desktop/README.md) |

## Canonical first-run guide

This is the primary path for installing Companion Hub from this repository.

### What you need

| Requirement | Why it matters |
| --- | --- |
| Docker 28+ | Runs the Hub and installed apps |
| Git | Gets the repository and bundled install script |
| Bash, curl, openssl | Used by the install/start flow |

You do **not** need pnpm or Node just to run a Hub instance from this guide.

### 1. Clone the current repository

```bash
git clone https://github.com/companionintelligence/CI-Hub.git
cd CI-Hub
```

### 2. Create your environment file

```bash
cp .env.example .env.prod
```

Edit `.env.prod` and set the required values:

- `ROOT_FOLDER_HOST` — absolute host path for Hub data, state, logs, and app definitions
- `POSTGRES_PASSWORD` — password for the bundled Postgres container
- `JWT_SECRET` — random secret for sessions and auth tokens
- `INTERNAL_IP` — the device IP the Hub should advertise on your LAN
- `DOMAIN` — the root domain used for Companion routing
- `CI_CLOUD_URL` — your CI Cloud / portal URL for pairing and sync

### 3. Install and start the Hub

```bash
./scripts/install.sh --env-file .env.prod
```

The installer downloads the current release CLI, prepares a local runtime directory, and starts the Hub using the environment file you provided.

### 4. Finish first run in the UI

Open <http://localhost:5002>.

On first run:

1. Create the local admin account.
2. Get a pairing code from CI Cloud.
3. Enter that pairing code in Companion Hub to register the device.
4. Wait for registration and tunnel provisioning to finish.
5. Install apps from the marketplace.

### Updating an existing Hub

```bash
./scripts/updater/update.sh
```

## What lives where

- `README.md` — end-user install and first-run truth
- `docs/DEVELOPER-SETUP.md` — local development setup and verification
- `docs/RELEASE-ARCHITECTURE.md` — release triggers, artifacts, environments, and operator responsibilities
- `docs/COMPATIBILITY-NOTES.md` — explicit legacy names that still exist for compatibility

## License

[GNU Affero General Public License](LICENSE)
