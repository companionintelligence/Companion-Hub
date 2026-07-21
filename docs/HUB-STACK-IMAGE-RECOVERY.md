# Recovering a Hub that cannot pull its stack image

Symptom: the Hub never starts. `docker ps` shows only the Postgres container, the Hub API
never answers, and the desktop is stuck on **Hub Not Running** / **Error**. Because
marketplace apps are launched *by* the Hub, this usually gets reported as "Companion Memory
won't launch" — that is the first action that needs an API which never booted.

Confirm the cause in the desktop log (tray → **View Logs**). A pull failure looks like:

```
Stack image pull failed (non-fatal, continuing): ... 403 Forbidden
```

## Who is affected

Builds **0.2.42 – 0.2.44** pinned `ghcr.io/companionintelligence/ci-os-hub:<version>` — a
private package that no workflow published version tags to, so anonymous Docker got `403`
([#920](https://github.com/companionintelligence/CI-Hub/issues/920)). Builds from 0.2.45
onward pin the public `ghcr.io/companionintelligence/ci-hub:<version>` and are unaffected.

Check which reference a machine is using:

```bash
# Linux:   ~/.local/share/companion-hub
# macOS:   ~/Library/Application Support/computer.ci.app.hub
# Windows: %APPDATA%\computer.ci.app.hub
grep CI_HUB_IMAGE <data-dir>/.env.dev      # .env on Windows
```

An affected machine shows a `ci-os-hub` reference.

## Fix: update the desktop app

Updating is the whole fix. On the next start the desktop discards the unusable `ci-os-hub`
pin, rewrites `.env` to a `ci-hub` reference, and — because the env file changed — forces a
fresh pull. No manual `docker tag` and no `.config-hash` editing is required.

**The in-app updater cannot be used here.** The update action lives in Settings, which sits
behind the Hub-status gate, so a Hub that will not start also hides the button. Use one of
these instead; both talk only to the release CDN and do not need a running Hub.

Run the bundled CLI:

| Platform | Command |
|---|---|
| Linux | `companion-hub update` |
| macOS | `"/Applications/Companion Hub.app/Contents/MacOS/companion-hub" update` |
| Windows | `"C:\Program Files\Companion Hub\companion-hub.exe" update` |

Add `--check` to test without installing (exit code `1` means an update is available).

Or reinstall over the top from <https://dl.ci.computer> or the GitHub Releases page. Hub
data and settings live in the data directory and are preserved.

Then start the Hub and confirm recovery in the log:

```
Superseding pinned stack image ghcr.io/companionintelligence/ci-os-hub:0.2.44 with ghcr.io/companionintelligence/ci-hub:<version> (desktop build default).
```

## If a release ships without its versioned image

The pipeline now blocks this: `build-container.yml`'s `verify-anonymous-pull` job checks —
unauthenticated, on a clean runner — that the exact reference desktop bundles will pin is
anonymously pullable on `linux/amd64` and `linux/arm64`, and it runs before any bundle is
built. Should a tag still go missing, run the **Publish Hub Stack Tag** workflow rather than
re-running the release:

- `source_ref`: an image that already exists, e.g. `ghcr.io/companionintelligence/ci-hub:latest`
- `tag`: the missing version, unprefixed, e.g. `0.2.45`

It copies the existing multi-arch manifest and asserts the digest is unchanged, so users
pull the artifact that was already validated rather than a fresh, untested build. Rebuilding
from source would produce a different image.

## Why tags are unprefixed

Published version tags are `0.2.45`, never `v0.2.45`. `default_hub_image()` in
`hub_env.rs` strips the `v` when composing its pin, and the backend's
`pinHubStackVersionInEnv` interpolates the raw listed tag into `<repo>:<tag>` — a
`v`-prefixed tag is unpullable on both paths. GHCR still carries legacy `v`-prefixed tags
from a retired workflow; they are inert because update listing reads the Portal mirror, not
GHCR. `scripts/release/resolve-hub-image-tags.cjs` enforces the unprefixed form and is the
shared source of truth for what CI publishes and verifies.
