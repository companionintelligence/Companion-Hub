# Desktop Application Testing Guide

This guide covers local testing of the CI OS Hub Desktop application on Windows and macOS.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Manual Testing](#manual-testing)
- [Automated Testing](#automated-testing)
- [Testing Specific Features](#testing-specific-features)
- [Debugging](#debugging)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### All Platforms

- **Rust**: Install from [rustup.rs](https://rustup.rs/)
- **Node.js**: Version 18+ (we use Bun, but Node works too)
- **Bun**: Install from [bun.sh](https://bun.sh/) (recommended) or use npm
- **Git**: For cloning and version control

### Windows-Specific

- **Visual Studio Build Tools**: Install from [Microsoft](https://visualstudio.microsoft.com/downloads/)
  - Select "Desktop development with C++" workload
- **WebView2**: Usually pre-installed on Windows 10/11
  - If missing, install from [Microsoft Edge WebView2](https://developer.microsoft.com/en-us/microsoft-edge/webview2/)

### macOS-Specific

- **Xcode Command Line Tools**: 
  ```bash
  xcode-select --install
  ```
- **Homebrew** (optional, for easier dependency management):
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  ```

## Quick Start

### 1. Clone and Setup

```bash
# Clone the repository
git clone https://github.com/companionintelligence/CI-OS-Hub.git
cd CI-OS-Hub

# Install dependencies
bun install

# Build the common package (required)
bun run build
```

### 2. Start Development Mode

```bash
# Start the desktop app in development mode
bun run dev:desktop
```

This will:
- Compile the Rust backend
- Start the Tauri development server
- Launch the desktop application with hot reload
- Connect to frontend dev server on port 9091

### 3. Build for Testing

```bash
# Create a production build for your platform
bun run build:desktop
```

**Output locations:**
- **Windows**: `src-tauri/target/release/bundle/msi/` and `src-tauri/target/release/bundle/nsis/`
- **macOS**: `src-tauri/target/release/bundle/dmg/` and `src-tauri/target/release/bundle/macos/`

## Manual Testing

### Windows Testing

#### Test Environment Setup

1. **Open PowerShell as Administrator** (required for WSL2 testing)

2. **Navigate to project**:
   ```powershell
   cd path\to\CI-OS-Hub
   ```

3. **Run development mode**:
   ```powershell
   bun run dev:desktop
   ```

#### Test Checklist

- [ ] **Application Launch**
  - App window opens successfully
  - No console errors
  - Frontend loads correctly

- [ ] **System Detection**
  - Open DevTools (F12) and run:
    ```javascript
    await window.__TAURI__.core.invoke('check_system_requirements')
    ```
  - Verify system info is correct (OS, RAM, disk, CPU)

- [ ] **WSL2 Detection**
  - Test WSL2 status:
    ```javascript
    await window.__TAURI__.core.invoke('check_wsl2_installed')
    ```
  - Should return proper status

- [ ] **Docker Detection**
  - Test Docker status:
    ```javascript
    await window.__TAURI__.core.invoke('check_docker_installed')
    ```

- [ ] **Full Installation Flow** (if testing installers)
  - Install WSL2 if not present
  - Install Docker Desktop
  - Install Python in WSL2
  - Monitor progress events
  - Verify all installations succeed

#### Test with Built Installer

1. **Build the MSI installer**:
   ```powershell
   bun run build:desktop
   ```

2. **Install from MSI**:
   ```powershell
   cd src-tauri\target\release\bundle\msi
   .\CI-OS-Hub-Desktop_*_x64.msi
   ```

3. **Test installed application**:
   - Launch from Start Menu
   - Verify system tray icon
   - Test all core features
   - Check uninstall works properly

### macOS Testing

#### Test Environment Setup

1. **Open Terminal**

2. **Navigate to project**:
   ```bash
   cd path/to/CI-OS-Hub
   ```

3. **Run development mode**:
   ```bash
   bun run dev:desktop
   ```

#### Test Checklist

- [ ] **Application Launch**
  - App bundle opens successfully
  - No console errors in Terminal
  - Frontend loads correctly

- [ ] **System Detection**
  - Open DevTools (Cmd+Option+I) and run:
    ```javascript
    await window.__TAURI__.core.invoke('check_system_requirements')
    ```
  - Verify system info (Intel vs Apple Silicon detection)

- [ ] **Homebrew Detection**
  - Test Homebrew status:
    ```javascript
    await window.__TAURI__.core.invoke('check_homebrew')
    ```

- [ ] **Xcode Tools Detection**
  - Test Xcode tools:
    ```javascript
    await window.__TAURI__.core.invoke('check_xcode_tools')
    ```

- [ ] **Colima Detection**
  - Test Colima status:
    ```javascript
    await window.__TAURI__.core.invoke('check_colima')
    ```

- [ ] **Full Installation Flow** (if testing installers)
  - Install Homebrew if not present
  - Install Colima/Lima/Docker
  - Install Python (headless)
  - Monitor progress events
  - Verify all installations succeed

#### Test with Built Installer

1. **Build the DMG installer**:
   ```bash
   bun run build:desktop
   ```

2. **Install from DMG**:
   ```bash
   open src-tauri/target/release/bundle/dmg/CI-OS-Hub-Desktop_*_universal.dmg
   ```
   - Drag app to Applications folder
   - Launch from Applications

3. **Test installed application**:
   - Launch from Applications or Dock
   - Test on both Intel and Apple Silicon (if available)
   - Verify all core features
   - Check uninstall (drag to Trash)

## Automated Testing

We provide platform-specific test scripts that automate common testing scenarios.

### Windows Automated Testing

Run the PowerShell test script:

```powershell
# From project root
.\src-tauri\scripts\test-windows.ps1
```

**What it tests:**
- Rust build compilation
- System detection commands
- Prerequisite checking commands
- Windows-specific installer commands
- Error handling

**Options:**
```powershell
# Run with verbose output
.\src-tauri\scripts\test-windows.ps1 -Verbose

# Skip build step (if already built)
.\src-tauri\scripts\test-windows.ps1 -SkipBuild
```

### macOS Automated Testing

Run the Bash test script:

```bash
# From project root
./src-tauri/scripts/test-macos.sh
```

**What it tests:**
- Rust build compilation
- System detection commands
- Prerequisite checking commands
- macOS-specific installer commands
- Architecture detection (Intel vs Apple Silicon)
- Error handling

**Options:**
```bash
# Run with verbose output
./src-tauri/scripts/test-macos.sh --verbose

# Skip build step (if already built)
./src-tauri/scripts/test-macos.sh --skip-build

# Test only specific features
./src-tauri/scripts/test-macos.sh --feature system-detection
```

### Using npm Scripts

```bash
# Quick test (auto-detects platform)
npm run test:desktop

# Or with bun
bun run test:desktop
```

## Testing Specific Features

### Testing System Detection

**Development mode:**
```javascript
// In DevTools console
const info = await window.__TAURI__.core.invoke('check_system_requirements');
console.log(info);
```

**Expected output:**
```json
{
  "os": "windows" | "macos" | "linux",
  "version": "10.0.19041",
  "arch": "x86_64" | "aarch64",
  "total_memory": 16000000000,
  "available_disk": 500000000000,
  "cpu_count": 8,
  "has_virtualization": true,
  "meets_requirements": true,
  "warnings": []
}
```

### Testing Progress Events

**Listen to installation progress:**
```javascript
// In DevTools console
await window.__TAURI__.event.listen('install-progress', (event) => {
  console.log('Progress:', event.payload);
  // { step: "Installing WSL2...", progress: 45, status: "InProgress", message: "..." }
});

// Trigger an installation (example)
await window.__TAURI__.core.invoke('install_wsl2');
```

### Testing Prerequisites

**Windows:**
```javascript
// Check all prerequisites
const prereqs = await window.__TAURI__.core.invoke('check_all_prerequisites');
console.log('Prerequisites:', prereqs);

// Individual checks
const wsl2 = await window.__TAURI__.core.invoke('check_wsl2_installed');
const docker = await window.__TAURI__.core.invoke('check_docker_installed');
const python = await window.__TAURI__.core.invoke('check_python_installed');
```

**macOS:**
```javascript
// Check all prerequisites
const prereqs = await window.__TAURI__.core.invoke('check_all_prerequisites');

// Individual checks
const xcode = await window.__TAURI__.core.invoke('check_xcode_tools');
const homebrew = await window.__TAURI__.core.invoke('check_homebrew');
const colima = await window.__TAURI__.core.invoke('check_colima');
const python = await window.__TAURI__.core.invoke('check_python_installed');
```

## Debugging

### Enable Rust Logging

**Development:**
```bash
# macOS/Linux
RUST_LOG=debug bun run dev:desktop

# Windows PowerShell
$env:RUST_LOG="debug"
bun run dev:desktop
```

**Log levels:**
- `error` - Only errors
- `warn` - Warnings and errors
- `info` - Informational messages
- `debug` - Detailed debugging
- `trace` - Very verbose

### DevTools Console

**Open DevTools:**
- **Windows/Linux**: F12 or Ctrl+Shift+I
- **macOS**: Cmd+Option+I

**Access Tauri API:**
```javascript
// Check if Tauri is available
console.log('Tauri:', window.__TAURI__);

// List all available commands
console.log('Commands:', Object.keys(window.__TAURI__.core));
```

### Debugging Rust Code

**With VS Code:**

1. Install the Rust Analyzer extension
2. Add to `.vscode/launch.json`:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "lldb",
      "request": "launch",
      "name": "Tauri Development Debug",
      "cargo": {
        "args": [
          "build",
          "--manifest-path=./src-tauri/Cargo.toml",
          "--no-default-features"
        ]
      },
      "cwd": "${workspaceFolder}"
    }
  ]
}
```

3. Set breakpoints in Rust code
4. Press F5 to start debugging

### Common Debug Commands

```bash
# Check Rust installation
rustc --version
cargo --version

# Check Tauri CLI
cargo tauri --version

# Clean build artifacts
cd src-tauri
cargo clean

# Build with verbose output
cargo build --verbose

# Check for errors
cargo check
```

## Troubleshooting

### Windows Issues

#### "WebView2 not found"
**Solution:**
```powershell
# Download and install WebView2 Runtime
# https://developer.microsoft.com/en-us/microsoft-edge/webview2/
```

#### "Cannot find Visual Studio"
**Solution:**
```powershell
# Install Visual Studio Build Tools
# https://visualstudio.microsoft.com/downloads/
# Select "Desktop development with C++"
```

#### "WSL2 installation fails"
**Solution:**
```powershell
# Enable Windows features manually
dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart

# Restart computer
# Then set WSL2 as default
wsl --set-default-version 2
```

#### "Permission denied" errors
**Solution:**
- Run PowerShell as Administrator
- Check antivirus isn't blocking execution
- Ensure execution policy allows scripts:
  ```powershell
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```

### macOS Issues

#### "Command not found: cargo"
**Solution:**
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

#### "Xcode tools not found"
**Solution:**
```bash
xcode-select --install
# Accept license
sudo xcodebuild -license accept
```

#### "Cannot open app - unidentified developer"
**Solution:**
```bash
# Remove quarantine attribute
xattr -cr /Applications/CI-OS-Hub-Desktop.app

# Or allow in System Preferences:
# System Preferences > Security & Privacy > General > "Open Anyway"
```

#### "Architecture mismatch" (Intel vs Apple Silicon)
**Solution:**
```bash
# Check your architecture
uname -m  # x86_64 = Intel, arm64 = Apple Silicon

# Build for specific architecture
cargo build --target x86_64-apple-darwin  # Intel
cargo build --target aarch64-apple-darwin # Apple Silicon
```

#### "Homebrew installation fails"
**Solution:**
```bash
# Install Homebrew manually
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Add to PATH (Apple Silicon)
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# Add to PATH (Intel)
echo 'eval "$(/usr/local/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/usr/local/bin/brew shellenv)"
```

### General Issues

#### "Cargo build fails"
**Solution:**
```bash
# Update Rust
rustup update

# Clean and rebuild
cd src-tauri
cargo clean
cargo build
```

#### "Frontend not loading"
**Solution:**
```bash
# Ensure frontend is built
bun run build

# Check frontend is running (dev mode)
# Should be on http://localhost:9091
curl http://localhost:9091
```

#### "Commands not found"
**Solution:**
- Check `src-tauri/src/main.rs` for command registration
- Ensure all commands are properly invoked
- Check DevTools console for errors
- Verify command names match exactly (case-sensitive)

## Performance Testing

### Measure Command Execution Time

```javascript
// In DevTools console
console.time('system-check');
await window.__TAURI__.core.invoke('check_system_requirements');
console.timeEnd('system-check');
```

### Monitor Resource Usage

**Windows:**
```powershell
# Monitor process in Task Manager
# Or use PowerShell
Get-Process "CI-OS-Hub-Desktop" | Select-Object CPU, WS
```

**macOS:**
```bash
# Monitor with Activity Monitor
# Or use top
top -pid $(pgrep "CI-OS-Hub-Desktop")
```

## CI/CD Testing

The project includes GitHub Actions for automated testing:

**Workflow:** `.github/workflows/build-desktop-release.yml`

**Local simulation:**
```bash
# Install act (GitHub Actions local runner)
# https://github.com/nektos/act

# Run the workflow locally
act -W .github/workflows/build-desktop-release.yml
```

## Contributing Test Improvements

When adding new features:

1. Add test cases to automated scripts
2. Update this documentation
3. Add examples to the troubleshooting section
4. Test on both Windows and macOS
5. Document any new prerequisites

## Resources

- [Tauri Documentation](https://v2.tauri.app)
- [Rust Book](https://doc.rust-lang.org/book/)
- [Project Documentation](../temp-docs/desktop/)
- [API Reference](../temp-docs/desktop/api-reference.md)
- [GitHub Issues](https://github.com/companionintelligence/CI-OS-Hub/issues)

## Support

For testing issues:
- Check [Troubleshooting](#troubleshooting) section above
- Review [temp-docs/desktop/troubleshooting.md](../temp-docs/desktop/troubleshooting.md)
- Open an issue on GitHub with:
  - Platform (Windows/macOS) and version
  - Error messages and logs
  - Steps to reproduce
  - Output of `cargo --version` and `rustc --version`
