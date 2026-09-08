//! Ollama installation per platform, including inside a WSL2 distro.

#[allow(unused_imports)]
use super::*;

/// Install Ollama on the current platform.
///
/// - Linux: official install.sh via pkexec (binary to /usr/local, systemd unit,
///   `ollama` system user, NVIDIA/AMD GPU detection — all handled by the script).
/// - macOS: Ollama-darwin.zip (universal binary) verified with codesign/spctl,
///   installed to /Applications with the CLI symlinked, launched hidden.
/// - Windows: OllamaSetup.exe (Inno Setup, per-user — no elevation needed),
///   Authenticode-verified, run with /VERYSILENT; the tray app auto-starts. EXCEPT on
///   a native WSL2 Docker engine, where Ollama is installed inside the distro bound to
///   0.0.0.0:11434 (see `install_ollama_in_wsl_distro`) so the Hub container can reach it.
///
/// The Ollama API listens on 127.0.0.1:11434 on host installs; the WSL2-engine install
/// binds 0.0.0.0:11434 inside the distro instead.
pub fn install_ollama() -> Result<OllamaInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_ollama_linux();
    }

    #[cfg(target_os = "windows")]
    {
        return install_ollama_windows();
    }

    #[cfg(target_os = "macos")]
    {
        return install_ollama_macos();
    }

    #[allow(unreachable_code)]
    Err("Ollama auto-install is not supported on this platform.".to_string())
}

#[cfg(any(test, target_os = "windows"))]
pub(crate) fn ollama_windows_install_script(download_url: &str) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
{authenticode_helper}
$installer = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.exe')
Remove-Item $installer -Force -ErrorAction SilentlyContinue
try {{
  Invoke-WebRequest -UseBasicParsing -Uri '{download_url}' -OutFile $installer
    $signature = Get-CompanionHubAuthenticodeSignature $installer
  if ($signature.Status -ne 'Valid') {{
    throw "Downloaded Ollama installer signature validation failed: $($signature.Status)"
  }}
  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'Ollama') {{
    throw "Downloaded Ollama installer signer was not recognized as Ollama."
  }}
  $installProcess = Start-Process -Wait -PassThru -FilePath $installer -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES'
  if ($installProcess.ExitCode -ne 0) {{
    exit $installProcess.ExitCode
  }}
}} finally {{
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
}}
exit 0
"#,
        authenticode_helper = powershell_authenticode_helper(),
        download_url = download_url,
    )
}

/// Install Ollama inside the WSL2 distro that hosts the native Docker engine, bound to
/// 0.0.0.0 so the Hub container can reach it over the docker0 bridge. Uses Ollama's
/// official install script (sets up the systemd service + GPU detection; Ollama picks
/// up the GPU via the WSL CUDA libraries), then applies the 0.0.0.0 drop-in. Runs as
/// root in the distro (no elevation prompt).
#[cfg(target_os = "windows")]
fn install_ollama_in_wsl_distro() -> Result<OllamaInstallResult, String> {
    let distro = find_wsl_distro().ok_or_else(|| {
        "No Ubuntu/Debian WSL distro was found to install Ollama into.".to_string()
    })?;

    // Download the installer to a file first (checking curl's exit) rather than
    // `curl | sh`: a POSIX `sh` pipeline reports only `sh`'s status, so a failed/partial
    // download would otherwise be treated as a successful install under `set -e`.
    let installed = run_wsl_root_script(
        &distro,
        r#"set -e
export DEBIAN_FRONTEND=noninteractive
command -v curl >/dev/null 2>&1 || { apt-get update && apt-get install -y curl ca-certificates; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
curl -fsSL --connect-timeout 30 --max-time 120 https://ollama.com/install.sh -o "$tmp"
sh "$tmp""#,
    );
    if !installed {
        return Err(format!(
            "Ollama installation inside the WSL2 distro \"{distro}\" failed."
        ));
    }

    // Bind to 0.0.0.0 so the Hub container can reach it, and report the ACTUAL result
    // (installing the binary doesn't guarantee a systemd service was set up + bound).
    let marker = ensure_ollama_listens_on_all_interfaces(&distro);
    let detail = if ollama_bind_marker_is_reachable(marker.as_deref()) {
        format!(
            "Ollama installed inside WSL2 distro \"{distro}\" and bound to 0.0.0.0:11434 so the Hub can reach it."
        )
    } else {
        format!(
            "Ollama installed inside WSL2 distro \"{distro}\", but it isn't bound to 0.0.0.0 yet (is systemd enabled in the distro?). Start Ollama and click Re-check."
        )
    };

    Ok(OllamaInstallResult {
        state: OllamaInstallState::Completed,
        detail: Some(detail),
    })
}

/// OllamaSetup.exe is an Inno Setup installer with PrivilegesRequired=lowest —
/// it installs per-user to %LOCALAPPDATA%\Programs\Ollama, so unlike the Docker
/// installer no elevation is required. The installer adds Ollama to the user
/// PATH and launches the tray app itself. On a native WSL2 Docker engine, Ollama is
/// installed inside the distro instead (see the branch below).
#[cfg(target_os = "windows")]
fn install_ollama_windows() -> Result<OllamaInstallResult, String> {
    use std::io::Write as IoWrite;

    // On a native WSL2 Docker engine, a Windows-host Ollama (127.0.0.1 on Windows) is
    // unreachable from the Hub container. Install Ollama *inside* the distro instead,
    // bound to 0.0.0.0 so the container can reach it over the docker0 bridge — and so
    // it can use the GPU via the WSL CUDA libraries.
    if is_wsl_engine_docker_backend() {
        return install_ollama_in_wsl_distro();
    }

    // PowerShell -File refuses scripts without a .ps1 extension.
    let mut script = tempfile::Builder::new()
        .suffix(".ps1")
        .tempfile()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(ollama_windows_install_script(OLLAMA_WINDOWS_INSTALLER_URL).as_bytes())
        .map_err(|e| format!("Failed to write Windows installer script: {}", e))?;
    // Close our writable handle before executing: on Windows, PowerShell cannot
    // run a .ps1 still held open by this process. into_temp_path() keeps the file
    // on disk and deletes it on drop.
    let script_path = script.into_temp_path();
    let script_path_str = script_path.to_string_lossy();

    let mut command = Command::new("powershell.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path_str,
        ])
        .output()
        .map_err(|e| format!("Failed to launch Ollama installer: {}", e))?;

    if output.status.success() {
        Ok(OllamaInstallResult {
            state: OllamaInstallState::Completed,
            detail: Some(
                "Ollama installed. The API is available at http://127.0.0.1:11434.".to_string(),
            ),
        })
    } else {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        if combined.is_empty() {
            Err(format!(
                "Ollama installation failed with exit code {:?}.",
                output.status.code()
            ))
        } else {
            Err(format!("Ollama installation failed: {}", combined))
        }
    }
}

#[cfg(any(test, target_os = "macos"))]
pub(crate) fn ollama_macos_install_script(download_url: &str) -> String {
    format!(
        r#"#!/bin/bash
set -euo pipefail
workdir="$(mktemp -d)"
cleanup() {{
  rm -rf "$workdir"
}}
trap cleanup EXIT

zip="$workdir/Ollama-darwin.zip"
curl -L --fail -o "$zip" "{download_url}"
ditto -x -k "$zip" "$workdir/extracted"
app="$workdir/extracted/Ollama.app"
test -d "$app"
codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose=2 "$app"
pkill -x Ollama 2>/dev/null || true
rm -rf /Applications/Ollama.app
ditto "$app" /Applications/Ollama.app
mkdir -p /usr/local/bin
ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama
"#,
        download_url = download_url,
    )
}

#[cfg(target_os = "macos")]
fn install_ollama_macos() -> Result<OllamaInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let mut script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(ollama_macos_install_script(OLLAMA_MACOS_ZIP_URL).as_bytes())
        .map_err(|e| format!("Failed to write macOS installer script: {}", e))?;
    script
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Failed to set macOS installer script permissions: {}", e))?;

    let applescript = format!(
        "do shell script quoted form of POSIX path of \"{}\" with administrator privileges",
        script.path().to_string_lossy().replace('"', "\\\"")
    );

    let output = Command::new("osascript")
        .args(["-e", &applescript])
        .output()
        .map_err(|e| format!("Failed to launch elevated Ollama installer: {}", e))?;

    if output.status.success() {
        // Launch as the current user (not root) so the menu-bar app lands in
        // the user session; `hidden` suppresses the first-run window.
        let _ = Command::new("open")
            .args(["-a", "Ollama", "--args", "hidden"])
            .spawn();
        Ok(OllamaInstallResult {
            state: OllamaInstallState::Completed,
            detail: Some(
                "Ollama installed. The API is available at http://127.0.0.1:11434.".to_string(),
            ),
        })
    } else {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        let combined_lower = combined.to_lowercase();

        if combined_lower.contains("cancel") && combined_lower.contains("user") {
            Err("Authorization was cancelled or denied.".to_string())
        } else if combined.is_empty() {
            Err("Ollama installation failed.".to_string())
        } else {
            Err(format!("Ollama installation failed: {}", combined))
        }
    }
}

#[cfg(any(test, target_os = "linux"))]
pub(crate) fn ollama_linux_install_script() -> &'static str {
    // The official installer is distro-agnostic (tarball to /usr/local + systemd
    // unit + GPU detection), so unlike Docker no per-distro branching is needed —
    // only its hard dependencies (curl, zstd) vary by package manager.
    r#"#!/bin/bash
# Ollama auto-installer for Companion Hub. Runs as root via pkexec.
# Arg 1: username to add to the ollama group.
set -e
USERNAME="$1"

# The official installer hard-requires curl and zstd; install whichever are
# missing. ca-certificates rides along with curl: apt treats it as a Recommends,
# so --no-install-recommends curl alone cannot do HTTPS (curl error 77). The
# package name is identical across all six package-manager families.
need=""
command -v curl >/dev/null 2>&1 || need="curl ca-certificates"
command -v zstd >/dev/null 2>&1 || need="$need zstd"
if [ -n "$need" ]; then
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get install -y --no-install-recommends $need \
            || { apt-get update && apt-get install -y --no-install-recommends $need; }
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y $need
    elif command -v yum >/dev/null 2>&1; then
        yum install -y $need
    elif command -v pacman >/dev/null 2>&1; then
        pacman -Sy --noconfirm $need
    elif command -v zypper >/dev/null 2>&1; then
        zypper --non-interactive install $need
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache $need
    else
        printf 'Error: missing required tools (%s) and no known package manager found.\n' "$need" >&2
        exit 1
    fi
fi

installer_script="$(mktemp)"
trap 'rm -f "$installer_script"' EXIT
curl -fsSL https://ollama.com/install.sh -o "$installer_script"
sh "$installer_script"

# Ubuntu/systemd default installs often bind Ollama to loopback only, which
# leaves the Hub container unable to reach it over host.docker.internal. Force
# the service onto all interfaces for the common appliance-on-Linux case.
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files ollama.service >/dev/null 2>&1; then
    install -d -m 0755 /etc/systemd/system/ollama.service.d
    cat >/etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
EOF
    systemctl daemon-reload
    systemctl enable --now ollama || systemctl restart ollama
fi

# Best-effort: the ollama group grants direct model-dir access; the HTTP API
# itself needs no group membership. Without systemd the script skips group
# creation, hence the existence check.
if getent group ollama >/dev/null 2>&1; then
    usermod -aG ollama "$USERNAME" || true
fi
"#
}

/// Install Ollama on Linux via the official install.sh, elevated with pkexec
/// (GUI polkit prompt). The script handles arch detection, the systemd service,
/// and NVIDIA/AMD GPU setup; GPU driver installation can take several minutes.
#[cfg(target_os = "linux")]
pub fn install_ollama_linux() -> Result<OllamaInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let username = resolve_current_username()?;
    let pkexec_path = find_executable("pkexec").ok_or_else(|| {
        "pkexec is not installed or not on PATH. Install polkit/pkexec and try again.".to_string()
    })?;

    let mut wrapper_script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary install script: {}", e))?;
    wrapper_script
        .write_all(ollama_linux_install_script().as_bytes())
        .map_err(|e| format!("Failed to write install script: {}", e))?;

    let permissions = std::fs::Permissions::from_mode(0o700);
    wrapper_script
        .as_file()
        .set_permissions(permissions)
        .map_err(|e| format!("Failed to set install script permissions: {}", e))?;

    let output = Command::new(&pkexec_path)
        .arg(wrapper_script.path())
        .arg(&username)
        .output()
        .map_err(|e| format!("Failed to run pkexec installer: {}", e))?;

    if output.status.success() {
        Ok(OllamaInstallResult {
            state: OllamaInstallState::Completed,
            detail: Some(
                "Ollama installed. The API is available at http://127.0.0.1:11434.".to_string(),
            ),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = format_command_output(&stdout, &stderr);
        let combined_lower = combined.to_lowercase();

        if combined_lower.contains("dismissed")
            || combined_lower.contains("not authorized")
            || combined_lower.contains("authorization required")
            || combined_lower.contains("authentication failed")
        {
            Err("Authorization was cancelled or denied.".to_string())
        } else if combined.is_empty() {
            Err(format!(
                "Ollama installation failed with exit code {:?}.",
                output.status.code()
            ))
        } else {
            Err(format!("Ollama installation failed: {}", combined))
        }
    }
}
