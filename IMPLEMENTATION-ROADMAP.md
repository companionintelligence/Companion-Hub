# Implementation Roadmap: Companion Intelligences Hub Desktop

## Current Status: Foundation Complete ✅

The Tauri v2 desktop shell is implemented with:
- Cross-platform window management
- Build pipeline for Windows/macOS/Linux
- Configuration structure
- Basic Rust commands framework

## Required Implementation (Priority Order)

### Phase 1: System Detection & Prerequisites (Week 1-2)

#### 1.1 System Capability Detection
**File**: `src-tauri/src/system/detection.rs`

```rust
#[tauri::command]
async fn check_system_requirements() -> Result<SystemInfo, String> {
    // Detect OS, version, architecture
    // Check virtualization support (VT-x/AMD-V)
    // Verify available disk space (10GB+)
    // Check RAM (4GB minimum, 8GB recommended)
    // Return compatibility report
}
```

#### 1.2 Prerequisite Checks
**File**: `src-tauri/src/system/prerequisites.rs`

```rust
// Windows
#[tauri::command]
async fn check_wsl2_installed() -> Result<bool, String>

#[tauri::command]
async fn check_docker_installed() -> Result<bool, String>

// macOS
#[tauri::command]
async fn check_xcode_tools() -> Result<bool, String>

#[tauri::command]
async fn check_homebrew() -> Result<bool, String>
```

### Phase 2: Installation Automation - Windows (Week 3-4)

#### 2.1 WSL2 Installation
**File**: `src-tauri/src/installers/windows/wsl.rs`

```rust
#[tauri::command]
async fn install_wsl2(progress_callback: Channel) -> Result<(), String> {
    // 1. Enable Windows features (via PowerShell)
    //    - Microsoft-Windows-Subsystem-Linux
    //    - VirtualMachinePlatform
    // 2. Download WSL2 kernel update
    // 3. Set WSL2 as default
    // 4. Install Ubuntu 22.04
    // 5. Configure Ubuntu environment
    // Send progress updates via callback
}
```

#### 2.2 Docker Desktop Installation
**File**: `src-tauri/src/installers/windows/docker.rs`

```rust
#[tauri::command]
async fn install_docker_desktop(progress_callback: Channel) -> Result<(), String> {
    // 1. Download Docker Desktop installer
    // 2. Run silent install
    // 3. Configure Docker to use WSL2 backend
    // 4. Start Docker service
    // 5. Verify installation
}
```

#### 2.3 Python Environment Setup
**File**: `src-tauri/src/installers/windows/python.rs`

```rust
#[tauri::command]
async fn setup_python_environment() -> Result<(), String> {
    // 1. Download Python 3.12.1 installer
    // 2. Install in WSL Ubuntu
    // 3. Create virtual environment
    // 4. Install pip and dependencies
    // 5. Configure PATH
}
```

### Phase 3: Installation Automation - macOS (Week 5-6)

#### 3.1 Homebrew Setup
**File**: `src-tauri/src/installers/macos/homebrew.rs`

```rust
#[tauri::command]
async fn install_homebrew() -> Result<(), String> {
    // Check if Homebrew exists
    // If not, download and install
    // Update Homebrew
}
```

#### 3.2 Colima/Lima Installation
**File**: `src-tauri/src/installers/macos/colima.rs`

```rust
#[tauri::command]
async fn install_colima(progress_callback: Channel) -> Result<(), String> {
    // 1. brew install colima
    // 2. brew install lima
    // 3. brew install docker
    // 4. Start Colima with proper configuration
    // 5. Configure Docker client
}
```

#### 3.3 Python Setup (Headless)
**File**: `src-tauri/src/installers/macos/python.rs`

```rust
#[tauri::command]
async fn setup_headless_python() -> Result<(), String> {
    // 1. Download Python 3.12.1 (headless build)
    // 2. Install in user directory (not system)
    // 3. Patch to prevent GUI dependencies
    // 4. Create virtual environment
    // 5. Install dependencies
}
```

### Phase 4: Hub Deployment (Week 7)

#### 4.1 Download Hub Core
**File**: `src-tauri/src/installers/hub.rs`

```rust
#[tauri::command]
async fn download_hub_core(version: String) -> Result<String, String> {
    // Download latest CI OS Hub Python core
    // From: https://releases.ci.computer/hub/latest
    // Extract to application directory
    // Return installation path
}
```

#### 4.2 Configure Hub
**File**: `src-tauri/src/installers/hub.rs`

```rust
#[tauri::command]
async fn configure_hub(install_path: String) -> Result<(), String> {
    // Set up configuration files
    // Configure database connection
    // Set up Docker network
    // Initialize storage directories
}
```

#### 4.3 Start Services
**File**: `src-tauri/src/services/lifecycle.rs`

```rust
#[tauri::command]
async fn start_hub_services() -> Result<(), String> {
    // Start PostgreSQL container
    // Start RabbitMQ container
    // Start backend API
    // Start frontend server
    // Wait for health checks
}
```

### Phase 5: Process Management (Week 8)

#### 5.1 Background Service Manager
**File**: `src-tauri/src/services/manager.rs`

```rust
#[tauri::command]
async fn get_service_status() -> Result<Vec<ServiceStatus>, String>

#[tauri::command]
async fn restart_service(service_name: String) -> Result<(), String>

#[tauri::command]
async fn stop_all_services() -> Result<(), String>
```

#### 5.2 Health Monitoring
**File**: `src-tauri/src/services/monitor.rs`

```rust
// Background task that runs every 30 seconds
async fn monitor_services() {
    // Check database health
    // Check queue health
    // Check API health
    // Send notifications to UI
    // Auto-restart on failure
}
```

#### 5.3 Port Management
**File**: `src-tauri/src/services/ports.rs`

```rust
#[tauri::command]
async fn check_port_available(port: u16) -> Result<bool, String>

#[tauri::command]
async fn configure_port(port: u16) -> Result<(), String>
```

### Phase 6: Installation Wizard UI (Week 9-10)

#### 6.1 Frontend Components
**Location**: `packages/frontend/src/routes/desktop/`

Components needed:
- `WelcomeScreen.tsx` - Initial greeting and system check
- `PrerequisitesCheck.tsx` - Display system requirements
- `InstallationProgress.tsx` - Progress bars for each step
- `ConfigurationScreen.tsx` - Port, storage settings
- `CompletionScreen.tsx` - Success message and launch button

#### 6.2 State Management
**File**: `packages/frontend/src/stores/installation.ts`

```typescript
interface InstallationState {
  currentStep: number;
  progress: number;
  status: 'idle' | 'checking' | 'installing' | 'complete' | 'error';
  logs: string[];
  systemInfo: SystemInfo;
}
```

#### 6.3 Tauri Integration
Connect UI to Rust commands via `@tauri-apps/api/core`

### Phase 7: Cloud Instance Management (Week 11)

#### 7.1 Connection Management
**File**: `src-tauri/src/cloud/connection.rs`

```rust
#[tauri::command]
async fn connect_cloud_instance(url: String, token: String) -> Result<InstanceInfo, String>

#[tauri::command]
async fn disconnect_instance(instance_id: String) -> Result<(), String>

#[tauri::command]
async fn list_instances() -> Result<Vec<InstanceInfo>, String>
```

#### 7.2 Instance Switching
**File**: `src-tauri/src/cloud/switcher.rs`

```rust
#[tauri::command]
async fn switch_to_instance(instance_id: String) -> Result<(), String> {
    // Update configuration
    // Reload frontend with new API endpoint
    // Update system tray menu
}
```

### Phase 8: System Tray Enhancement (Week 12)

#### 8.1 Enhanced Tray Menu
**File**: `src-tauri/src/tray.rs`

```rust
fn create_system_tray() -> SystemTray {
    // Dynamic menu based on state:
    // - Show/Hide Window
    // - Service Status (with indicators)
    // - Instance Switcher (submenu)
    // - Quick Actions (Restart services, etc.)
    // - Settings
    // - Quit
}
```

#### 8.2 Notifications
**File**: `src-tauri/src/notifications.rs`

```rust
#[tauri::command]
async fn show_notification(title: String, message: String, urgency: String)

// Use for:
// - Installation complete
// - Service failures
// - Update available
```

### Phase 9: Update System (Week 13)

#### 9.1 Desktop App Updates
Already configured in `tauri.conf.json`:
- Endpoint: `https://releases.ci.computer/desktop/`
- Need to implement signing and release process

#### 9.2 Hub Core Updates
**File**: `src-tauri/src/updater/hub.rs`

```rust
#[tauri::command]
async fn check_hub_updates() -> Result<UpdateInfo, String>

#[tauri::command]
async fn update_hub(version: String) -> Result<(), String> {
    // Create backup
    // Download new version
    // Stop services
    // Replace files
    // Run migrations
    // Restart services
}
```

### Phase 10: Testing & Polish (Week 14-15)

#### 10.1 Platform Testing
- Test full installation on clean Windows 10/11
- Test full installation on Intel Mac
- Test full installation on Apple Silicon Mac
- Test upgrade scenarios
- Test error recovery

#### 10.2 Documentation
- User guide for installation
- Troubleshooting guide
- Developer documentation
- API reference

## Dependencies Required

### Rust Crates
```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon", "notification", "process", "shell"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["json", "stream"] }
tar = "0.4"
flate2 = "1.0"
zip = "0.6"
which = "6.0"
indicatif = "0.17"

# Windows-specific
[target.'cfg(windows)'.dependencies]
winapi = { version = "0.3", features = ["winuser", "shellapi"] }
windows = "0.58"

# macOS-specific
[target.'cfg(target_os = "macos")'.dependencies]
cocoa = "0.25"
objc = "0.2"
```

### Frontend Dependencies
Already available in the project

## Storage Structure

```
Windows: %APPDATA%\computer.ci.app\hub\
macOS: ~/Library/Application Support/computer.ci.app/hub/

├── config/
│   ├── hub.conf          # Hub configuration
│   ├── instances.json    # Cloud instances
│   └── settings.json     # Desktop app settings
├── data/
│   ├── apps/             # Installed apps
│   ├── media/            # User uploads
│   └── backups/          # Automatic backups
├── logs/
│   ├── desktop.log       # Desktop app logs
│   ├── hub.log           # Hub core logs
│   └── services.log      # Service logs
└── cache/
    └── downloads/        # Downloaded installers
```

## Success Criteria

- ✅ User can install on Windows 10/11 without prerequisites
- ✅ User can install on macOS (Intel & Apple Silicon) without prerequisites
- ✅ Installation completes in 10-20 minutes on Windows, 5-10 on macOS
- ✅ Services start automatically after installation
- ✅ User can access Hub via desktop app and browser
- ✅ User can connect to cloud instances
- ✅ Updates work seamlessly
- ✅ Uninstall removes all components cleanly

## Timeline Summary

| Phase | Duration | Deliverable |
|-------|----------|-------------|
| 1 | 2 weeks | System detection |
| 2 | 2 weeks | Windows automation |
| 3 | 2 weeks | macOS automation |
| 4 | 1 week | Hub deployment |
| 5 | 1 week | Process management |
| 6 | 2 weeks | UI wizard |
| 7 | 1 week | Cloud instances |
| 8 | 1 week | System tray |
| 9 | 1 week | Updates |
| 10 | 2 weeks | Testing & polish |
| **Total** | **15 weeks** | **Full implementation** |

## Notes

- This is a complex project requiring deep OS integration
- Each platform has unique challenges and requirements
- Proper error handling and recovery is critical
- User experience should be smooth and informative
- Security considerations must be paramount (admin privileges, credentials)
