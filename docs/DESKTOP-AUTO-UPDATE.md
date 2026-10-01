# Desktop Auto-Update


How the Companion Hub desktop app updates itself, and how to QA it.

## Architecture

The desktop app uses a custom updater (`packages/desktop/src-tauri/src/updater.rs`),
not `tauri-plugin-updater`. It ships full installers from the production CDN and
verifies them by size + SHA-256 from the release manifest. The host listener binds
`0.0.0.0:17400` (token-authed) so the Hub container can reach it at
`host.docker.internal:17400`.

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
| Settings UI (any browser) | backend `POST /api/system/update` — Hub probes `host.docker.internal:17400/health`, then `POST /update` with the listener token. The tab never talks to `127.0.0.1:17400`. If the listener is down, Hub updates the stack only and Settings tells the operator to start Companion Hub on the host. |
| CLI | `companion-hub update` (`--check` for exit-code-only: 1 = update available) |
| Hub Docker stack (separate from app binary) | backend `SystemUpdateService` daily timer, gated by the Settings auto-update toggle; only a release-pinned node moves (see [`hub-stack-self-update.md`](hub-stack-self-update.md)). It never calls the listener. |

The desktop **app binary** is never updated without a user action; the **stack
images** auto-update daily when the toggle is on. The daily timer updates the
stack image only, even when the listener is running: the installer can ask for
the computer's password, and nobody may be there to type it. Settings offers
the desktop app update to a person instead. The Hub log says
`Auto-update: updating the Hub image only` when the timer starts an update.

### The listener token

The listener accepts a request only with the token in `state/update-listener.token`
under the Hub data folder, for example `~/.local/share/companion-hub/state/update-listener.token`
on Linux. The Hub container mounts `state/` at `/data/state` and reads the token there.

- **A new token on every start.** The listener writes a new token, owner-only, each time it
  starts. The Hub sends the token to whatever answers on port 17400, so a token that was
  read, or caught while no listener was running, stops working at the next start.
- **Only a private file counts.** The listener checks requests against the file only while it
  is the desktop user's own regular file that nobody else can read or write. A permission
  repair can leave `state/` open to every local user, so a file there that isn't private may
  have been planted or read. The Docker permission repair, in the desktop app and in `cihub`,
  leaves the token as it is.
- **The Hub keeps it to itself.** The Hub reads the token only to call the listener, and no
  API returns it. It doesn't follow a symlink in the token's place, and it sends nothing but
  one printable word.
- **Older desktop builds** wrote the token at the root of the data folder. The Hub
  container doesn't mount the root, so the Hub never found the token, and Settings said
  the desktop app wasn't running while it was.
- **Upgrading the desktop app.** A listener that an older build started keeps port 17400
  until it exits, and it checks each request against the file at the root. Where that file
  exists, a newer listener writes the same token there too, so the Hub reaches whichever
  listener is running.
- **The listener moves onto a new version.** The listener outlives the app. Every 30 seconds
  it checks whether an update replaced its program. If one did, it starts the new program in
  its own place, between requests: same process, and a new token. Listeners from older builds
  don't do this. On Linux, the app stops any of them still running a replaced program when it
  starts.
- **The Hub's fallback.** When `state/` has no token, the Hub reads the file at the root.
  Only a Hub that runs on the host, outside Docker, can see that file.
- **Both halves.** A Hub in a container finds the token only when the desktop app writes
  it to `state/` and the Hub image reads it there. With either one older, Settings still
  says the desktop app isn't running.

### The CLI is on this channel, not the stack's

`cihub` ships *inside* the desktop package, so `companion-hub update` replaces the app and its
bundled CLI together — and rolling the stack image never touches either. Installs that did not come
from the desktop app have their own command: `brew upgrade --cask companion-hub`,
`scoop update companion-hub`, or, for the standalone `cihub-<os>-<arch>` release asset a headless
appliance gets from `cihub fleet install`, `cihub self-update`.

`cihub update` opens by naming this CLI's version and the running stack's, and when no
`companion-hub` binary is present — the normal case on an appliance — it names the command for the
channel this `cihub` actually came from instead of telling the operator to install a desktop app.
See [Keeping the CLI and the stack together](CLI.md#keeping-the-cli-and-the-stack-together).

### Install flow (per platform)

- **macOS** — mount DMG, `ditto` the `.app` over the install target, relaunch.
- **Windows** — a detached helper script waits for the app to exit, runs
  `msiexec /qn` (or NSIS `/S`), relaunches, and cleans up. The app exits as soon
  as the helper is spawned: a Windows installer cannot replace a running binary.
- **Linux** — `pkexec dpkg -i` / `pkexec rpm -U`, or AppImage replacement. The
  AppImage target comes from `$APPIMAGE` (set by the AppImage runtime); the old
  file is unlinked before copying to avoid `ETXTBSY`.

The Hub keeps running while the update downloads and installs. It stops only
when the app is about to hand over to the new version:

- **Linux and macOS.** Replacing the app on disk doesn't touch the Hub's
  containers. Once the install succeeds, the updater clears the user-stopped
  marker and the config hash, stops the Hub stack, and relaunches, so the new
  app re-pulls images and recreates the containers. If the download, the
  checksum, or the install fails, for example because nobody entered the
  password, the Hub was never stopped. If the relaunch fails, the updater starts
  the Hub again.
- **Windows.** The installer runs only after the app exits, so the updater stops
  the stack right before it hands over to the installer. If the stop or the
  hand-over fails, it starts the Hub again.

The desktop log records each failed update under `hub.update`, and says whether
the Hub kept running or was started again.

If the app is still running when an update lands from the listener (browser
trigger), the freshly-started new instance signals the old one through the
single-instance plugin (`--relaunch-after-update`); the old instance restarts
itself onto the new binary.

### Updates installed outside the app

A package installed by hand (`sudo dpkg -i …`, a new `.app` copied into Applications, a new
AppImage) replaces the program file, but the open app keeps running the old one. The app
remembers the file it started from. When that file changes, it asks the new file for its
version (`--version`, which exits before any window opens). Then:

- **Settings → System → Desktop app** says "Companion Hub X is installed, but this window is
  still running Y", with a **Restart Companion Hub** button. The window also shows a one-time
  notice with **Restart now**.
- **Starting a second copy** (from a terminal, or a launcher that starts one) restarts the open
  app onto the new version. A deep-link launch is handled by the open app as usual. GNOME and
  macOS bring the open window forward instead of starting a copy, so there the notice and the
  Settings button are the way.
- **The restart is always back into the desktop app**, never a headless `--detached` start, and
  it waits while the app itself is installing an update (that relaunches by itself).
- **Restarts start the program's real path.** Once the file is replaced, Linux reports the
  running program as `/usr/bin/companion-hub (deleted)`, which can't be started. `$APPIMAGE`
  counts only when the app runs from inside that AppImage (`$APPDIR`), because the variable is
  inherited by anything started from another AppImage's terminal.

The Hub stack keeps running through the restart. The new app recreates it only if its bundled
setup changed.

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
