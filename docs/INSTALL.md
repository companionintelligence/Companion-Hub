# Install Companion Hub

Companion Hub runs on your own machine and manages the apps you install on it. This page covers installing it on macOS, Windows and Linux, and running it headless on a server.

## Before you start

Every install needs **Docker**. Hub runs its services as containers.

| Platform | Docker | Other |
|---|---|---|
| macOS 11.0 or later | [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) | Apple silicon or Intel |
| Windows 10 or later (x64 or ARM64) | [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) with the WSL 2 backend | WebView2 runtime (ships with Windows 11) |
| Linux (x64 or ARM64) | [Docker Engine](https://docs.docker.com/engine/install/) | Desktop app: WebKitGTK 4.1 |

[Ollama](https://ollama.com/download) is optional. Install it if you want to run local models on this machine. See the [system requirements](https://docs.ci.computer/docs/getting-started/system-requirements) for hardware sizing.

Make sure Docker is running before you open Hub.

## Get Companion Hub

You can use either a package manager or a download from the release page. Both give you the same app.

### From a package manager

**macOS (Homebrew)**

```bash
brew tap companionintelligence/homebrew-tap
brew trust companionintelligence/homebrew-tap   # first time only, on recent Homebrew
brew install --cask companion-hub
```

**Windows (Scoop)**

```powershell
scoop bucket add companionintelligence https://github.com/companionintelligence/scoop-bucket
scoop install companion-hub
```

### From a release download

Open the [latest release](https://github.com/companionintelligence/CI-Hub/releases/latest) and pick the file for your system:

| System | File |
|---|---|
| macOS, Apple silicon | `Companion.Hub_<version>_aarch64.dmg` |
| macOS, Intel | `Companion.Hub_<version>_x64.dmg` |
| Windows, x64 | `Companion.Hub_<version>_x64-setup.exe` or `Companion.Hub_<version>_x64_en-US.msi` |
| Windows, ARM64 | `Companion.Hub_<version>_arm64-setup.exe` or `Companion.Hub_<version>_arm64_en-US.msi` |
| Debian or Ubuntu, x64 | `Companion.Hub_<version>_amd64.deb` |
| Debian or Ubuntu, ARM64 | `Companion.Hub_<version>_arm64.deb` |
| Fedora or RHEL, x64 | `Companion.Hub-<version>-1.x86_64.rpm` |
| Fedora or RHEL, ARM64 | `Companion.Hub-<version>-1.aarch64.rpm` |

The release also includes standalone `cihub` command-line binaries (`cihub-linux-x64`, `cihub-macos-arm64`, `cihub-windows-x64.exe` and so on) if you only want the CLI.

### Verify the download

Each release includes a `SHA256SUMS` file with the SHA-256 of every file. Hash the file you downloaded and check it against its line before you install:

```bash
shasum -a 256 Companion.Hub_*.dmg     # macOS
sha256sum Companion.Hub_*.deb         # Linux
```

```powershell
Get-FileHash .\Companion.Hub_x64-setup.exe -Algorithm SHA256   # Windows
```

If the hash does not match the line in `SHA256SUMS`, do not install the file. Download it again from the release page.

## Install on macOS

1. Install with Homebrew, or open the `.dmg` and drag Companion Hub to **Applications**.
2. Open Companion Hub. The setup wizard runs on first launch, starts the Docker stack and opens the dashboard at `http://localhost:5002`.

## Install on Windows

1. Install with Scoop, or run the `-setup.exe` (or the `.msi` for managed installs).
2. Start Docker Desktop and wait until it reports that it is running.
3. Open Companion Hub from the Start menu. The setup wizard runs on first launch and opens the dashboard at `http://localhost:5002`.

## Install on Linux (desktop)

1. Install Docker Engine if it is not already installed, and add your user to the `docker` group.
2. Install the package for your distribution:

   ```bash
   sudo apt install ./Companion.Hub_*_amd64.deb     # Debian or Ubuntu
   sudo dnf install ./Companion.Hub-*.x86_64.rpm    # Fedora or RHEL
   ```

3. Open Companion Hub from your application menu. The dashboard is at `http://localhost:5002`.

## Install on a server (headless)

Use this on a Linux server or VPS with no screen. You need the same package as above, and Docker.

```bash
curl -fsSL https://get.docker.com | sh          # only if Docker is not installed
sudo dpkg -i Companion.Hub_*_amd64.deb          # or the .rpm, or the arm64 build
companion-hub --detached
```

Open `http://<server-ip>:5002` from another machine. On a public server, prefer a private network such as [Tailscale](https://docs.ci.computer/docs/networking/tailscale) or the [Cloudflare Gateway](https://docs.ci.computer/docs/networking/cloudflare-gateway) to opening the port to the internet.

## After you install

1. **Create your admin account.** See [first login](https://docs.ci.computer/docs/getting-started/first-login).
2. **Finish the onboarding wizard.** See the [onboarding wizard](https://docs.ci.computer/docs/getting-started/onboarding-wizard).
3. **Pair with your CI Account.** Pairing lets Hub install marketplace apps and reach paid entitlements. Use the onboarding screen or run `cihub register`. See [device pairing](https://docs.ci.computer/docs/portal/device-pairing). Until pairing completes, catalog and install calls can fail with `401`.

The full walkthrough is in [Installation](https://docs.ci.computer/docs/getting-started/installation). For a single page covering the first hour, see [Your first hour](https://docs.ci.computer/docs/getting-started/first-hour).

## Uninstall

- **macOS (Homebrew):** `brew uninstall --cask companion-hub`
- **Windows (Scoop):** `scoop uninstall companion-hub`
- **Other installs:** use the normal uninstall for your system. The uninstall cleanup notes are in [`distribution/README.md`](../distribution/README.md).

## Troubleshooting

- **The dashboard does not open.** Check that Docker is running, then start Hub again.- **Installs fail with `401`.** Pairing has not completed. See step 3 above.
- **Windows says WebView2 is missing.** Install the [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

For anything else, see [`docs/README.md`](README.md) for the documentation map.
