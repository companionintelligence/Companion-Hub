# API Reference

## Overview

CI OS Hub Desktop exposes Tauri commands that can be called from the frontend JavaScript/TypeScript code. All commands are asynchronous and return Promises.

## Importing

```typescript
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
```

## System Detection Commands

### check_system_requirements()

Checks if the system meets minimum requirements for running CI OS Hub.

**Returns:** `Promise<SystemInfo>`

```typescript
interface SystemInfo {
  os: string;
  os_version: string;
  architecture: string;
  total_memory_gb: number;
  available_disk_space_gb: number;
  cpu_count: number;
  has_virtualization: boolean;
  meets_requirements: boolean;
  warnings: string[];
}
```

**Example:**
```typescript
const info = await invoke('check_system_requirements');
console.log(`OS: ${info.os} ${info.os_version}`);
console.log(`RAM: ${info.total_memory_gb}GB`);
console.log(`Disk: ${info.available_disk_space_gb}GB`);
console.log(`Meets requirements: ${info.meets_requirements}`);

if (info.warnings.length > 0) {
  console.warn('Warnings:', info.warnings);
}
```

## Prerequisite Check Commands

### check_wsl2_installed()

Checks if WSL2 is installed on Windows.

**Platform:** Windows only

**Returns:** `Promise<PrerequisiteStatus>`

```typescript
interface PrerequisiteStatus {
  name: string;
  installed: boolean;
  version: string | null;
  path: string | null;
}
```

**Example:**
```typescript
const wsl2 = await invoke('check_wsl2_installed');
if (wsl2.installed) {
  console.log(`WSL2 version ${wsl2.version} installed`);
} else {
  console.log('WSL2 not installed');
}
```

### check_docker_installed()

Checks if Docker is installed and running.

**Platform:** All platforms

**Returns:** `Promise<PrerequisiteStatus>`

**Example:**
```typescript
const docker = await invoke('check_docker_installed');
if (docker.installed) {
  console.log(`Docker ${docker.version} running at ${docker.path}`);
} else {
  console.log('Docker not found');
}
```

### check_xcode_tools()

Checks if Xcode Command Line Tools are installed.

**Platform:** macOS only

**Returns:** `Promise<PrerequisiteStatus>`

**Example:**
```typescript
const xcode = await invoke('check_xcode_tools');
if (!xcode.installed) {
  console.log('Xcode Command Line Tools not installed');
}
```

### check_homebrew()

Checks if Homebrew is installed.

**Platform:** macOS only

**Returns:** `Promise<PrerequisiteStatus>`

**Example:**
```typescript
const brew = await invoke('check_homebrew');
if (brew.installed) {
  console.log(`Homebrew ${brew.version} at ${brew.path}`);
}
```

### check_colima()

Checks if Colima is installed and running.

**Platform:** macOS only

**Returns:** `Promise<PrerequisiteStatus>`

**Example:**
```typescript
const colima = await invoke('check_colima');
console.log('Colima running:', colima.installed);
```

### check_python_installed()

Checks if Python 3.x is installed.

**Platform:** All platforms

**Returns:** `Promise<PrerequisiteStatus>`

**Example:**
```typescript
const python = await invoke('check_python_installed');
if (python.installed) {
  console.log(`Python ${python.version} at ${python.path}`);
}
```

### check_all_prerequisites()

Checks all relevant prerequisites for the current platform.

**Platform:** All platforms

**Returns:** `Promise<PrerequisiteStatus[]>`

**Example:**
```typescript
const prereqs = await invoke('check_all_prerequisites');
prereqs.forEach(p => {
  console.log(`${p.name}: ${p.installed ? '✓' : '✗'}`);
});
```

## Windows Installation Commands

### install_wsl2(app: AppHandle)

Installs WSL2 and Ubuntu 22.04 on Windows.

**Platform:** Windows only

**Parameters:**
- `app`: AppHandle (for emitting progress events)

**Returns:** `Promise<void>`

**Emits:** `install-progress` events

**Example:**
```typescript
import { getCurrentWindow } from '@tauri-apps/api/window';

const app = getCurrentWindow();
await invoke('install_wsl2', { app });
```

### check_wsl2_restart_required()

Checks if a system restart is needed after WSL2 installation.

**Platform:** Windows only

**Returns:** `Promise<boolean>`

**Example:**
```typescript
const needsRestart = await invoke('check_wsl2_restart_required');
if (needsRestart) {
  alert('Please restart your computer to complete installation');
}
```

### configure_wsl2_ubuntu(app: AppHandle)

Configures the Ubuntu environment in WSL2.

**Platform:** Windows only

**Parameters:**
- `app`: AppHandle

**Returns:** `Promise<void>`

**Emits:** `install-progress` events

### install_docker_desktop(app: AppHandle)

Downloads and installs Docker Desktop for Windows.

**Platform:** Windows only

**Parameters:**
- `app`: AppHandle

**Returns:** `Promise<void>`

**Emits:** `install-progress` events

### start_docker_desktop()

Starts Docker Desktop and waits for daemon to be ready.

**Platform:** Windows only

**Returns:** `Promise<void>`

**Example:**
```typescript
await invoke('start_docker_desktop');
console.log('Docker is ready');
```

### configure_docker_wsl2()

Configures Docker Desktop to use WSL2 backend.

**Platform:** Windows only

**Returns:** `Promise<void>`

### install_python_wsl2(app: AppHandle)

Installs Python 3.12.1 in WSL2 Ubuntu.

**Platform:** Windows only

**Parameters:**
- `app`: AppHandle

**Returns:** `Promise<void>`

**Emits:** `install-progress` events

### check_python_version_wsl2()

Checks Python version in WSL2.

**Platform:** Windows only

**Returns:** `Promise<string>`

**Example:**
```typescript
const version = await invoke('check_python_version_wsl2');
console.log('Python version:', version);
```

## macOS Installation Commands

### install_homebrew(app: AppHandle)

Installs Homebrew package manager.

**Platform:** macOS only

**Parameters:**
- `app`: AppHandle

**Returns:** `Promise<void>`

**Emits:** `install-progress` events

### update_homebrew()

Updates Homebrew to the latest version.

**Platform:** macOS only

**Returns:** `Promise<void>`

### install_colima(app: AppHandle)

Installs Colima, Lima, Docker CLI, and Docker Compose.

**Platform:** macOS only

**Parameters:**
- `app`: AppHandle

**Returns:** `Promise<void>`

**Emits:** `install-progress` events

### start_colima(app: AppHandle)

Starts Colima with optimized configuration.

**Platform:** macOS only

**Parameters:**
- `app`: AppHandle

**Returns:** `Promise<void>`

**Emits:** `install-progress` events

**Example:**
```typescript
await invoke('start_colima', { app });
```

### stop_colima()

Stops Colima.

**Platform:** macOS only

**Returns:** `Promise<void>`

### restart_colima()

Restarts Colima.

**Platform:** macOS only

**Returns:** `Promise<void>`

### install_python_macos(app: AppHandle)

Installs Python 3.12.1 via Homebrew.

**Platform:** macOS only

**Parameters:**
- `app`: AppHandle

**Returns:** `Promise<void>`

**Emits:** `install-progress` events

### check_python_version_macos()

Checks Python version on macOS.

**Platform:** macOS only

**Returns:** `Promise<string>`

### configure_headless_python()

Configures Python for headless operation (no GUI).

**Platform:** macOS only

**Returns:** `Promise<void>`

## Progress Events

All installation commands emit progress events that can be listened to:

```typescript
import { listen } from '@tauri-apps/api/event';

const unlisten = await listen('install-progress', (event) => {
  const progress = event.payload as InstallProgress;
  console.log(progress.step);
  console.log(`${progress.progress}%`);
  console.log(progress.message);
  console.log(progress.status); // 'Pending' | 'InProgress' | 'Complete' | 'Failed' | 'Skipped'
});

// Later: stop listening
unlisten();
```

**InstallProgress Interface:**
```typescript
interface InstallProgress {
  step: string;           // Current step name
  progress: number;       // 0-100
  status: InstallStatus;  // Current status
  message: string;        // Detailed message
}

type InstallStatus = 
  | 'Pending' 
  | 'InProgress' 
  | 'Complete' 
  | 'Failed' 
  | 'Skipped';
```

## Complete Installation Example

```typescript
import { invoke, listen } from '@tauri-apps/api';
import { getCurrentWindow } from '@tauri-apps/api/window';

async function installDependencies() {
  const app = getCurrentWindow();
  
  // Listen for progress
  const unlisten = await listen('install-progress', (event) => {
    const { step, progress, status, message } = event.payload;
    updateUI(step, progress, status, message);
  });
  
  try {
    // Check system
    const systemInfo = await invoke('check_system_requirements');
    if (!systemInfo.meets_requirements) {
      throw new Error('System does not meet requirements');
    }
    
    // Check what's needed
    const prereqs = await invoke('check_all_prerequisites');
    const needsWSL2 = !prereqs.find(p => p.name === 'WSL2')?.installed;
    const needsDocker = !prereqs.find(p => p.name === 'Docker')?.installed;
    
    // Install as needed
    if (window.navigator.platform.includes('Win')) {
      if (needsWSL2) {
        await invoke('install_wsl2', { app });
        
        const needsRestart = await invoke('check_wsl2_restart_required');
        if (needsRestart) {
          promptRestart();
          return;
        }
        
        await invoke('configure_wsl2_ubuntu', { app });
      }
      
      if (needsDocker) {
        await invoke('install_docker_desktop', { app });
        await invoke('start_docker_desktop');
      }
      
      await invoke('install_python_wsl2', { app });
    } else if (window.navigator.platform.includes('Mac')) {
      await invoke('install_homebrew', { app });
      await invoke('install_colima', { app });
      await invoke('start_colima', { app });
      await invoke('install_python_macos', { app });
      await invoke('configure_headless_python');
    }
    
    console.log('Installation complete!');
  } catch (error) {
    console.error('Installation failed:', error);
  } finally {
    unlisten();
  }
}
```

## Error Handling

All commands return Promises that reject with error messages:

```typescript
try {
  await invoke('install_wsl2', { app });
} catch (error) {
  // error is a string with the error message
  console.error('Installation failed:', error);
  showErrorDialog(error);
}
```

## Next Steps

- [Windows Automation](./windows-automation.md) - Windows-specific guide
- [macOS Automation](./macos-automation.md) - macOS-specific guide
- [Troubleshooting](./troubleshooting.md) - Common issues
