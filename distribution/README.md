# Companion Hub — Distribution Channels

This directory contains package manifests and formulas for distributing **Companion Hub v0.2.4** across all major desktop package managers.

---

## Channel Overview

| Channel | Platform | File(s) | Submission URL | Account Required | Status |
|---------|----------|---------|----------------|-----------------|--------|
| Homebrew Cask | macOS | `homebrew/companion-hub.rb` | <https://github.com/Homebrew/homebrew-cask> or own tap `companionintelligence/homebrew-tap` | GitHub | Manual PR |
| Winget | Windows | `winget/manifests/c/CompanionIntelligence/CompanionHub/0.2.4/` | <https://github.com/microsoft/winget-pkgs> | GitHub | Manual PR |
| Scoop | Windows | `scoop/companion-hub.json` | Own bucket: `companionintelligence/scoop-bucket` or submit to <https://github.com/ScoopInstaller/Extras> | GitHub | Manual PR |
| AUR (Arch) | Linux | `aur/PKGBUILD`, `aur/.SRCINFO` | <https://aur.archlinux.org/> | AUR account | Manual publish |
| Snap | Linux | `../snap/snapcraft.yaml` | <https://snapcraft.io/snaps> | Ubuntu One | `snapcraft push` |
| Chocolatey | Windows | `chocolatey/companion-hub.nuspec` + `tools/` | <https://push.chocolatey.org/> | Chocolatey.org | `choco push` |
| Nix | Linux | `nix/default.nix` | <https://github.com/NixOS/nixpkgs> or own overlay | GitHub | Manual PR |

---

## Release Checklist (per release)

For every new version, you must update the following in **all** manifests:

### 1. Version numbers

Replace the old version string (e.g. `0.2.4`) with the new version everywhere it appears.

### 2. SHA256 hashes

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

- For an **official Homebrew** submission, open a PR to <https://github.com/Homebrew/homebrew-cask> following their [contribution guide](https://github.com/Homebrew/homebrew-cask/blob/master/CONTRIBUTING.md).
- Alternatively, maintain a **private tap**: `brew tap companionintelligence/tap https://github.com/companionintelligence/homebrew-tap` then `brew install --cask companionintelligence/tap/companion-hub`.

### Winget

- Fork <https://github.com/microsoft/winget-pkgs>, copy the `0.2.4/` directory into the right path, and open a PR.
- Winget validates manifests with `winget validate --manifest <path>`.

### Scoop

- Host a bucket repo at `companionintelligence/scoop-bucket`. Users add it with:

  ```
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

- Windows: Chocolatey + Scoop uninstaller scripts
- Linux: Debian `postrm`, AUR `post_remove`, and Snap `hooks/remove`
- Shared script artifacts: `distribution/scripts/uninstall-cleanup.sh` and `distribution/scripts/uninstall-cleanup.ps1`

Linux desktop `.deb` bundles receive the `postrm` maintainer script in a post-build repack step via `packages/desktop/scripts/patch-deb-maintainer-scripts.sh`.

**Uninstall is a full purge, not a `remove`.** Cleanup deletes Hub-related state in user
config/cache/data directories **and the Hub Docker data volumes** (`ci_hub_pgdata`,
`ci_hub_app_data`, `hub_tailscale_state`) — i.e. the database and all app data. This is
intentional ([#566](https://github.com/companionintelligence/CI-Hub/issues/566)); there is
no `remove`-vs-`purge` distinction and no confirmation prompt. Users must back up before
uninstalling.

**Installed marketplace apps are torn down too** ([#745](https://github.com/companionintelligence/CI-Hub/issues/745)).
Each app Hub installs runs as its own Compose project (`<app>_<store>`) rather than as part
of the Hub stack, so the uninstallers discover them via the `ci-os-hub.managed=true` label
that Hub stamps on every managed app container (store-agnostic) and remove each app's
containers, networks, and volumes. Without this, app containers such as
`ci-hermes_ci-marketplace-…` keep running after Hub is gone.

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
