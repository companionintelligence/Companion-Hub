# Troubleshooting Guide

## General Issues

### Application Won't Start

**Symptoms:** Double-clicking the application does nothing or shows an error.

**Solutions:**

**Windows:**
```powershell
# Check if app is running
Get-Process | Where-Object {$_.ProcessName -like "*ci-os-hub*"}

# Kill if stuck
Stop-Process -Name "ci-os-hub-desktop" -Force

# Check logs
Get-Content "$env:APPDATA\computer.ci.app\hub\logs\desktop.log"
```

**macOS:**
```bash
# Check if app is running
ps aux | grep -i "ci os hub"

# Kill if stuck
killall "CI OS Hub"

# Check logs
tail -f ~/Library/Application\ Support/computer.ci.app/hub/logs/desktop.log
```

**Linux:**
```bash
# Check if app is running
ps aux | grep ci-os-hub

# Kill if stuck
killall ci-os-hub-desktop

# Check logs
tail -f ~/.local/share/computer.ci.app/hub/logs/desktop.log
```

### Installation Stuck

**Symptoms:** Installation progress stops and doesn't continue.

**Solutions:**

1. **Check internet connection**: Installation requires downloading packages
2. **Check antivirus**: Temporarily disable and retry
3. **Check disk space**: Ensure at least 10GB free
4. **View logs**: Check application logs for errors
5. **Restart installation**: Close app and try again

**Force restart installation:**
```typescript
// Cancel current installation
// Close and reopen app
// Installation will resume or restart
```

### Performance Issues

**Symptoms:** Application is slow or unresponsive.

**Solutions:**

1. **Check system resources:**
   ```bash
   # Check RAM usage
   # Windows: Task Manager
   # macOS: Activity Monitor
   # Linux: htop or top
   ```

2. **Check Docker resources:**
   ```bash
   docker stats
   ```

3. **Increase Docker resources:**
   - Windows: Docker Desktop → Settings → Resources
   - macOS: Colima configuration (see macOS guide)

4. **Clear Docker cache:**
   ```bash
   docker system prune -a
   ```

## Windows-Specific Issues

### WSL2 Installation Failed

**Issue:** "The requested operation requires elevation"

**Solution:**
- Run application as Administrator (Right-click → Run as administrator)

**Issue:** "WSL 2 requires an update to its kernel component"

**Solution:**
1. Download: https://aka.ms/wsl2kernel
2. Install the update
3. Retry WSL2 installation

**Issue:** "Please enable the Virtual Machine Platform Windows feature"

**Solution:**
```powershell
# Run as Administrator
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
# Restart computer
```

**Issue:** "Virtualization is not enabled"

**Solution:**
1. Restart and enter BIOS/UEFI (F2, F10, DEL, or F12 during boot)
2. Find "Virtualization Technology", "Intel VT-x", or "AMD-V"
3. Enable the setting
4. Save and exit
5. Boot Windows and retry

### Docker Desktop Issues

**Issue:** "Docker Desktop requires WSL 2"

**Solution:**
- Ensure WSL2 is installed
- Set WSL2 as default: `wsl --set-default-version 2`

**Issue:** "Docker daemon is not running"

**Solution:**
```powershell
# Start Docker Desktop
& "C:\Program Files\Docker\Docker\Docker Desktop.exe"

# Wait 1-2 minutes for Docker to start
Start-Sleep -Seconds 60

# Verify
docker ps
```

**Issue:** "docker: command not found" in WSL2

**Solution:**
```bash
# In WSL2, add Docker Desktop integration
# Docker Desktop → Settings → Resources → WSL Integration
# Enable integration for Ubuntu-22.04
```

### Python Issues in WSL2

**Issue:** "python3.12: command not found"

**Solution:**
```bash
# In WSL2
sudo add-apt-repository ppa:deadsnakes/ppa
sudo apt-get update
sudo apt-get install python3.12 python3.12-venv
```

**Issue:** "No module named 'pip'"

**Solution:**
```bash
# In WSL2
python3.12 -m ensurepip
python3.12 -m pip install --upgrade pip
```

## macOS-Specific Issues

### Homebrew Installation Failed

**Issue:** "Failed to install Homebrew"

**Solution:**
```bash
# Manual installation
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Add to PATH
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
source ~/.zprofile
```

**Issue:** Homebrew commands not found after installation

**Solution:**
```bash
# Intel Mac
echo 'eval "$(/usr/local/bin/brew shellenv)"' >> ~/.zprofile

# Apple Silicon
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile

source ~/.zprofile
```

### Colima Issues

**Issue:** "colima: command not found"

**Solution:**
```bash
# Install Colima
brew install colima

# Verify installation
which colima
```

**Issue:** Colima fails to start

**Solution:**
```bash
# View logs
colima logs

# Delete and recreate
colima delete
colima start --cpu 4 --memory 4 --disk 60

# If still failing, remove Lima data
rm -rf ~/.lima
colima start
```

**Issue:** "Docker socket not found"

**Solution:**
```bash
# Ensure Colima is running
colima status

# If stopped, start it
colima start

# Verify Docker socket
ls -la ~/.colima/default/docker.sock
```

**Issue:** Slow Docker performance

**Solution:**
```bash
# Use VZ virtualization (macOS 13+, faster)
colima delete
colima start --vm-type=vz --vz-rosetta --cpu 4 --memory 6

# Or increase resources
colima stop
colima start --cpu 6 --memory 8
```

### Python Issues on macOS

**Issue:** "python3.12: command not found"

**Solution:**
```bash
# Install via Homebrew
brew install python@3.12

# Link to python3.12
brew link python@3.12
```

**Issue:** "No module named 'pip'"

**Solution:**
```bash
# Reinstall Python
brew reinstall python@3.12
```

**Issue:** Package installation requires GUI

**Solution:**
```bash
# Ensure headless configuration
export MPLBACKEND=Agg
export DISPLAY=

# Install package
pip install package-name
```

## Linux-Specific Issues

### Application Won't Launch

**Issue:** "error while loading shared libraries"

**Solution:**
```bash
# Install required libraries
# Ubuntu/Debian
sudo apt-get install libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1

# Fedora
sudo dnf install webkit2gtk4.1 gtk3 libappindicator-gtk3

# Arch
sudo pacman -S webkit2gtk gtk3 libappindicator-gtk3
```

**Issue:** AppImage won't execute

**Solution:**
```bash
# Make executable
chmod +x CI-OS-Hub-Desktop.AppImage

# If FUSE is not installed
./CI-OS-Hub-Desktop.AppImage --appimage-extract
./squashfs-root/AppRun
```

### Docker Permission Issues

**Issue:** "Permission denied" when running Docker

**Solution:**
```bash
# Add user to docker group
sudo usermod -aG docker $USER

# Log out and log back in, or:
newgrp docker

# Verify
docker ps
```

**Issue:** "Cannot connect to Docker daemon"

**Solution:**
```bash
# Start Docker service
sudo systemctl start docker

# Enable on boot
sudo systemctl enable docker

# Check status
sudo systemctl status docker
```

## Network Issues

### Cannot Access Web Interface

**Issue:** "localhost refused to connect"

**Solutions:**

1. **Check backend is running:**
   ```bash
   curl http://localhost:3000/api/health
   ```

2. **Check port is not in use:**
   ```bash
   # Windows
   netstat -ano | findstr :80
   
   # macOS/Linux
   lsof -i :80
   ```

3. **Try alternate port:**
   - Change port in Settings
   - Or access via: http://localhost:8080

4. **Check firewall:**
   - Windows: Allow app through Windows Firewall
   - macOS: System Preferences → Security & Privacy → Firewall
   - Linux: Check iptables/ufw rules

### Slow Network Performance

**Issue:** Pages load slowly

**Solutions:**

1. **Check Docker networking:**
   ```bash
   docker network ls
   docker network inspect bridge
   ```

2. **Restart networking:**
   ```bash
   # Windows: Restart Docker Desktop
   # macOS: colima restart
   # Linux: sudo systemctl restart docker
   ```

## Database Issues

### Database Connection Failed

**Issue:** "Cannot connect to PostgreSQL"

**Solutions:**

1. **Check PostgreSQL container:**
   ```bash
   docker ps | grep postgres
   ```

2. **Check logs:**
   ```bash
   docker logs ci-hub-db
   ```

3. **Restart database:**
   ```bash
   docker restart ci-hub-db
   ```

4. **Rebuild database:**
   ```bash
   # Warning: This deletes all data
   docker rm -f ci-hub-db
   # Restart application to recreate
   ```

### Database Corruption

**Issue:** "Database disk image is malformed"

**Solutions:**

1. **Backup data (if possible):**
   ```bash
   # Create backup before attempting recovery
   ```

2. **Reset database:**
   - Stop application
   - Delete database volume
   - Restart application

## Getting More Help

### Collecting Diagnostic Information

Before requesting support, collect:

1. **System information:**
   ```bash
   # Output from check_system_requirements command
   ```

2. **Installation logs:**
   - Windows: `%APPDATA%\computer.ci.app\hub\logs\`
   - macOS: `~/Library/Application Support/computer.ci.app/hub/logs/`
   - Linux: `~/.local/share/computer.ci.app/hub/logs/`

3. **Docker information:**
   ```bash
   docker version
   docker info
   docker ps -a
   ```

4. **Error messages:**
   - Screenshots of error dialogs
   - Console output
   - Log excerpts

### Support Channels

- **Documentation**: https://docs.ci.computer
- **GitHub Issues**: https://github.com/companionintelligence/CI-OS-Hub/issues
- **Community Forum**: https://community.ci.computer
- **Email**: support@ci.computer

### Known Issues

Check the GitHub Issues page for known issues and workarounds:
https://github.com/companionintelligence/CI-OS-Hub/issues

## Next Steps

- [Installation Guide](./installation.md) - Reinstall if needed
- [API Reference](./api-reference.md) - Programmatic troubleshooting
- [Windows Automation](./windows-automation.md) - Windows-specific help
- [macOS Automation](./macos-automation.md) - macOS-specific help
