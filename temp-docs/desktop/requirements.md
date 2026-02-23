# System Requirements

## Minimum Requirements

### Hardware

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **CPU** | 2 cores | 4+ cores |
| **RAM** | 4 GB | 8+ GB |
| **Disk Space** | 10 GB free | 20+ GB free |
| **Network** | Internet connection | Broadband connection |

### Software

#### Windows
- **OS**: Windows 10 Pro/Enterprise (build 19041+) or Windows 11
- **Features**: Virtualization enabled in BIOS (VT-x/AMD-V)
- **Requirements**:
  - 64-bit processor
  - Hardware virtualization support
  - At least 4GB RAM
  - 10GB free disk space

#### macOS
- **OS**: macOS 11.0 (Big Sur) or later
- **Architecture**: Intel x64 or Apple Silicon (M1/M2/M3)
- **Requirements**:
  - Xcode Command Line Tools (auto-installed)
  - At least 4GB RAM
  - 10GB free disk space

#### Linux
- **OS**: Ubuntu 20.04+, Debian 11+, Fedora 35+, or equivalent
- **Kernel**: 5.4+
- **Requirements**:
  - 64-bit x86_64 or ARM64
  - GTK 3.24+
  - WebKit2GTK 2.28+
  - At least 4GB RAM
  - 10GB free disk space

## Detailed Requirements by Platform

### Windows Requirements

#### Operating System
- **Minimum**: Windows 10 Pro, Enterprise, or Education (build 19041 or higher)
- **Recommended**: Windows 11

**Why Windows Pro/Enterprise?**
WSL2 requires Hyper-V, which is not available in Windows 10 Home. However, Windows 11 Home does support WSL2.

#### Virtualization

**Required**: Hardware virtualization must be enabled in BIOS/UEFI

Check virtualization support:
```powershell
# Run in PowerShell as Administrator
systeminfo | findstr /C:"Hyper-V Requirements"
```

You should see:
- Virtualization Enabled In Firmware: Yes
- A hypervisor has been detected

**To Enable Virtualization:**
1. Restart and enter BIOS/UEFI setup (usually F2, F10, or DEL during boot)
2. Look for "Virtualization Technology" or "VT-x" (Intel) / "AMD-V" (AMD)
3. Enable the feature
4. Save and exit

#### Disk Space Breakdown
- CI OS Hub Desktop: 200 MB
- WSL2 + Ubuntu 22.04: 2 GB
- Docker Desktop: 1.5 GB
- Python + packages: 500 MB
- Working space: 6 GB minimum

### macOS Requirements

#### Operating System
- **Minimum**: macOS 11.0 (Big Sur)
- **Recommended**: macOS 12.0 (Monterey) or later

#### Architecture Support
- **Intel Macs**: x86_64 processors (2015 or newer recommended)
- **Apple Silicon**: M1, M2, M3 chips (native ARM64 support)

#### Required Tools
- **Xcode Command Line Tools** (automatically installed if missing)

Check if installed:
```bash
xcode-select -p
```

Install if needed:
```bash
xcode-select --install
```

#### Disk Space Breakdown
- CI OS Hub Desktop: 150 MB
- Homebrew: 500 MB
- Colima + Lima: 500 MB
- Docker tools: 300 MB
- Python + packages: 400 MB
- Working space: 6 GB minimum

### Linux Requirements

#### Supported Distributions

**Tested and Supported:**
- Ubuntu 20.04, 22.04, 24.04
- Debian 11 (Bullseye), 12 (Bookworm)
- Fedora 35, 36, 37, 38
- Arch Linux (current)
- Pop!_OS 22.04

**Should Work:**
- Any modern Linux distribution with:
  - GTK 3.24+
  - WebKit2GTK 2.28+
  - systemd

#### System Libraries

Required libraries (usually pre-installed):
```bash
# Ubuntu/Debian
sudo apt-get install \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1

# Fedora
sudo dnf install \
  webkit2gtk4.1 \
  gtk3 \
  libappindicator-gtk3

# Arch
sudo pacman -S \
  webkit2gtk \
  gtk3 \
  libappindicator-gtk3
```

#### Disk Space Breakdown
- CI OS Hub Desktop: 150 MB
- Docker: 500 MB
- Python + packages: 400 MB
- Working space: 6 GB minimum

## Performance Considerations

### CPU

**Minimum 2 cores:**
- 1 core for host OS
- 1 core for containers/VM

**Recommended 4+ cores:**
- Better multitasking
- Faster Docker builds
- Smoother UI experience

### Memory

**4GB RAM (Minimum):**
- 2GB for host OS
- 2GB for Docker/containers
- May experience slowdowns with multiple apps

**8GB RAM (Recommended):**
- 3GB for host OS
- 4GB for Docker/containers
- 1GB for additional services
- Smooth operation with multiple apps

**16GB+ RAM (Optimal):**
- Multiple apps and services
- Large Docker containers
- Development workflows

### Disk Space

**10GB Minimum:**
- Just enough for installation and basic operation
- May require cleanup of Docker images

**20GB Recommended:**
- Room for Docker images and containers
- Multiple app installations
- Logs and temporary files

**50GB+ Optimal:**
- Many Docker images
- Multiple Hub instances
- Development workflows
- Backups

### Storage Type

**SSD Recommended:**
- Much faster Docker operations
- Faster app launches
- Better overall performance

**HDD Supported:**
- Will work but slower
- Docker operations are disk-intensive
- Consider SSD for better experience

## Network Requirements

### Internet Connection

**During Installation:**
- Required for downloading dependencies
- Bandwidth: 2GB+ download for initial setup
- Time: 10-20 minutes on broadband

**During Operation:**
- Optional for local-only use
- Required for cloud features
- Required for app updates

### Firewall

The following ports are used locally:

| Port | Service | Required |
|------|---------|----------|
| 80 | Hub web interface | Yes |
| 443 | HTTPS (optional) | No |
| 3000 | Backend API | Yes |
| 5432 | PostgreSQL | Yes (internal) |
| 5672 | RabbitMQ | Yes (internal) |
| 9091 | Frontend dev | Dev only |

**Note**: All services run on localhost by default. No external access unless explicitly configured.

## Compatibility Notes

### Windows Editions

| Edition | WSL2 Support | Compatible |
|---------|--------------|------------|
| Windows 11 Home | ✅ Yes | ✅ Yes |
| Windows 11 Pro/Enterprise | ✅ Yes | ✅ Yes |
| Windows 10 Home | ❌ No* | ⚠️ Limited |
| Windows 10 Pro/Enterprise | ✅ Yes | ✅ Yes |

*Windows 10 Home users should upgrade to Windows 11 Home (free) or Windows 10 Pro for full functionality.

### macOS Versions

| Version | Intel Support | Apple Silicon Support |
|---------|--------------|---------------------|
| macOS 15 (Sequoia) | ✅ Full | ✅ Full |
| macOS 14 (Sonoma) | ✅ Full | ✅ Full |
| macOS 13 (Ventura) | ✅ Full | ✅ Full |
| macOS 12 (Monterey) | ✅ Full | ✅ Full |
| macOS 11 (Big Sur) | ✅ Full | ✅ Full |
| macOS 10.15 (Catalina) | ⚠️ Limited | N/A |

### Linux Compatibility

**Kernel Version:**
- Minimum: 5.4 (Ubuntu 20.04)
- Recommended: 5.15+ (Ubuntu 22.04)

**Display Server:**
- X11: Fully supported
- Wayland: Supported
- No display server: Not supported (desktop app requires GUI)

## Checking Your System

### Automated Check

The desktop application includes a system checker:

1. Download and run the application
2. System requirements will be checked automatically
3. Any issues will be highlighted with solutions

### Manual Check

#### Windows
```powershell
# Check Windows version
winver

# Check RAM
systeminfo | findstr /C:"Total Physical Memory"

# Check disk space
Get-PSDrive C

# Check virtualization
systeminfo | findstr /C:"Hyper-V Requirements"
```

#### macOS
```bash
# Check macOS version
sw_vers

# Check RAM
sysctl hw.memsize

# Check disk space
df -h /

# Check architecture
uname -m  # x86_64 or arm64
```

#### Linux
```bash
# Check distribution and version
cat /etc/os-release

# Check RAM
free -h

# Check disk space
df -h /

# Check kernel version
uname -r
```

## Next Steps

- [Installation Guide](./installation.md) - Install the desktop application
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
