# Companion Hub — Distribution Channels

This directory contains package manifests and formulas for distributing **Companion Hub v0.2.4** across all major desktop package managers.

---

## Channel Overview

| Channel | Platform | File(s) | Submission URL | Account Required | Status |
|---------|----------|---------|----------------|-----------------|--------|
| Homebrew Cask | macOS | `homebrew/companion-hub.rb` | https://github.com/Homebrew/homebrew-cask or own tap `companionintelligence/homebrew-tap` | GitHub | Manual PR |
| Winget | Windows | `winget/manifests/c/CompanionIntelligence/CompanionHub/0.2.4/` | https://github.com/microsoft/winget-pkgs | GitHub | Manual PR |
| Scoop | Windows | `scoop/companion-hub.json` | Own bucket: `companionintelligence/scoop-bucket` or submit to https://github.com/ScoopInstaller/Extras | GitHub | Manual PR |
| AUR (Arch) | Linux | `aur/PKGBUILD`, `aur/.SRCINFO` | https://aur.archlinux.org/ | AUR account | Manual publish |
| Snap | Linux | `../snap/snapcraft.yaml` | https://snapcraft.io/snaps | Ubuntu One | `snapcraft push` |
| Chocolatey | Windows | `chocolatey/companion-hub.nuspec` + `tools/` | https://push.chocolatey.org/ | Chocolatey.org | `choco push` |
| Nix | Linux | `nix/default.nix` | https://github.com/NixOS/nixpkgs or own overlay | GitHub | Manual PR |

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

- For an **official Homebrew** submission, open a PR to https://github.com/Homebrew/homebrew-cask following their [contribution guide](https://github.com/Homebrew/homebrew-cask/blob/master/CONTRIBUTING.md).
- Alternatively, maintain a **private tap**: `brew tap companionintelligence/tap https://github.com/companionintelligence/homebrew-tap` then `brew install --cask companionintelligence/tap/companion-hub`.

### Winget

- Fork https://github.com/microsoft/winget-pkgs, copy the `0.2.4/` directory into the right path, and open a PR.
- The `ProductCode` GUID in the installer manifest should be updated to match the actual MSI ProductCode (use `msiinfo export <file>.msi Property | grep ProductCode`).
- Winget validates manifests with `winget validate --manifest <path>`.

### Scoop

- Host a bucket repo at `companionintelligence/scoop-bucket`. Users add it with:
  ```
  scoop bucket add companionintelligence https://github.com/companionintelligence/scoop-bucket
  scoop install companion-hub
  ```
- Remove the comment block at the top of `companion-hub.json` before publishing (Scoop JSON does not allow comments).

### AUR (Arch Linux)

- Push `PKGBUILD` and `.SRCINFO` to the AUR package `companion-hub-bin` via SSH (requires an AUR account at https://aur.archlinux.org/).
- Replace `SKIP` sha256sums with real values before publishing.
- Test locally: `makepkg -si` in the `distribution/aur/` directory.

### Snap

- `snap/snapcraft.yaml` uses `confinement: classic` because the app manages Docker Compose and needs access to system sockets.
- Build: `snapcraft` (requires `snapd` and `multipass` or LXD).
- Publish: `snapcraft push companion-hub_0.2.4_amd64.snap --release=stable` (requires Ubuntu One login at https://snapcraft.io/).

### Chocolatey

- `choco pack distribution/chocolatey/companion-hub.nuspec` → produces `companion-hub.0.2.4.nupkg`.
- Test locally: `choco install companion-hub -s .` in the package directory.
- Publish: `choco push companion-hub.0.2.4.nupkg --source https://push.chocolatey.org/ --api-key <key>`.
- Replace `PLACEHOLDER_SHA256_MSI` in `tools/chocolateyinstall.ps1` with the actual MSI sha256 before publishing.

### Nix

- The `distribution/nix/default.nix` is a standalone derivation. For **nixpkgs** submission, adapt to the nixpkgs package format and open a PR to https://github.com/NixOS/nixpkgs.
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