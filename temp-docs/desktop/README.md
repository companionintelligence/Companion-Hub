# CI OS Hub Desktop Application

## Overview

CI OS Hub Desktop is a native desktop application that provides a seamless experience for running and managing Companion Intelligences Hub on Windows, macOS, and Linux. Built with Tauri v2, it combines the power of the web-based CI OS Hub with native desktop capabilities including automated system setup and dependency management.

## Key Features

### Cross-Platform Support
- **Windows 10/11**: Full support with WSL2 automation
- **macOS**: Intel and Apple Silicon support
- **Linux**: AppImage and Deb packages

### Automated Installation
The desktop application can automatically install and configure all required dependencies:

- **Windows**: WSL2, Docker Desktop, Ubuntu 22.04, Python 3.12.x
- **macOS**: Homebrew, Colima, Lima, Docker, Python 3.12.x
- **All Platforms**: Virtual environments, development tools

### Native Integration
- System tray icon with quick actions
- Native window management
- Background service management
- Automatic updates

## Architecture

```
┌─────────────────────────────────────────────────┐
│   Tauri Desktop Shell (Rust)                    │
│   ├── System Detection                          │
│   ├── Automated Installers                      │
│   ├── Process Management                        │
│   └── Native UI Integration                     │
└─────────────────────────────────────────────────┘
         │                    │
         ↓                    ↓
┌──────────────────┐  ┌──────────────────┐
│ Frontend (9091)  │  │ Backend (3000)   │
│ React Router     │←→│ NestJS API       │
└──────────────────┘  └──────────────────┘
```

## Quick Start

1. **Download**: Get the latest installer from [ci.computer/install](https://ci.computer/install)
2. **Install**: Run the installer for your platform
3. **Setup**: Follow the automated setup wizard
4. **Launch**: Access CI OS Hub from the desktop application

## Getting Help

- [Installation Guide](./installation.md) - Detailed installation instructions
- [System Requirements](./requirements.md) - Hardware and software requirements
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
- [API Reference](./api-reference.md) - Developer documentation

## Platform-Specific Guides

- [Windows Automation](./windows-automation.md) - WSL2, Docker, and Python setup
- [macOS Automation](./macos-automation.md) - Homebrew, Colima, and Python setup

## Links

- **Website**: [ci.computer](https://ci.computer)
- **Documentation**: [docs.ci.computer](https://docs.ci.computer)
- **GitHub**: [companionintelligence/CI-OS-Hub](https://github.com/companionintelligence/CI-OS-Hub)
