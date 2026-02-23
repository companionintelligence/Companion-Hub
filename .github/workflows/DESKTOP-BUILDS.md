# GitHub Actions Workflows for Desktop Releases

## Desktop Release Workflow

The `build-desktop-release.yml` workflow automates building and releasing the CI OS Hub Desktop application for all platforms.

### Trigger

The workflow is triggered by:
1. **Git tags**: Push a tag matching `desktop-v*.*.*` (e.g., `desktop-v1.0.0`)
2. **Manual dispatch**: Run manually from GitHub Actions UI

### Builds

The workflow builds for three platforms in parallel:

#### macOS (Universal Binary)
- **Outputs**: 
  - `CI-OS-Hub-Desktop_*_universal.dmg` - Disk image installer
  - `CI-OS-Hub-Desktop_*_universal.app.tar.gz` - Application bundle
- **Architectures**: Intel (x86_64) + Apple Silicon (ARM64) in one binary
- **Runner**: `macos-latest`

#### Windows
- **Outputs**:
  - `CI-OS-Hub-Desktop_*_x64.msi` - Windows Installer (recommended)
  - `CI-OS-Hub-Desktop_*_x64-setup.exe` - NSIS installer
- **Architecture**: x86_64
- **Runner**: `windows-latest`

#### Linux
- **Outputs**:
  - `CI-OS-Hub-Desktop_*_amd64.deb` - Debian/Ubuntu package
  - `CI-OS-Hub-Desktop_*_x86_64.rpm` - RPM package (Fedora/RHEL)
  - `CI-OS-Hub-Desktop_*_x86_64.AppImage` - Universal Linux binary
- **Architecture**: x86_64
- **Runner**: `ubuntu-22.04`

### Release Process

1. **Build Stage**: Each platform builds independently
   - Installs dependencies (Rust, Bun, system libraries)
   - Builds frontend and backend packages
   - Builds Tauri desktop application
   - Creates platform-specific installers
   - Uploads artifacts with retention

2. **Release Stage**: Creates GitHub release
   - Downloads all platform artifacts
   - Generates SHA256 checksums
   - Creates release with all installers
   - Adds installation instructions
   - Marks as prerelease for alpha/beta versions

### Usage

#### Create a Release

```bash
# Create and push a release tag
git tag desktop-v1.0.0
git push origin desktop-v1.0.0

# The workflow will automatically:
# 1. Build for all platforms
# 2. Create installers
# 3. Create GitHub release
# 4. Upload all artifacts
```

#### Manual Trigger

1. Go to Actions → Build Desktop Releases
2. Click "Run workflow"
3. Optionally specify a version
4. Click "Run workflow"

### Versioning

Use semantic versioning with the `desktop-v` prefix:
- **Release**: `desktop-v1.0.0`
- **Beta**: `desktop-v1.0.0-beta.1`
- **Alpha**: `desktop-v1.0.0-alpha.1`

Beta and alpha releases are marked as "prerelease" in GitHub.

### Code Signing

The workflow supports code signing via secrets:
- `TAURI_PRIVATE_KEY`: Private key for signing
- `TAURI_KEY_PASSWORD`: Password for the private key

Configure these in repository settings for production releases.

### Artifacts

Build artifacts are retained for 30 days and can be downloaded from:
- GitHub Actions run page
- GitHub Releases page (after release creation)

### Distribution Channels

The workflow includes a placeholder job for uploading to distribution channels:
- **macOS**: Homebrew Cask
- **Windows**: Chocolatey, winget
- **Linux**: Snapcraft, Flathub, AUR

Extend the `upload-to-distributions` job as needed.

### Troubleshooting

#### Build Failures

**Missing dependencies:**
- Linux: Check apt-get install commands in workflow
- macOS: Usually pre-installed on GitHub runners
- Windows: Usually pre-installed on GitHub runners

**Rust compilation errors:**
- Check Cargo.toml dependencies
- Verify Rust version compatibility
- Check rust-cache action

**Tauri build errors:**
- Verify tauri.conf.json configuration
- Check frontend build output
- Ensure all assets are bundled correctly

#### No Artifacts Generated

Check the "List build artifacts" step output to see what was actually built. The workflow uses `find` commands to locate build outputs.

### Testing

Test the workflow without creating a release:

```bash
# Push to a branch and use workflow_dispatch
git push origin feature/test-builds

# Then manually trigger the workflow
# Artifacts will be uploaded but no release will be created
```

### Resources

- [Tauri v2 Documentation](https://v2.tauri.app)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Desktop Documentation](../../temp-docs/desktop/)
