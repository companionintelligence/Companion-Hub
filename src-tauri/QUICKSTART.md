# Quick Start Guide - Desktop Testing

This is a quick reference guide for developers who want to test the CI OS Hub Desktop application locally.

## Prerequisites

- **Rust** ([install](https://rustup.rs/))
- **Node.js 18+** or **Bun** ([install](https://bun.sh/))
- **Platform-specific tools:**
  - Windows: Visual Studio Build Tools, WebView2
  - macOS: Xcode Command Line Tools (`xcode-select --install`)

## 5-Minute Setup

```bash
# 1. Clone and install
git clone https://github.com/companionintelligence/CI-OS-Hub.git
cd CI-OS-Hub
bun install

# 2. Build common package
bun run build

# 3. Start desktop app
bun run dev:desktop
```

That's it! The app will open with hot reload enabled.

## Quick Test Commands

```bash
# Run automated tests (detects your platform)
npm run test:desktop

# Or platform-specific:
npm run test:desktop:windows  # Windows
npm run test:desktop:macos    # macOS

# Build production installer
bun run build:desktop
```

## Testing Features Manually

Open the app and press F12 (Windows/Linux) or Cmd+Option+I (macOS) to open DevTools.

### Test System Detection

```javascript
// Check your system
const info = await window.__TAURI__.core.invoke('check_system_requirements');
console.log(info);
```

### Test Prerequisites

```javascript
// Check what's installed
const prereqs = await window.__TAURI__.core.invoke('check_all_prerequisites');
console.log(prereqs);
```

### Monitor Progress Events

```javascript
// Listen for installation progress
await window.__TAURI__.event.listen('install-progress', (event) => {
  console.log(`Progress: ${event.payload.progress}% - ${event.payload.step}`);
});
```

## Common Issues

### Build Fails

```bash
# Clean and rebuild
cd src-tauri
cargo clean
cargo build
```

### Frontend Not Loading

```bash
# Ensure frontend is built
bun run build
```

### Permission Issues (macOS)

```bash
# Remove quarantine
xattr -cr /Applications/CI-OS-Hub-Desktop.app
```

### WebView2 Missing (Windows)

Download from: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

## Full Documentation

- **Complete Testing Guide**: [TESTING.md](./TESTING.md)
- **API Reference**: [../temp-docs/desktop/api-reference.md](../temp-docs/desktop/api-reference.md)
- **Troubleshooting**: [../temp-docs/desktop/troubleshooting.md](../temp-docs/desktop/troubleshooting.md)

## Automated Test Scripts

### Windows (PowerShell)

```powershell
# Run all tests
.\src-tauri\scripts\test-windows.ps1

# Options:
.\src-tauri\scripts\test-windows.ps1 -Verbose
.\src-tauri\scripts\test-windows.ps1 -SkipBuild
.\src-tauri\scripts\test-windows.ps1 -Feature prerequisites
```

### macOS (Bash)

```bash
# Run all tests
./src-tauri/scripts/test-macos.sh

# Options:
./src-tauri/scripts/test-macos.sh --verbose
./src-tauri/scripts/test-macos.sh --skip-build
./src-tauri/scripts/test-macos.sh --feature system-detection
```

## Development Workflow

```bash
# 1. Make changes to Rust code
cd src-tauri/src

# 2. Hot reload will restart (dev mode)
# Or manually rebuild:
cd ..
cargo build

# 3. Test your changes
bun run dev:desktop

# 4. Run automated tests
npm run test:desktop

# 5. Build installer
bun run build:desktop
```

## Output Locations

After building:

- **Windows**: `src-tauri/target/release/bundle/msi/`
- **macOS**: `src-tauri/target/release/bundle/dmg/`
- **Executable**: `src-tauri/target/release/ci-os-hub-desktop`

## Need Help?

1. Check [TESTING.md](./TESTING.md) for detailed instructions
2. Review [troubleshooting guide](../temp-docs/desktop/troubleshooting.md)
3. Open an issue on GitHub

## Quick Links

- [Tauri Documentation](https://v2.tauri.app)
- [Desktop Implementation Roadmap](../IMPLEMENTATION-ROADMAP.md)
- [Desktop API Reference](../temp-docs/desktop/api-reference.md)
