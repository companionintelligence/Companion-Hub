# Companion Hub — Distribution Channels

> **Note (2026):** Winget, Chocolatey, AUR, Snap, and Nix manifests under this directory target **v0.2.4** and are maintained manually. Homebrew and Scoop are actively published via `scripts/publish-package-managers.sh`. Stale third-party manifests are kept for reference until refreshed with `scripts/update-package-manifests.sh`.

This directory contains package manifests and formulas for distributing **Companion Hub v0.2.4** across all major desktop package managers.

---

## Channel Overview

| Channel | Platform | File(s) | Submission URL | Account Required | Status |
|---------|----------|---------|----------------|-----------------|--------|
| Homebrew Cask | macOS | `homebrew/companion-hub.rb` | [companionintelligence/homebrew-tap](https://github.com/companionintelligence/homebrew-tap) | GitHub | **Published** — `brew tap companionintelligence/homebrew-tap` |
| Winget | Windows | `winget/manifests/...` | <https://github.com/microsoft/winget-pkgs> | GitHub | Manual PR |
| Scoop | Windows | `scoop/companion-hub.json` | [companionintelligence/scoop-bucket](https://github.com/companionintelligence/scoop-bucket) | GitHub | **Published** — add bucket then `scoop install companion-hub` |
| AUR (Arch) | Linux | `aur/PKGBUILD`, `aur/.SRCINFO` | <https://aur.archlinux.org/> | AUR account | Manual publish |
| Snap | Linux | `../snap/snapcraft.yaml` | <https://snapcraft.io/snaps> | Ubuntu One | `snapcraft push` |
| Chocolatey | Windows | `chocolatey/companion-hub.nuspec` + `tools/` | <https://push.chocolatey.org/> | Chocolatey.org | `choco push` |
| Nix | Linux | `nix/default.nix` | <https://github.com/NixOS/nixpkgs> or own overlay | GitHub | Manual PR |

---

## Release Checklist (per release)

For every new version, you must update the following in **all** manifests:

### 1. Version numbers

Replace the old version string everywhere it appears, or run:

```bash
./distribution/scripts/update-package-manifests.sh vX.Y.Z
./distribution/scripts/publish-package-managers.sh "companion-hub vX.Y.Z"
```

The update script downloads release assets, computes SHA256 hashes, and refreshes `homebrew/companion-hub.rb`, `scoop/companion-hub.json`, and the `publish/` copies. The publish script pushes to [homebrew-tap](https://github.com/companionintelligence/homebrew-tap) and [scoop-bucket](https://github.com/companionintelligence/scoop-bucket).

Production desktop releases run this automatically via `.github/workflows/publish-package-managers.yml`.

#### CI secret: `CI_PACKAGE_MANAGERS_TOKEN`

Store this in the **CI-Hub → Settings → Environments → production** environment (not repo-level).

The token must be able to **push** to:

- `companionintelligence/homebrew-tap`
- `companionintelligence/scoop-bucket`

Use a **machine/bot account** or dedicated fine-grained PAT with **Contents: Read and write** on both repos. Do not reuse a personal PAT unless that user is an admin on both repos. If the org enforces **SAML SSO**, authorize the PAT for the `companionintelligence` org after creating it.

The publish script verifies push access before cloning and uses the PAT directly in git remote URLs (the default `GITHUB_TOKEN` only has access to CI-Hub itself).

### 2. SHA256 hashes (manual fallback)

**Every manifest requires real SHA256 hashes before submission.** Placeholders are marked as:

- `PLACEHOLDER_SHA256_*` (Winget, Scoop, Chocolatey)
- `# TODO: sha256 of release asset` (Homebrew)
- `SKIP` (AUR — replace with real hash for final AUR submission)
- `sha256-PLACEHOLDER_SHA256_APPIMAGE_AMD64=` (Nix — base64-encoded)

#### How to get hashes

```bash
# For a file URL, e.g. the macOS Intel DMG:
curl -sL https://github.com/companionintelligence/CI-Hub/releases/download/v0.2.4/Companion.Hub_0.2.4_x64.dmg | sha256sum

# Or download first, then hash:
curl -LO https://github.com/companionintelligence/CI-Hub/releases/download/v0.2.4/Companion.Hub_0.2.4_x64.dmg
sha256sum Companion.Hub_0.2.4_x64.dmg

# For Nix (requires base64-encoded sha256):
nix-prefetch-url https://github.com/companionintelligence/CI-Hub/releases/download/v0.2.4/Companion.Hub_0.2.4_amd64.AppImage
```

#### Assets requiring SHA256

| Asset | Used by |
|-------|---------|
| `Companion.Hub_0.2.4_x64.dmg` | Homebrew (intel) |
| `Companion.Hub_0.2.4_aarch64.dmg` | Homebrew (arm) |
| `Companion.Hub_0.2.4_x64_en-US.msi` | Winget (MSI), Chocolatey |
| `Companion.Hub_0.2.4_x64-setup.exe` | Winget (NSIS exe), Scoop |
| `Companion.Hub_0.2.4_amd64.deb` | AUR (x86_64) |
| `Companion.Hub_0.2.4_arm64.deb` | AUR (aarch64) |
| `Companion.Hub_0.2.4_amd64.AppImage` | Snap, Nix |

---

## Channel-specific Notes

### Homebrew Cask

Our tap is published at [companionintelligence/homebrew-tap](https://github.com/companionintelligence/homebrew-tap):

```bash
brew tap companionintelligence/homebrew-tap
brew trust companionintelligence/homebrew-tap   # first time only
brew install --cask companion-hub
```

For an **official Homebrew** submission later, open a PR to <https://github.com/Homebrew/homebrew-cask>.

### Winget

- Fork <https://github.com/microsoft/winget-pkgs>, copy the `0.2.4/` directory into the right path, and open a PR.
- Winget validates manifests with `winget validate --manifest <path>`.

### Scoop

Published bucket: [companionintelligence/scoop-bucket](https://github.com/companionintelligence/scoop-bucket)

```powershell
scoop bucket add companionintelligence https://github.com/companionintelligence/scoop-bucket
scoop install companion-hub
```

### AUR (Arch Linux)

- Push `PKGBUILD` and `.SRCINFO` to the AUR package `companion-hub-bin` via SSH (requires an AUR account at <https://aur.archlinux.org/>).
- Replace `SKIP` sha256sums with real values before publishing.
- Test locally: `makepkg -si` in the `distribution/aur/` directory.

### Snap

- `snap/snapcraft.yaml` uses `confinement: classic` because the app manages Docker Compose and needs access to system sockets.
- Build: `snapcraft` (requires `snapd` and `multipass` or LXD).
- Request and receive Snap Store approval for `classic` confinement before releasing to stable.
- Publish: `snapcraft push companion-hub_0.2.4_amd64.snap --release=stable` (requires Ubuntu One login at <https://snapcraft.io/>).

### Chocolatey

- `choco pack distribution/chocolatey/companion-hub.nuspec` → produces `companion-hub.0.2.4.nupkg`.
- Test locally: `choco install companion-hub -s .` in the package directory.
- Publish: `choco push companion-hub.0.2.4.nupkg --source https://push.chocolatey.org/ --api-key <key>`.
- Replace `PLACEHOLDER_SHA256_MSI` in `tools/chocolateyinstall.ps1` with the actual MSI sha256 before publishing.
- `tools/chocolateyuninstall.ps1` runs comprehensive uninstall cleanup, including Docker resources and Hub user state.

### Uninstall Cleanup Hooks

Companion Hub now ships best-effort uninstall cleanup hooks/scripts for maintained channels:

- Windows: Chocolatey + Scoop uninstaller scripts, **and both packaged installers — the NSIS `-setup.exe` and the WiX `.msi`** (covers WinGet, whose manifest installs one of those)
- Linux: Debian `postrm`, AUR `post_remove`, and Snap `hooks/remove`
- Shared script artifacts: `distribution/scripts/uninstall-cleanup.sh` and `distribution/scripts/uninstall-cleanup.ps1`

Linux desktop `.deb` bundles receive the `postrm` maintainer script in a post-build repack step via `packages/desktop/scripts/patch-deb-maintainer-scripts.sh`.

Both Windows packaged installers run the bundled cleanup script before removing the app. The script is shipped into the bundle as a Tauri resource (`resources/uninstall-cleanup.ps1`), sourced directly from `distribution/scripts/uninstall-cleanup.ps1`.

- **NSIS `-setup.exe`** — `packages/desktop/src-tauri/windows/installer-hooks.nsh` defines an `NSIS_HOOK_PREUNINSTALL` macro (wired through `bundle.windows.nsis.installerHooks`) that runs the script before `$INSTDIR` is removed.
- **WiX `.msi`** — `packages/desktop/src-tauri/windows/cleanup-on-uninstall.wxs` adds a custom action (wired through `bundle.windows.wix.fragmentPaths` + `componentGroupRefs`) sequenced `Before="RemoveFiles"` and conditioned on `(REMOVE="ALL") AND (NOT UPGRADINGPRODUCTCODE)`.

The NSIS hook closes the app first if it is running, with the same prompt Tauri's template shows. The template's own check only comes after the hook, and an open app put back part of what the cleanup had just deleted.

Unlike Scoop, both only run on a real uninstall — in-place updates reuse the install (NSIS, and the hook also skips cleanup when the uninstaller is launched with `/UPDATE`) or set `UPGRADINGPRODUCTCODE` during the major-upgrade removal pass (MSI), so they perform the **full purge** (volumes and images included) only on a genuine removal. WinGet inherits whichever of the two its manifest installs. Running a newer interactive `-setup.exe` and keeping its default "Uninstall before installing" choice is a genuine removal and purges too.

**Uninstall is a full purge, not a `remove`.** Cleanup deletes Hub-related state in user
config/cache/data directories **and the Hub Docker data volumes** (`ci_hub_pgdata`,
`ci_hub_app_data`, `hub_tailscale_state`) — i.e. the database and all app data. This is
intentional ([#566](https://github.com/companionintelligence/CI-Hub/issues/566)); there is
no `remove`-vs-`purge` distinction and no confirmation prompt. Users must back up before
uninstalling.

On Windows, `uninstall-cleanup.ps1` also removes every network and volume labelled with the
Hub's compose project (`ci-hub_edge` and `ci-hub_internal` included), and every app network
once the `ci-hub` container that joins them is gone. It removes containers with
`docker rm -f -v` and then any anonymous volume they mounted that is still there: when Compose
recreates a container it mounts the old anonymous volume by name, and `rm -v` keeps those. It
takes the `Companion Hub\bin` folder off the user PATH, and deletes the
`CompanionHub-WSL-Docker.vbs` logon script that keeps the Docker Engine's WSL2 distro running. Run it with `-DryRun` to list what it would remove
without removing anything. It must work under Windows PowerShell 5.1, which the installers
use: keep double quotes out of any `--format` template it passes to docker, because 5.1
drops them.

**The Cloudflare tunnel token is removed too.** The desktop keeps it in a folder named
`tunnel` *beside* its data folder (`~/.local/share/tunnel`, `%APPDATA%\tunnel`,
`~/Library/Application Support/tunnel`; compose mounts `${ROOT_FOLDER_HOST}/../tunnel`), so
deleting the named Hub folders alone left it behind and a reinstall reconnected the old
tunnel before pairing. Because `tunnel` is a generic name, the Linux and Windows cleanups
delete `token` only when it decodes as a cloudflared tunnel token, `registration.json` /
`leftover.json` only when they carry a `tunnelId`, and `.user-cleared-token`; they remove
`certs/` and the folder itself only when empty, never follow a symlinked folder, and leave
every other file alone. The Homebrew cask's `zap` trashes those same files by name and
removes the folder only when empty. Plain `brew uninstall` (without `--zap`) and dragging
the app to the Trash run no cleanup at all.

**Installed marketplace apps are torn down too** ([#745](https://github.com/companionintelligence/CI-Hub/issues/745)).
Each app Hub installs runs as its own Compose project (`<app>_<store>`) rather than as part
of the Hub stack, so the uninstallers discover them via the `ci-os-hub.managed=true` label
that Hub stamps on every managed app container (store-agnostic) and remove each app's
containers, networks, and volumes. Without this, app containers such as
`ci-hermes_ci-marketplace-…` keep running after Hub is gone.

**Docker images are removed too**, for both the Hub stack and every managed app. Image IDs
are snapshotted from each project's containers (plus compose-labeled built images) *before*
the containers are removed, then force-removed best-effort — an image still referenced by a
surviving non-Hub container is skipped. The Scoop uninstaller is the exception: it leaves
images (and volumes) in place since `scoop update` re-runs it and re-pulling images on every
update would be needlessly slow.

Upgrades never trigger this purge: the deb `postrm` skips the `upgrade` lifecycle, the rpm
`postun` skips when an instance remains, and AUR/snap run cleanup only on true removal.
Scoop is the exception — because `scoop update` also runs the uninstaller, the Scoop
uninstaller removes only containers/networks and preserves data; a full Scoop purge requires
running `uninstall-cleanup.ps1` manually after `scoop uninstall`.

### Nix

- The `distribution/nix/default.nix` is a standalone derivation. For **nixpkgs** submission, adapt to the nixpkgs package format and open a PR to <https://github.com/NixOS/nixpkgs>.
- For a **personal overlay**, import via `callPackage ./distribution/nix/default.nix {}`.
- Replace the Nix-format sha256 placeholder with the output of `nix-prefetch-url <appimage-url>`.

---

## Deep-link Scheme

All installers should register the `cihub://` URL scheme. The app bundle ID is `computer.ci.app.hub`.

---

## Asset Base URL

All release assets are downloaded from:

```
https://github.com/companionintelligence/CI-Hub/releases/download/v{version}/
```

See the [releases page](https://github.com/companionintelligence/CI-Hub/releases) for the full list of artifacts per release.

---

## Release Validation (Uninstall)

For every release, validate uninstall behavior on at least one machine per OS:

1. Install package and launch Hub once.
2. Create known test state (config + cache + Docker volume).
3. Uninstall package via target channel.
4. Verify Hub state and related Docker resources are removed.
5. Reinstall and verify clean startup.
