# Windows Automation Guide

## Overview

CI OS Hub Desktop provides automated installation and configuration of all required Windows dependencies, including WSL2, Docker Desktop, and Python 3.12.x. This eliminates manual setup and ensures optimal configuration.

## Automated Components

### WSL2 (Windows Subsystem for Linux)

The application automatically installs and configures WSL2, which provides a Linux environment for running CI OS Hub.

**What Gets Installed:**
- Windows Subsystem for Linux feature
- Virtual Machine Platform feature
- WSL2 kernel update
- Ubuntu 22.04 LTS distribution

**Installation Process:**
1. Enables required Windows features
2. Downloads and installs WSL2 kernel
3. Sets WSL2 as default version
4. Installs Ubuntu 22.04 from Microsoft Store
5. Configures Ubuntu environment

**Time Required:** 5-10 minutes (plus restart if needed)

### Docker Desktop

Docker Desktop with WSL2 backend provides container support for CI OS Hub.

**What Gets Installed:**
- Docker Desktop for Windows
- Docker Engine
- Docker Compose
- WSL2 integration

**Installation Process:**
1. Downloads Docker Desktop installer
2. Runs silent installation
3. Configures WSL2 backend
4. Starts Docker daemon
5. Verifies Docker is working

**Time Required:** 5-10 minutes

### Python Environment

Python 3.12.x is installed in WSL2 with an isolated virtual environment.

**What Gets Installed:**
- Python 3.12.x from deadsnakes PPA
- python3.12-venv (virtual environment support)
- python3.12-dev (development headers)
- pip (package manager)
- Virtual environment in `~/.ci-hub-venv`

**Installation Process:**
1. Adds deadsnakes PPA to Ubuntu
2. Updates package lists
3. Installs Python 3.12.x and dependencies
4. Creates isolated virtual environment
5. Upgrades pip and essential packages

**Time Required:** 3-5 minutes

## Manual Usage

While automation is recommended, you can also trigger installation steps manually via the API.

### System Detection

Check what's already installed:

```typescript
import { invoke } from '@tauri-apps/api/core';

// Check system requirements
const systemInfo = await invoke('check_system_requirements');
console.log('Meets requirements:', systemInfo.meets_requirements);
console.log('Warnings:', systemInfo.warnings);

// Check WSL2 status
const wsl2Status = await invoke('check_wsl2_installed');
console.log('WSL2 installed:', wsl2Status.installed);
console.log('WSL2 version:', wsl2Status.version);

// Check Docker status
const dockerStatus = await invoke('check_docker_installed');
console.log('Docker installed:', dockerStatus.installed);
```

### Installation

Trigger installations programmatically:

```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Listen for progress updates
const unlisten = await listen('install-progress', (event) => {
  console.log(event.payload.step);
  console.log(`Progress: ${event.payload.progress}%`);
  console.log(event.payload.message);
});

// Install WSL2
try {
  await invoke('install_wsl2');
  console.log('WSL2 installation complete');
} catch (error) {
  console.error('WSL2 installation failed:', error);
}

// Check if restart is required
const needsRestart = await invoke('check_wsl2_restart_required');
if (needsRestart) {
  // Prompt user to restart
}

// Configure Ubuntu after restart
await invoke('configure_wsl2_ubuntu');

// Install Docker Desktop
await invoke('install_docker_desktop');

// Start Docker
await invoke('start_docker_desktop');

// Install Python
await invoke('install_python_wsl2');
```

## Configuration

### WSL2 Configuration

After installation, you can configure WSL2:

```powershell
# Set default WSL distribution
wsl --set-default Ubuntu-22.04

# Configure WSL2 resources (create .wslconfig in %USERPROFILE%)
[wsl2]
memory=4GB
processors=2
swap=2GB
localhostForwarding=true
```

### Docker Desktop Configuration

Docker Desktop settings are automatically configured for WSL2 backend:

```json
{
  "wslEngineEnabled": true,
  "useWsl2": true
}
```

Settings location: `%APPDATA%\Docker\settings.json`

### Python Virtual Environment

Activate the virtual environment:

```bash
# In WSL2
source ~/.ci-hub-venv/bin/activate

# Check Python version
python --version  # Should show Python 3.12.x

# Install additional packages if needed
pip install package-name
```

## Troubleshooting

### WSL2 Installation Issues

**Issue**: "WSL 2 requires an update to its kernel component"

**Solution**:
1. Download WSL2 kernel update from [Microsoft](https://aka.ms/wsl2kernel)
2. Install the update manually
3. Retry WSL2 installation

**Issue**: "Virtualization is not enabled"

**Solution**:
1. Restart computer and enter BIOS/UEFI (F2, F10, or DEL during boot)
2. Find "Virtualization Technology" or "Intel VT-x" / "AMD-V"
3. Enable the setting
4. Save and restart

**Issue**: WSL2 installation requires restart

**Solution**:
1. Save your work
2. Restart Windows
3. Re-launch CI OS Hub Desktop
4. Installation will continue automatically

### Docker Desktop Issues

**Issue**: Docker daemon not starting

**Solution**:
```powershell
# Check Docker status
docker ps

# Restart Docker Desktop
Stop-Process -Name "Docker Desktop"
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"

# Wait for Docker to start (can take 1-2 minutes)
```

**Issue**: Docker requires WSL2 backend

**Solution**:
1. Ensure WSL2 is installed
2. Open Docker Desktop settings
3. Go to General
4. Check "Use the WSL 2 based engine"
5. Apply & Restart

### Python Issues

**Issue**: Python 3.12 not found

**Solution**:
```bash
# In WSL2
sudo add-apt-repository ppa:deadsnakes/ppa
sudo apt-get update
sudo apt-get install python3.12
```

**Issue**: Virtual environment not activating

**Solution**:
```bash
# Recreate virtual environment
rm -rf ~/.ci-hub-venv
python3.12 -m venv ~/.ci-hub-venv
source ~/.ci-hub-venv/bin/activate
```

## Verification

After installation, verify everything is working:

```powershell
# Check WSL2
wsl --status

# Check Ubuntu
wsl -d Ubuntu-22.04 -- cat /etc/os-release

# Check Docker
docker --version
docker ps

# Check Python in WSL2
wsl -d Ubuntu-22.04 -- python3.12 --version
wsl -d Ubuntu-22.04 -- bash -c "source ~/.ci-hub-venv/bin/activate && python --version"
```

## Next Steps

- [Installation Guide](./installation.md) - Main installation guide
- [System Requirements](./requirements.md) - System requirements
- [API Reference](./api-reference.md) - API documentation
- [Troubleshooting](./troubleshooting.md) - More troubleshooting tips
