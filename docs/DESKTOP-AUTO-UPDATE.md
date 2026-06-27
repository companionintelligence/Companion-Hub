# Desktop Auto-Update

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

How the Companion Hub desktop app updates itself, and how to QA it.

## Architecture

The desktop app uses a custom updater (`packages/desktop/src-tauri/src/updater.rs`),
not `tauri-plugin-updater`. It ships full installers from the production CDN and
verifies them by size + SHA-256 from the release manifest.

```
dl.ci.computer/latest.json            → {"version":"v0.2.16", ...}
dl.ci.computer/v<ver>/manifest.json   → per-platform installer URLs + size + sha256
dl.ci.computer/v<ver>/<os>/<arch>/…   → installers (dmg/msi/exe/deb/rpm/AppImage)
```

Both files are produced by `.github/workflows/desktop-release.yml` (`upload-r2` job).

| Environment | CDN | Bucket |
|---|---|---|
| production | `https://dl.ci.computer` | `dl-prod` |
| dev | `https://dl-dev.ci.computer` | `dl-dev` |

Production releases update the public auto-update feed. Dev releases update a
separate dev feed so dev desktop builds can update without touching production.

### Update triggers

| Trigger | Path |
|---|---|
| Settings UI (desktop) | `perform_desktop_update_command` Tauri command |
| Settings UI (browser) | backend `/api/system/update/host-listener-token` → `POST 127.0.0.1:17400/update` (token-authed listener) |
| CLI | `companion-hub update` (`--check` for exit-code-only: 1 = update available) |
| Hub Docker stack (separate from app binary) | backend `SystemUpdateService` daily timer, gated by the Settings auto-update toggle |

The desktop **app binary** is never updated without a user action; the **stack
images** auto-update daily when the toggle is on.

### Install flow (per platform)

- **macOS** — mount DMG, `ditto` the `.app` over the install target, relaunch.
- **Windows** — a detached helper script waits for the app to exit, runs
  `msiexec /qn` (or NSIS `/S`), relaunches, and cleans up. The app exits as soon
  as the helper is spawned: a Windows installer cannot replace a running binary.
- **Linux** — `pkexec dpkg -i` / `pkexec rpm -U`, or AppImage replacement. The
  AppImage target comes from `$APPIMAGE` (set by the AppImage runtime); the old
  file is unlinked before copying to avoid `ETXTBSY`.

Before installing, the updater stops the Hub Docker stack and invalidates the
config hash so the relaunched app re-pulls images and recreates containers.

If the app is still running when an update lands from the listener (browser
trigger), the freshly-started new instance signals the old one through the
single-instance plugin (`--relaunch-after-update`); the old instance restarts
itself onto the new binary.

## QA / local testing

Unit + integration tests (includes a hermetic local-HTTP-server end-to-end of
check → manifest → download → verify):

```bash
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

Check against the production feed without installing anything (exit code 1 means
an update is available):

```bash
./target/debug/ci-os-hub-desktop update --check
```

**Debug builds only**: point the updater at a local server to rehearse a full
update without touching production:

```bash
mkdir -p /tmp/update-feed/v9.9.9
# latest.json, manifest.json (with sha256), and an installer in the layout above
python3 -m http.server 8765 -d /tmp/update-feed &
CI_HUB_UPDATE_BASE_URL=http://127.0.0.1:8765 ./target/debug/ci-os-hub-desktop update
```

Release builds ignore `CI_HUB_UPDATE_BASE_URL` entirely (compiled out via
`debug_assertions`) and use the compile-time CDN for the build environment
(`https://dl.ci.computer` for production, `https://dl-dev.ci.computer` for dev).
