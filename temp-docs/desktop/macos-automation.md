# macOS Automation Guide

## Overview

CI OS Hub Desktop provides automated installation of all required macOS dependencies, including Homebrew, Colima, Docker tools, and Python 3.12.1. The system is optimized for both Intel and Apple Silicon Macs.

## Automated Components

### Homebrew

Homebrew is the package manager used to install other dependencies on macOS.

**What Gets Installed:**
- Homebrew package manager
- Shell profile configuration
- Architecture-specific paths (Intel vs Apple Silicon)

**Installation Process:**
1. Downloads Homebrew installation script
2. Runs interactive installation
3. Configures shell profile (.zprofile)
4. Adds Homebrew to PATH
5. Verifies installation

**Installation Paths:**
- **Intel Macs**: `/usr/local/bin/brew`
- **Apple Silicon**: `/opt/homebrew/bin/brew`

**Time Required:** 2-5 minutes

### Colima and Lima

Colima provides a lightweight container runtime using Lima virtualization, replacing Docker Desktop on macOS.

**What Gets Installed:**
- Lima (virtualization framework)
- Colima (container runtime)
- Docker CLI
- Docker Compose

**Installation Process:**
1. Installs Lima via Homebrew
2. Installs Colima via Homebrew
3. Installs Docker CLI tools
4. Installs Docker Compose
5. Starts Colima with optimized configuration

**Configuration:**
- CPU: Up to 4 cores (automatically adjusted)
- Memory: 4GB
- Disk: 60GB
- Runtime: Docker
- Architecture: Auto-detected (x86_64 or aarch64)

**Time Required:** 5-10 minutes

### Python Environment

Python 3.12.1 is installed in headless mode (no GUI dependencies) with an isolated virtual environment.

**What Gets Installed:**
- Python 3.12 from Homebrew
- Headless Python configuration
- Virtual environment in `~/.ci-hub-venv`
- pip and essential packages

**Installation Process:**
1. Installs Python@3.12 via Homebrew
2. Creates isolated virtual environment
3. Configures for headless operation
4. Upgrades pip and tools
5. Sets environment variables to prevent GUI dependencies

**Time Required:** 3-5 minutes

## Architecture Support

### Intel Macs (x86_64)

Full support for Intel-based Macs:
- Homebrew installs to `/usr/local`
- Colima runs x86_64 containers
- Native Python builds

### Apple Silicon (ARM64)

Optimized for M1/M2/M3 chips:
- Homebrew installs to `/opt/homebrew`
- Colima runs ARM64 containers natively
- Native ARM Python builds
- Rosetta 2 support for x86_64 containers

**Performance:** Apple Silicon Macs typically see 30-50% better performance than equivalent Intel Macs due to native ARM execution.

## Manual Usage

### System Detection

Check what's already installed:

```typescript
import { invoke } from '@tauri-apps/api/core';

// Check system requirements
const systemInfo = await invoke('check_system_requirements');
console.log('Architecture:', systemInfo.architecture);
console.log('Meets requirements:', systemInfo.meets_requirements);

// Check Xcode Tools
const xcodeStatus = await invoke('check_xcode_tools');
console.log('Xcode installed:', xcodeStatus.installed);

// Check Homebrew
const brewStatus = await invoke('check_homebrew');
console.log('Homebrew installed:', brewStatus.installed);

// Check Colima
const colimaStatus = await invoke('check_colima');
console.log('Colima running:', colimaStatus.installed);
```

### Installation

Trigger installations programmatically:

```typescript
import { invoke, listen } from '@tauri-apps/api';

// Listen for progress updates
const unlisten = await listen('install-progress', (event) => {
  console.log(event.payload.step);
  console.log(`Progress: ${event.payload.progress}%`);
  console.log(event.payload.message);
});

// Install Homebrew
try {
  await invoke('install_homebrew', { app });
  console.log('Homebrew installation complete');
} catch (error) {
  console.error('Homebrew installation failed:', error);
}

// Update Homebrew
await invoke('update_homebrew');

// Install Colima and Docker tools
await invoke('install_colima', { app });

// Start Colima
await invoke('start_colima', { app });

// Install Python
await invoke('install_python_macos', { app });

// Configure headless Python
await invoke('configure_headless_python');
```

## Configuration

### Colima Configuration

Colima can be configured via command line or config file:

```bash
# Start with custom resources
colima start --cpu 4 --memory 6 --disk 80

# Configuration file location
~/.colima/default/colima.yaml
```

Example configuration:
```yaml
cpu: 4
memory: 6
disk: 80
runtime: docker
kubernetes:
  enabled: false
```

### Docker Configuration

Docker environment is automatically configured when Colima starts:

```bash
# Verify Docker is working
docker ps

# Docker socket location
/var/run/docker.sock -> ~/.colima/default/docker.sock
```

### Python Virtual Environment

Activate the virtual environment:

```bash
# Activate
source ~/.ci-hub-venv/bin/activate

# Check Python version
python --version  # Should show Python 3.12.x

# Verify headless configuration
echo $MPLBACKEND  # Should show 'Agg'

# Install additional packages
pip install package-name
```

## Headless Python Configuration

The Python environment is configured to run without GUI dependencies:

**Environment Variables:**
- `MPLBACKEND=Agg` - Use non-interactive backend for matplotlib
- `DISPLAY=` - Disable X11 display

**Benefits:**
- Faster package installation (no GUI dependencies)
- Smaller installation size
- Suitable for server/background operation
- No accidental GUI popups

## Managing Services

### Colima Lifecycle

```bash
# Start Colima
colima start

# Stop Colima
colima stop

# Restart Colima
colima restart

# Check status
colima status

# View logs
colima logs

# Delete and recreate
colima delete
colima start
```

### Docker Operations

```bash
# List running containers
docker ps

# List all containers
docker ps -a

# Stop all containers
docker stop $(docker ps -aq)

# Remove all containers
docker rm $(docker ps -aq)

# Clean up unused resources
docker system prune -a
```

## Troubleshooting

### Homebrew Issues

**Issue**: Homebrew not in PATH

**Solution**:
```bash
# Add to shell profile
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
source ~/.zprofile

# Or for Intel Macs
echo 'eval "$(/usr/local/bin/brew shellenv)"' >> ~/.zprofile
source ~/.zprofile
```

**Issue**: Homebrew installation stuck

**Solution**:
```bash
# Cancel and retry
# Or install manually
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Colima Issues

**Issue**: Colima won't start

**Solution**:
```bash
# Check logs
colima logs

# Delete and recreate
colima delete
colima start --cpu 4 --memory 4 --disk 60

# If Lima is corrupted
rm -rf ~/.lima
colima delete
colima start
```

**Issue**: Docker commands fail

**Solution**:
```bash
# Verify Colima is running
colima status

# Restart Colima
colima restart

# Check Docker context
docker context ls
docker context use colima
```

**Issue**: Performance is slow

**Solution**:
```bash
# Allocate more resources
colima stop
colima start --cpu 4 --memory 8 --disk 80

# Or use VZ virtualization (faster on macOS 13+)
colima start --vm-type=vz --vz-rosetta
```

### Python Issues

**Issue**: Python 3.12 not found

**Solution**:
```bash
# Install via Homebrew
brew install python@3.12

# Link to python3.12
brew link python@3.12
```

**Issue**: Virtual environment activation fails

**Solution**:
```bash
# Recreate virtual environment
rm -rf ~/.ci-hub-venv
python3.12 -m venv ~/.ci-hub-venv
source ~/.ci-hub-venv/bin/activate
```

**Issue**: Package installation fails with GUI errors

**Solution**:
```bash
# Ensure headless configuration
export MPLBACKEND=Agg
export DISPLAY=

# Or reconfigure
invoke('configure_headless_python')
```

## Verification

After installation, verify everything is working:

```bash
# Check Homebrew
brew --version

# Check Colima
colima version
colima status

# Check Docker
docker --version
docker ps

# Check Python
python3.12 --version
source ~/.ci-hub-venv/bin/activate
python --version

# Run a test container
docker run hello-world
```

## Performance Tips

### Apple Silicon Optimization

```bash
# Use native ARM images when possible
docker pull --platform linux/arm64 image:tag

# Enable Rosetta for x86 images (macOS 13+)
colima start --vz-rosetta

# Monitor resource usage
docker stats
```

### Resource Management

```bash
# Check Colima resource usage
colima list

# Adjust resources without losing data
colima stop
colima start --cpu 6 --memory 8

# Monitor Docker disk usage
docker system df
```

## Next Steps

- [Installation Guide](./installation.md) - Main installation guide
- [System Requirements](./requirements.md) - System requirements
- [API Reference](./api-reference.md) - API documentation
- [Troubleshooting](./troubleshooting.md) - More troubleshooting tips
