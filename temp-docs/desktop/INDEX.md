# CI OS Hub Desktop Documentation

This directory contains comprehensive documentation for the CI OS Hub Desktop application and its automated installation features.

## Documentation Files

### Core Documentation

- **[README.md](./README.md)** - Overview and introduction to CI OS Hub Desktop
- **[installation.md](./installation.md)** - Detailed installation guide for all platforms
- **[requirements.md](./requirements.md)** - System requirements and hardware specs

### Platform-Specific Guides

- **[windows-automation.md](./windows-automation.md)** - Windows WSL2, Docker, and Python automation
- **[macos-automation.md](./macos-automation.md)** - macOS Homebrew, Colima, and Python automation

### Technical Documentation

- **[api-reference.md](./api-reference.md)** - Complete API reference for all Tauri commands
- **[troubleshooting.md](./troubleshooting.md)** - Troubleshooting guide and common issues

## Quick Links

### For Users

1. **Getting Started**: Start with [README.md](./README.md)
2. **Check Requirements**: See [requirements.md](./requirements.md)
3. **Install**: Follow [installation.md](./installation.md)
4. **Platform Guide**: 
   - Windows: [windows-automation.md](./windows-automation.md)
   - macOS: [macos-automation.md](./macos-automation.md)
5. **Problems?**: Check [troubleshooting.md](./troubleshooting.md)

### For Developers

1. **API Reference**: [api-reference.md](./api-reference.md)
2. **Source Code**: `/src-tauri/src/`
3. **Build Commands**: 
   - Development: `bun run dev:desktop`
   - Production: `bun run build:desktop`

## Features Covered

### Automated Installation
- ✅ System capability detection
- ✅ Prerequisite checking
- ✅ Windows WSL2 automation
- ✅ Windows Docker Desktop installation
- ✅ macOS Homebrew installation
- ✅ macOS Colima/Docker setup
- ✅ Python 3.12.1 environment setup
- ✅ Progress tracking and error handling

### Platform Support
- ✅ Windows 10/11 (WSL2 backend)
- ✅ macOS Intel (x86_64)
- ✅ macOS Apple Silicon (ARM64)
- ✅ Linux (AppImage, Deb)

### Technical Details
- ✅ 25+ Tauri commands
- ✅ Real-time progress events
- ✅ Error handling and recovery
- ✅ Architecture detection
- ✅ Resource optimization

## Integration with CI OS Hub Docs

These documentation files are intended to be integrated into the main CI OS Hub documentation system at:
- **Website**: https://docs.ci.computer
- **Repository**: https://github.com/companionintelligence/CI-OS-Hub-docs

### Recommended Documentation Structure

```
docs.ci.computer/
├── getting-started/
│   └── desktop-app.md          (from README.md)
├── installation/
│   ├── desktop-windows.md      (from installation.md + windows-automation.md)
│   ├── desktop-macos.md        (from installation.md + macos-automation.md)
│   └── desktop-linux.md        (from installation.md)
├── reference/
│   ├── system-requirements.md  (from requirements.md)
│   └── desktop-api.md          (from api-reference.md)
└── troubleshooting/
    └── desktop.md              (from troubleshooting.md)
```

## Documentation Standards

All documentation follows these standards:

- **Markdown Format**: CommonMark compatible
- **Code Examples**: Syntax-highlighted with language tags
- **Platform Tags**: Clearly marked Windows/macOS/Linux specific sections
- **Command Line**: Copy-paste ready command examples
- **Cross-References**: Internal links to related documentation
- **User-Focused**: Written for end users, not just developers

## Maintenance

These docs are temporary/staging files intended for integration into the main docs system. Once integrated:

1. Main source of truth will be the CI-OS-Hub-docs repository
2. These files can remain as reference documentation in the main repo
3. Updates should be synchronized between repos

## Contributing

When updating documentation:

1. Keep language clear and concise
2. Test all code examples
3. Include platform-specific notes
4. Add troubleshooting entries for new issues
5. Update API reference for new commands
6. Maintain consistent formatting

## Feedback

For documentation feedback:
- **Issues**: https://github.com/companionintelligence/CI-OS-Hub/issues
- **Docs Repo**: https://github.com/companionintelligence/CI-OS-Hub-docs
- **Email**: docs@ci.computer
