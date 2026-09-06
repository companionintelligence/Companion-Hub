//! Tests for the `installers` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn windows_docker_desktop_download_url_matches_build_architecture() {
    let url = docker_desktop_windows_download_url();

    if cfg!(target_arch = "aarch64") {
        assert_eq!(
            url,
            "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe"
        );
    } else {
        assert_eq!(
            url,
            "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
        );
    }
}

#[test]
fn windows_installer_script_uses_unique_temp_download_and_validates_signature() {
    let script = docker_desktop_windows_install_script(
        "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
    );

    assert!(script.contains("GetTempFileName()"));
    assert!(script.contains("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"));
    assert!(script.contains("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature"));
    assert!(script.contains("Get-CompanionHubAuthenticodeSignature $installer"));
    assert!(script.contains("net.exe localgroup docker-users \"$AppUser\" /add"));
    assert!(!script.contains("CompanionHub-DockerDesktopInstaller.exe"));
    assert!(!script.contains("cmd /c"));
}

#[test]
fn macos_installer_script_verifies_downloaded_app_signature() {
    let script = docker_desktop_macos_install_script(
        "https://desktop.docker.com/mac/main/arm64/Docker.dmg",
        "hex",
    );

    assert!(script.contains("spctl --assess --type open --verbose=2"));
    assert!(script.contains("codesign --verify --deep --strict --verbose=2"));
    assert!(script.contains("spctl --assess --type execute --verbose=2"));
    assert!(script.contains("--user=\"hex\""));
}

#[test]
fn ollama_windows_installer_script_validates_signature_and_runs_silently() {
    let script = ollama_windows_install_script("https://ollama.com/download/OllamaSetup.exe");

    assert!(script.contains("GetTempFileName()"));
    assert!(script.contains("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"));
    assert!(script.contains("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature"));
    assert!(script.contains("Get-CompanionHubAuthenticodeSignature $installer"));
    assert!(script.contains("-notmatch 'Ollama'"));
    assert!(script.contains("'/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES'"));
    // Per-user Inno Setup installer — must never request elevation.
    assert!(!script.contains("RunAs"));
    assert!(!script.contains("-Verb"));
}

#[test]
fn ollama_macos_installer_script_verifies_app_signature_and_installs_cli() {
    let script = ollama_macos_install_script("https://ollama.com/download/Ollama-darwin.zip");

    assert!(script.contains("codesign --verify --deep --strict --verbose=2"));
    assert!(script.contains("spctl --assess --type execute --verbose=2"));
    assert!(script.contains("ditto"));
    assert!(script.contains("/Applications/Ollama.app"));
    assert!(script.contains(
        "ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama"
    ));
}

#[test]
fn colima_binary_install_script_verifies_checksums_and_layout() {
    let script = colima_macos_binary_install_script();

    // colima sha256 + lima SHA256SUMS verification are non-negotiable.
    assert!(script.contains("shasum -a 256 -c"));
    assert!(script.contains("colima.sha256sum"));
    assert!(script.contains("SHA256SUMS"));
    // The lima tarball must be extracted whole — limactl resolves
    // ../share/lima relative to its own binary.
    assert!(script.contains("tar -xzf lima.tar.gz -C /usr/local"));
    assert!(script.contains("releases/latest/download/colima-Darwin-"));
    assert!(script.contains("download.docker.com/mac/static/stable"));
}

#[test]
fn colima_start_script_never_runs_brew_as_root_and_waits_for_engine() {
    let script = colima_macos_start_script();

    // brew refuses root; this script must not contain any elevation.
    assert!(!script.contains("sudo"));
    assert!(!script.contains("osascript"));
    assert!(script.contains(r#""$BREW" install colima docker"#));
    assert!(script.contains(r#""$BREW" services start colima"#));
    assert!(script.contains("LaunchAgents/com.companionhub.colima.plist"));
    // Success must mean a working engine, not just installed binaries.
    assert!(script.contains("docker info"));
}

#[test]
fn wsl2_engine_elevated_script_only_does_admin_work() {
    let script = wsl2_engine_elevated_script();

    // Exit-code contract shared with the Docker Desktop installer: enable WSL
    // then ask for a reboot.
    assert!(script.contains("exit 100"));
    assert!(script.contains("--no-distribution"));
    // UTF-16 output guard for wsl --status parsing.
    assert!(script.contains("WSL_UTF8"));
    // Architecture-aware docker CLI download into Program Files (the only
    // admin-requiring filesystem write).
    assert!(script.contains("PROCESSOR_ARCHITECTURE"));
    assert!(script.contains("aarch64"));
    assert!(script.contains("docker.exe"));
    assert!(script.contains("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"));
    assert!(script.contains("Get-CompanionHubAuthenticodeSignature $extractedExe"));

    // Per-user state must NOT be created in the elevated phase — that is the
    // core fix (it would otherwise land in the wrong profile under
    // over-the-shoulder UAC).
    assert!(!script.contains("context create wsl-engine"));
    assert!(!script.contains("GetFolderPath('Startup')"));
    assert!(!script.contains("--install -d Ubuntu"));
}

#[cfg(any(test, target_os = "windows"))]
#[test]
fn wsl2_engine_user_script_owns_per_user_state_and_avoids_daemon_json_hosts() {
    let script = wsl2_engine_user_script();

    // Distro registration happens in the user phase so the distro is owned by
    // the logged-in user.
    assert!(script.contains("--install -d Ubuntu --no-launch"));
    // Dynamic Ubuntu variant selection: handles Ubuntu-22.04, Ubuntu-24.04, etc.
    assert!(script.contains("-match '^Ubuntu-'"));
    // UTF-16 output guard for wsl -l parsing.
    assert!(script.contains("WSL_UTF8"));
    // TCP exposure must be a systemd drop-in, not daemon.json "hosts"
    // (which conflicts with Ubuntu's -H fd:// unit).
    assert!(script.contains("docker.service.d"));
    assert!(script.contains("-H fd:// -H tcp://127.0.0.1:2375"));
    assert!(!script.contains("\"hosts\""));
    // Per-user context routing (no env vars) + logon keepalive — generated in
    // the non-elevated phase so they land in the real user's profile.
    assert!(script.contains("context create wsl-engine"));
    assert!(script.contains("GetFolderPath('Startup')"));
    assert!(script.contains("sleep infinity"));
    // Must restart only the target distro, not every running WSL distro.
    assert!(script.contains("--terminate $distro"));
    assert!(!script.contains("--shutdown"));
    // Systemd boot check before the docker-info poll loop.
    assert!(script.contains("is-system-running"));
}

#[test]
fn docker_desktop_outer_launch_has_stop_on_error_preference() {
    let cmd = docker_desktop_windows_outer_launch_command(
        "C:\\Users\\test\\AppData\\Local\\Temp\\install.ps1",
        "testuser",
    );
    assert!(cmd.starts_with("$ErrorActionPreference = 'Stop';"));
    assert!(cmd.contains("-Verb RunAs"));
    assert!(cmd.contains("exit $process.ExitCode"));
    // Username must appear in the -AppUser argument.
    assert!(cmd.contains("testuser"));
}

#[test]
fn ollama_linux_installer_script_uses_official_installer_and_handles_deps() {
    let script = ollama_linux_install_script();

    assert!(script.contains("https://ollama.com/install.sh"));
    // The official installer hard-requires curl and zstd.
    assert!(script.contains("command -v curl"));
    assert!(script.contains("command -v zstd"));
    // apt's --no-install-recommends curl can't do HTTPS without this.
    assert!(script.contains("curl ca-certificates"));
    // Dep install must cover the major package-manager families.
    for pm in ["apt-get", "dnf", "yum", "pacman", "zypper", "apk"] {
        assert!(script.contains(pm), "missing package manager: {}", pm);
    }
    // Group add is best-effort and gated on group existence (no-systemd hosts).
    assert!(script.contains("getent group ollama"));
    assert!(script.contains(r#"usermod -aG ollama "$USERNAME""#));
    // Linux desktop installs should repair the default localhost-only bind.
    assert!(script.contains("ollama.service.d/override.conf"));
    assert!(script.contains(r#"Environment="OLLAMA_HOST=0.0.0.0:11434""#));
    assert!(script.contains("systemctl daemon-reload"));
}
