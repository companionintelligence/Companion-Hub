# Desktop Testing Scripts

Automated testing scripts for CI OS Hub Desktop application.

## Available Scripts

### test-windows.ps1

PowerShell script for automated Windows testing.

**Usage:**
```powershell
# Run all tests
.\test-windows.ps1

# With options
.\test-windows.ps1 -Verbose                    # Show detailed output
.\test-windows.ps1 -SkipBuild                  # Skip build step
.\test-windows.ps1 -SkipSystemTests            # Skip system detection tests
.\test-windows.ps1 -SkipInstallerTests         # Skip installer tests
.\test-windows.ps1 -Feature prerequisites      # Test specific feature only
```

**Available Features:**
- `prerequisites` - Check Rust, Node/Bun, WebView2
- `build` - Build the application
- `system-detection` - Test system detection commands
- `windows-commands` - Test Windows-specific commands
- `artifacts` - Check build artifacts

**Output:**
- Console output with colored status indicators
- JSON report saved to `test-results-windows.json`

### test-macos.sh

Bash script for automated macOS testing.

**Usage:**
```bash
# Run all tests
./test-macos.sh

# With options
./test-macos.sh --verbose                     # Show detailed output
./test-macos.sh --skip-build                  # Skip build step
./test-macos.sh --skip-system-tests           # Skip system detection tests
./test-macos.sh --skip-installer-tests        # Skip installer tests
./test-macos.sh --feature prerequisites       # Test specific feature only
./test-macos.sh --help                        # Show help
```

**Available Features:**
- `prerequisites` - Check Rust, Node/Bun, Xcode tools
- `build` - Build the application
- `system-detection` - Test system detection commands
- `macos-commands` - Test macOS-specific commands
- `artifacts` - Check build artifacts

**Output:**
- Console output with colored status indicators
- JSON report saved to `test-results-macos.json`

## npm Scripts

You can also run tests via npm/bun from the project root:

```bash
# Auto-detect platform and run appropriate script
npm run test:desktop

# Or specify platform:
npm run test:desktop:windows   # Windows only
npm run test:desktop:macos     # macOS only
```

## What Gets Tested

### Prerequisites Check
- Rust and Cargo installation
- Node.js or Bun installation
- Platform-specific tools (WebView2, Xcode, etc.)
- Architecture detection

### Build Process
- Dependency installation
- Common package build
- Rust application compilation
- Error handling

### System Detection
- Manual verification required (see TESTING.md)
- Tests require running application

### Platform-Specific Commands
- WSL2 detection (Windows)
- Docker detection (all platforms)
- Python detection (all platforms)
- Homebrew detection (macOS)
- Colima detection (macOS)

### Build Artifacts
- Executable location and size
- Installer packages (MSI, DMG)
- App bundles

## Test Results

Both scripts generate JSON reports with test results:

**Format:**
```json
[
  {
    "test": "Rust Installation",
    "status": "Pass",
    "message": "Found: cargo 1.75.0",
    "timestamp": "2024-02-23T05:55:00Z"
  }
]
```

**Status Values:**
- `Pass` - Test passed successfully
- `Fail` - Test failed with error
- `Skip` - Test was skipped

## Continuous Integration

These scripts can be integrated into CI/CD pipelines:

```yaml
# GitHub Actions example
- name: Test Desktop (Windows)
  if: runner.os == 'Windows'
  run: npm run test:desktop:windows

- name: Test Desktop (macOS)
  if: runner.os == 'macOS'
  run: npm run test:desktop:macos
```

## Troubleshooting

### Permission Denied (macOS)

```bash
chmod +x test-macos.sh
```

### Execution Policy Error (Windows)

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Script Not Found

Ensure you're running from the scripts directory or use full paths:

```bash
# From project root
./src-tauri/scripts/test-macos.sh
```

```powershell
# From project root
.\src-tauri\scripts\test-windows.ps1
```

## Contributing

When adding new features to the desktop app:

1. Add corresponding test cases to these scripts
2. Update this README
3. Test on both Windows and macOS
4. Update main [TESTING.md](../TESTING.md) documentation

## Related Documentation

- [TESTING.md](../TESTING.md) - Complete testing guide
- [QUICKSTART.md](../QUICKSTART.md) - Quick start guide
- [API Reference](../../temp-docs/desktop/api-reference.md) - Command documentation
- [Troubleshooting](../../temp-docs/desktop/troubleshooting.md) - Common issues

## Support

For issues with these scripts:
1. Check [TESTING.md](../TESTING.md) troubleshooting section
2. Review script output and JSON reports
3. Open an issue on GitHub with:
   - Platform and version
   - Script output
   - Test results JSON
   - Steps to reproduce
