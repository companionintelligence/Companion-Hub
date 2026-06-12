# Uninstalling Companion Hub

This guide covers complete uninstallation of Companion Hub on Linux, macOS, and Windows.

---

## 🐧 Linux

### Complete Uninstall (Nuclear Option)

Use this when you want to completely remove Companion Hub, all apps, Docker containers, volumes, and data.

**⚠️ IMPORTANT:** Replace `<YOUR_USERNAME>` in the commands below with your actual Linux username!

```bash
# Stop all running containers
docker stop $(docker ps -q)

# Remove all Docker resources (containers, images, volumes, networks)
docker system prune --volumes --all --force && docker volume rm $(docker volume ls -q)

# Uninstall Companion Hub package
sudo apt-get purge -y companion-hub && sudo apt-get autoremove -y

# Remove user data directories (REPLACE <YOUR_USERNAME> WITH YOUR ACTUAL USERNAME!)
sudo rm -rf /home/<YOUR_USERNAME>/.local/share/companion-hub
sudo rm -rf /home/<YOUR_USERNAME>/.local/share/computer.ci.app.hub
```

**Example:** If your username is `john`, use:
```bash
sudo rm -rf /home/john/.local/share/companion-hub
sudo rm -rf /home/john/.local/share/computer.ci.app.hub
```

**Alternative (works for current user automatically):**
```bash
rm -rf ~/.local/share/companion-hub
rm -rf ~/.local/share/computer.ci.app.hub
rm -rf ~/.config/companion-hub
rm -rf ~/.cache/companion-hub
```

**⚠️ Warning:** This will delete:
- All installed apps and their data
- All Docker images (including non-Hub images)
- All Docker volumes (including non-Hub volumes)
- All Hub configuration and credentials

---

### Selective Uninstall (Keep Some Docker Resources)

If you want to preserve specific Docker images or volumes, use the Hub's built-in cleanup script instead:

```bash
# 1. Run Hub's selective cleanup script
sudo /usr/share/companion-hub/scripts/uninstall-cleanup.sh

# 2. Uninstall the Hub package
sudo apt-get purge -y companion-hub && sudo apt-get autoremove -y

# 3. Remove user data (replace 'username' with your actual username)
rm -rf ~/.local/share/companion-hub
rm -rf ~/.local/share/computer.ci.app.hub
rm -rf ~/.config/companion-hub
rm -rf ~/.cache/companion-hub
```

This script:
- ✅ Removes only Hub-managed containers (labeled with `ci-os-hub.managed=true`)
- ✅ Preserves Docker images/volumes not created by Hub
- ✅ Cleans up Hub networks and volumes
- ✅ Works for all user home directories on the system

---

### Package-Specific Uninstall

#### Debian/Ubuntu (APT)
```bash
sudo apt-get purge -y companion-hub && sudo apt-get autoremove -y
```

#### Arch Linux (AUR)
```bash
yay -Rns companion-hub-bin
# or
paru -Rns companion-hub-bin
```

#### Snap
```bash
sudo snap remove companion-hub
```

#### Flatpak
```bash
flatpak uninstall computer.ci.app.hub
```

---

### Verify Complete Removal

After uninstalling, verify all traces are gone:

```bash
# Check for Hub processes
ps aux | grep -i companion

# Check for remaining Docker containers
docker ps -a | grep -E 'ci-os-hub|ci-hub'

# Check for remaining Docker volumes
docker volume ls | grep -E 'ci-os-hub|ci-hub'

# Check for remaining Docker networks
docker network ls | grep -E 'ci-os-hub|ci-hub'

# Check for user data directories
ls -la ~/.local/share/ | grep -E 'companion-hub|computer.ci'
ls -la ~/.config/ | grep companion-hub
ls -la ~/.cache/ | grep companion-hub
```

If any resources remain, manually remove them:

```bash
# Remove specific containers
docker rm -f <container-name>

# Remove specific volumes
docker volume rm <volume-name>

# Remove specific networks
docker network rm <network-name>

# Remove specific directories
rm -rf ~/.local/share/companion-hub
```

---

## 🍎 macOS

### Complete Uninstall

```bash
# 1. Stop all Docker containers (if you want to remove everything)
docker stop $(docker ps -q)
docker system prune --volumes --all --force

# 2. Uninstall Hub app
# If installed via DMG:
rm -rf /Applications/Companion\ Hub.app

# If installed via Homebrew:
brew uninstall companion-hub

# 3. Remove user data
rm -rf ~/Library/Application\ Support/computer.ci.app.hub
rm -rf ~/Library/Caches/computer.ci.app.hub
rm -rf ~/Library/Preferences/computer.ci.app.hub.plist
rm -rf ~/Library/Logs/Companion\ Hub
```

---

## 🪟 Windows

### Complete Uninstall

#### Option 1: Using Windows Settings
1. Open **Settings** → **Apps** → **Installed apps**
2. Search for "Companion Hub"
3. Click **⋯** → **Uninstall**
4. Follow the uninstaller prompts

#### Option 2: Using PowerShell (Nuclear Option)

```powershell
# Run PowerShell as Administrator

# 1. Stop all Docker containers
docker stop $(docker ps -q)

# 2. Remove all Docker resources
docker system prune --volumes --all --force
docker volume rm $(docker volume ls -q)

# 3. Uninstall Companion Hub
# If installed via installer:
& "C:\Program Files\Companion Hub\uninstall.exe"

# If installed via Chocolatey:
choco uninstall companion-hub -y

# If installed via Scoop:
scoop uninstall companion-hub

# 4. Remove user data
Remove-Item -Recurse -Force "$env:APPDATA\computer.ci.app.hub" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\computer.ci.app.hub" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Companion Hub" -ErrorAction SilentlyContinue
```

---

## 🗑️ Cleanup Script Details

The Hub's built-in cleanup script (`distribution/scripts/uninstall-cleanup.sh`) performs the following:

### What It Removes:

1. **Hub-Managed Containers:**
   - All containers labeled with `ci-os-hub.managed=true`
   - Hub compose projects: `ci-os-hub`, `ci-hub`
   - Marketplace app containers (e.g., `grafana_ci-marketplace`, `nextcloud_ci-marketplace`)

2. **Hub-Managed Networks:**
   - `ci_os_hub_network`
   - `ci-os-hub_network`
   - App-specific networks (labeled by compose project)

3. **Hub-Managed Volumes:**
   - All volumes labeled with Hub compose projects
   - App-specific volumes (labeled by compose project)

4. **Hub-Managed Images:**
   - Images built by Hub compose projects
   - Images pulled specifically for Hub apps

5. **User Data:**
   - `~/.local/share/companion-hub/`
   - `~/.local/share/computer.ci.app.hub/`
   - `~/.config/companion-hub/`
   - `~/.cache/companion-hub/`
   - Desktop entries (`~/.local/share/applications/companion-hub.desktop`)

### What It Preserves:

- ✅ Docker images not created by Hub
- ✅ Docker volumes not created by Hub
- ✅ Docker networks (`bridge`, `host`, `none`)
- ✅ Non-Hub containers

---

## 🔍 Troubleshooting

### "Permission denied" when removing directories

```bash
# Use sudo for system-wide directories
sudo rm -rf /opt/companion-hub
sudo rm -rf /usr/share/companion-hub

# For user directories, ensure you're the owner
ls -la ~/.local/share/companion-hub
# If owned by root, reclaim ownership first:
sudo chown -R $USER:$USER ~/.local/share/companion-hub
rm -rf ~/.local/share/companion-hub
```

### Docker commands fail with "Cannot connect to Docker daemon"

Docker might not be running or you don't have permission:

```bash
# Start Docker service
sudo systemctl start docker

# Or add yourself to docker group
sudo usermod -aG docker $USER
# Then log out and back in
```

### Leftover processes after uninstall

```bash
# Find Hub processes
ps aux | grep -i companion

# Kill specific process
kill -9 <PID>

# Or kill all Hub processes
pkill -9 -f companion-hub
```

### Clean slate reinstall

If you're reinstalling and want a completely fresh start:

```bash
# 1. Complete uninstall (see above)
# 2. Remove Docker data directory (optional, removes ALL Docker data)
sudo systemctl stop docker
sudo rm -rf /var/lib/docker
sudo systemctl start docker

# 3. Reinstall Hub
# (follow installation instructions)
```

---

## 📚 Related Documentation

- [Installation Guide](../README.md#installation)
- [Troubleshooting](./TROUBLESHOOTING.md)
- [Docker Cleanup Best Practices](./DOCKER_CLEANUP.md)

---

## ⚠️ Important Notes

1. **Backup First:** If you have important data in Hub apps (e.g., Nextcloud files, Grafana dashboards), back them up before uninstalling.

2. **User-Specific Paths:** The examples above use placeholder usernames (`/home/username`). Replace with your actual username or use `~` for your home directory.

3. **Docker Hub Images:** The nuclear uninstall removes ALL Docker images. If you have images for other projects, back them up:
   ```bash
   docker save -o backup.tar <image-name>:<tag>
   # Restore later:
   docker load -i backup.tar
   ```

4. **Multi-User Systems:** On shared systems, the cleanup script cleans Hub data for ALL users (requires sudo). Use the selective uninstall if you only want to remove your own installation.

---

## 🆘 Need Help?

If you encounter issues during uninstall:

1. Check the [Troubleshooting Guide](./TROUBLESHOOTING.md)
2. Review uninstaller logs: `~/.cache/companion-hub/uninstall.log`
3. Join our [Discord community](https://discord.gg/companionintelligence)
4. Open an issue on [GitHub](https://github.com/companionintelligence/ci-hub/issues)
