# Installation Guide

## Overview

This guide walks through installing CI OS Hub Desktop on Windows, macOS, or Linux.

## System Requirements

Before installation, ensure your system meets the [minimum requirements](./requirements.md).

## Installation Methods

### Windows

#### Method 1: MSI Installer (Recommended)

1. Download `CI-OS-Hub-Desktop-Setup.msi` from [ci.computer/install](https://ci.computer/install)
2. Double-click the downloaded file
3. Follow the installation wizard
4. Launch "CI OS Hub" from the Start Menu

#### Method 2: Standalone Executable

1. Download `CI-OS-Hub-Desktop.exe`
2. Run the executable
3. The application will run without installation

**Initial Setup:**
- The app will detect if WSL2 is needed and offer to install it
- Administrator permissions will be requested for system setup
- A restart may be required after enabling Windows features

### macOS

#### Method 1: DMG Image (Recommended)

1. Download `CI-OS-Hub-Desktop.dmg` from [ci.computer/install](https://ci.computer/install)
2. Open the DMG file
3. Drag "CI OS Hub" to the Applications folder
4. Launch from Applications or Spotlight

#### Method 2: Homebrew Cask

```bash
brew install --cask ci-os-hub
```

**Initial Setup:**
- The app will check for Xcode Command Line Tools
- Homebrew will be installed if not present
- You may be prompted for your password to install dependencies

### Linux

#### Method 1: AppImage (Universal)

1. Download `CI-OS-Hub-Desktop.AppImage`
2. Make it executable:
   ```bash
   chmod +x CI-OS-Hub-Desktop.AppImage
   ```
3. Run the AppImage:
   ```bash
   ./CI-OS-Hub-Desktop.AppImage
   ```

#### Method 2: Debian/Ubuntu (.deb)

```bash
# Download the .deb package
wget https://releases.ci.computer/desktop/linux/CI-OS-Hub-Desktop.deb

# Install
sudo dpkg -i CI-OS-Hub-Desktop.deb

# Install dependencies if needed
sudo apt-get install -f
```

## Automated Dependency Installation

### First Launch

On first launch, the desktop application will:

1. **System Check**: Analyze your system configuration
2. **Prerequisite Detection**: Check for required software
3. **Installation Wizard**: Guide you through automated setup
4. **Progress Tracking**: Show real-time installation progress

### What Gets Installed

#### Windows
- Windows Subsystem for Linux (WSL2)
- Ubuntu 22.04 LTS
- Docker Desktop with WSL2 backend
- Python 3.12.1 in virtual environment

#### macOS
- Homebrew package manager
- Lima virtualization framework
- Colima container runtime
- Docker CLI and Docker Compose
- Headless Python 3.12.1

#### Linux
- Docker (if not present)
- Docker Compose
- Python 3.12.1

## Post-Installation

### First Access

After installation completes:

1. The application will launch automatically
2. Access via system tray icon or desktop shortcut
3. Default credentials: `admin` / `admin` (change immediately)
4. Web interface also available at `http://localhost`

### Configuration

Initial configuration settings:

- **Port**: 80 (customizable in Settings)
- **Storage**: 
  - Windows: `%APPDATA%\computer.ci.app\hub`
  - macOS: `~/Library/Application Support/computer.ci.app/hub`
  - Linux: `~/.local/share/computer.ci.app/hub`

### Verification

Verify installation:

```bash
# Check Docker is running
docker ps

# Check Python environment
python3.12 --version

# Access web interface
curl http://localhost/api/health
```

## Updating

The desktop application includes automatic updates:

1. Updates check on launch
2. Notification when update available
3. One-click update installation
4. Automatic backup before update

To manually check for updates:
- **Windows/Linux**: Help → Check for Updates
- **macOS**: CI OS Hub → Check for Updates

## Uninstallation

### Windows

1. Settings → Apps → CI OS Hub → Uninstall
2. Or run the uninstaller from Start Menu

Optional cleanup:
```powershell
# Remove application data
Remove-Item -Recurse "$env:APPDATA\computer.ci.app"

# Remove WSL2 (if desired)
wsl --unregister Ubuntu-22.04
```

### macOS

1. Drag "CI OS Hub" from Applications to Trash
2. Empty Trash

Optional cleanup:
```bash
# Remove application data
rm -rf ~/Library/Application\ Support/computer.ci.app

# Remove Colima (if desired)
colima delete
brew uninstall colima lima docker
```

### Linux

```bash
# For .deb package
sudo apt-get remove ci-os-hub-desktop

# For AppImage, just delete the file
rm CI-OS-Hub-Desktop.AppImage

# Remove application data
rm -rf ~/.local/share/computer.ci.app
```

## Troubleshooting

See the [Troubleshooting Guide](./troubleshooting.md) for common issues and solutions.

## Next Steps

- [System Requirements](./requirements.md) - Detailed system requirements
- [Windows Automation](./windows-automation.md) - Windows-specific features
- [macOS Automation](./macos-automation.md) - macOS-specific features
- [API Reference](./api-reference.md) - Developer documentation
