# CI OS Hub Desktop

Native desktop application for Companion Intelligences Hub built with Tauri v2.

## Overview

CI OS Hub Desktop wraps the existing web interface in a native desktop shell, providing:

- Native window management and system tray integration
- Cross-platform support (Windows, macOS, Linux)
- Automatic backend lifecycle management
- Seamless integration with existing CI OS Hub infrastructure

## Architecture

```
┌─────────────────────────────────────┐
│   Tauri Desktop Shell (Rust)        │
│   ├── Window Management              │
│   ├── System Tray                    │
│   └── Backend Process Lifecycle      │
└─────────────────────────────────────┘
         │                    │
         ↓                    ↓
┌──────────────────┐  ┌──────────────────┐
│ Frontend (9091)  │  │ Backend (3000)   │
│ React Router     │←→│ NestJS API       │
└──────────────────┘  └──────────────────┘
```

## Development

### Prerequisites

- Rust 1.70+ (install from https://rustup.rs)
- Bun 1.3.0+ (install from https://bun.sh)
- System dependencies for Tauri:
  - **Linux**: `sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
  - **macOS**: Xcode Command Line Tools
  - **Windows**: WebView2 (usually pre-installed on Windows 11)

### Running in Development

```bash
# Start infrastructure (database, queue)
bun run infra:up

# Run desktop app in dev mode (will start frontend + backend automatically)
bun run dev:desktop
```

The `dev:desktop` command will:
1. Start the frontend dev server on port 9091
2. Start the backend API server on port 3000
3. Launch the Tauri desktop window

### Building for Production

```bash
# Build all packages first
bun run build

# Build desktop application
bun run build:desktop
```

Build outputs will be in `src-tauri/target/release/bundle/`:
- **Windows**: `.msi` and `.exe` installers
- **macOS**: `.dmg` and `.app` bundle
- **Linux**: `.AppImage` and `.deb` packages

## Configuration

Configuration is managed in `src-tauri/tauri.conf.json`:

- **identifier**: `computer.ci.app.hub`
- **productName**: CI OS Hub
- **Development**: Points to `http://localhost:9091` (frontend dev server)
- **Production**: Uses bundled frontend from `packages/frontend/build/client`

## Features

### Current

- Native desktop window with proper decorations
- System tray integration (minimize to tray)
- Frontend/backend integration via localhost
- Cross-platform builds
- Auto-updater infrastructure

### Planned (Future Enhancements)

Based on the Companion Intelligences Hub Desktop specification:

1. **Automated Installation**
   - Windows: WSL2, Docker, Ubuntu 22.04 setup
   - macOS: Colima, Lima, Docker setup
   - Python 3.12.1 environment management

2. **System Management**
   - Dependency resolution and installation
   - Process monitoring and auto-recovery
   - Background service management

3. **User Experience**
   - Installation wizard with progress indicators
   - One-click local instance setup
   - Cloud instance connection and management
   - Status monitoring in system tray

4. **Security & Isolation**
   - Sandboxed container environment
   - Privilege management (request admin only when needed)
   - Secure credential handling

## Commands

Available Tauri commands (callable from frontend):

- `get_system_info`: Returns OS, family, and architecture information
- `check_backend_status`: Health check for backend API at localhost:3000

## Storage Locations

- **Windows**: `%APPDATA%\computer.ci.app\hub`
- **macOS**: `~/Library/Application Support/computer.ci.app/hub`
- **Linux**: `~/.local/share/computer.ci.app/hub`

## Technical Details

### Frontend Integration

The desktop app serves the existing React Router frontend. In development, it proxies to the Vite dev server. In production, it serves static files from the build output.

### Backend Integration

The backend NestJS server runs on localhost:3000. The desktop app doesn't manage the backend process yet - this is planned for future enhancement.

### Permissions

Required permissions are configured in `tauri.conf.json`:
- File system access (for configuration and data)
- Network access (for backend communication)
- Process management (for future backend lifecycle management)

## Troubleshooting

### Development Issues

**Frontend not loading**: Ensure `bun run dev:app` is running or the dev server is accessible on port 9091

**Backend errors**: Check that the backend is running on port 3000 and database/queue services are up

**Build failures**: Ensure all prerequisites are installed and Rust toolchain is up to date

### Platform-Specific

**Windows**: May require enabling Developer Mode or WSL2 for full functionality

**macOS**: Requires Xcode Command Line Tools and may prompt for security permissions

**Linux**: Requires WebKit2GTK and related dependencies

## Contributing

When adding new features:

1. Add Rust commands in `src-tauri/src/main.rs`
2. Update frontend integration in frontend packages
3. Update configuration in `tauri.conf.json` if needed
4. Test on all target platforms before committing

## Resources

- [Tauri Documentation](https://v2.tauri.app)
- [CI OS Hub Main Repository](https://github.com/companionintelligence/CI-OS-Hub)
- [Companion Intelligence Website](https://ci.computer)
