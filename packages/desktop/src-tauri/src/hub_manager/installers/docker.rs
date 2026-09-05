//! Docker Desktop / Engine installation per platform.

use crate::hub_manager::*;

#[allow(unused_imports)]
use super::*;

pub fn install_docker() -> Result<DockerInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_docker_linux().map(|detail| DockerInstallResult {
            // Linux always needs a logout/login for docker group membership to take effect.
            state: DockerInstallState::NeedsRestart,
            detail: Some(detail),
        });
    }

    #[cfg(target_os = "windows")]
    {
        return install_docker_windows();
    }

    #[cfg(target_os = "macos")]
    {
        return install_docker_macos();
    }

    #[allow(unreachable_code)]
    Err("Docker installation is not supported on this platform".to_string())
}

#[cfg(any(test, target_os = "windows"))]
pub(crate) fn powershell_authenticode_helper() -> &'static str {
    r#"function Get-CompanionHubAuthenticodeSignature {
    param([Parameter(Mandatory=$true)][string]$Path)
    try {
        Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
        return Microsoft.PowerShell.Security\Get-AuthenticodeSignature -FilePath $Path -ErrorAction Stop
    } catch {
        throw "Windows PowerShell could not load Microsoft.PowerShell.Security for Authenticode validation: $($_.Exception.Message)"
    }
}
"#
}

#[cfg(any(test, target_os = "windows"))]
pub(crate) fn docker_desktop_windows_install_script(download_url: &str) -> String {
    format!(
        r#"param([string]$AppUser)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
{authenticode_helper}
& wsl --status | Out-Null
if ($LASTEXITCODE -ne 0) {{
  & wsl --install --no-distribution
  exit 100
}}
$installer = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.exe')
Remove-Item $installer -Force -ErrorAction SilentlyContinue
try {{
  Invoke-WebRequest -UseBasicParsing -Uri '{download_url}' -OutFile $installer
    $signature = Get-CompanionHubAuthenticodeSignature $installer
  if ($signature.Status -ne 'Valid') {{
    throw "Downloaded Docker Desktop installer signature validation failed: $($signature.Status)"
  }}
  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'Docker') {{
    throw "Downloaded Docker Desktop installer signer was not recognized as Docker."
  }}
  $installProcess = Start-Process -Wait -PassThru -FilePath $installer -ArgumentList 'install','--quiet','--accept-license','--backend=wsl-2','--always-run-service'
  if ($installProcess.ExitCode -ne 0) {{
    exit $installProcess.ExitCode
  }}
  $groupResult = & net.exe localgroup docker-users "$AppUser" /add 2>&1
  if ($LASTEXITCODE -ne 0) {{
    $groupText = ($groupResult | Out-String)
    if ($groupText -notmatch 'already a member') {{
      throw "Failed to add user to docker-users: $groupText"
    }}
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

#[cfg(any(target_os = "windows", test))]
pub(crate) fn docker_desktop_windows_outer_launch_command(
    script_path: &str,
    username: &str,
) -> String {
    // The -File path and -AppUser value are wrapped in embedded double quotes
    // because Start-Process flattens -ArgumentList into a command line without
    // re-quoting elements, so a path or username containing spaces would
    // otherwise break the inner invocation.
    format!(
        "$ErrorActionPreference = 'Stop'; $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','\"{}\"','-AppUser','\"{}\"'); exit $process.ExitCode",
        escape_powershell_single_quoted(script_path),
        escape_powershell_single_quoted(username),
    )
}

#[cfg(target_os = "windows")]
fn install_docker_windows() -> Result<DockerInstallResult, String> {
    use std::io::Write as IoWrite;

    let username = resolve_current_username_windows()?;
    // PowerShell -File refuses scripts without a .ps1 extension.
    let mut script = tempfile::Builder::new()
        .suffix(".ps1")
        .tempfile()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(
            docker_desktop_windows_install_script(docker_desktop_windows_download_url()).as_bytes(),
        )
        .map_err(|e| format!("Failed to write Windows installer script: {}", e))?;
    // Close our writable handle before executing: on Windows, PowerShell cannot
    // run a .ps1 still held open by this process. into_temp_path() keeps the file
    // on disk and deletes it on drop.
    let script_path = script.into_temp_path();

    let launch_command =
        docker_desktop_windows_outer_launch_command(&script_path.to_string_lossy(), &username);

    let mut command = Command::new("powershell.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &launch_command,
        ])
        .output()
        .map_err(|e| format!("Failed to launch elevated Docker Desktop installer: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let combined = if !stderr.is_empty() && !stdout.is_empty() {
        format!("{}\n{}", stderr, stdout)
    } else if !stderr.is_empty() {
        stderr.clone()
    } else {
        stdout.clone()
    };
    let combined_lower = combined.to_lowercase();

    match output.status.code() {
        Some(0) => {
            let _ = launch_docker_desktop_windows();
            Ok(DockerInstallResult {
                state: DockerInstallState::Completed,
                detail: Some(
                    "Docker Desktop installation completed. Waiting for Docker to become ready."
                        .to_string(),
                ),
            })
        }

        Some(100) => Ok(DockerInstallResult {
            state: DockerInstallState::NeedsRestart,
            detail: Some(
                "WSL was installed or enabled. Restart Windows, then reopen Companion Hub to continue Docker setup."
                    .to_string(),
            ),
        }),
        _ if combined_lower.contains("cancel") && combined_lower.contains("user") => {
            Err("Authorization was cancelled or denied.".to_string())
        }
        _ if combined.is_empty() => Err(format!(
            "Docker Desktop installation failed with exit code {:?}.",
            output.status.code()
        )),
        _ => Err(format!("Docker Desktop installation failed: {}", combined)),
    }
}

#[cfg(any(test, target_os = "windows"))]
pub(crate) fn docker_desktop_windows_download_url() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        DOCKER_DESKTOP_WINDOWS_ARM_INSTALLER_URL
    } else {
        DOCKER_DESKTOP_WINDOWS_INTEL_INSTALLER_URL
    }
}

#[cfg(target_os = "windows")]
fn resolve_current_username_windows() -> Result<String, String> {
    if let Ok(username) = std::env::var("USERNAME") {
        let username = username.trim();
        if !username.is_empty() {
            return Ok(username.to_string());
        }
    }

    let mut command = Command::new("whoami");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|e| format!("Failed to resolve current username: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to resolve current username: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let username = String::from_utf8_lossy(&output.stdout)
        .trim()
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_string();
    if username.is_empty() {
        Err("Failed to resolve current username.".to_string())
    } else {
        Ok(username)
    }
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn launch_docker_desktop_windows() -> Result<(), String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for env_var in ["ProgramFiles", "ProgramW6432"] {
        if let Ok(root) = std::env::var(env_var) {
            candidates.push(
                Path::new(&root)
                    .join("Docker")
                    .join("Docker")
                    .join("Docker Desktop.exe"),
            );
        }
    }

    let app = candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            "Docker Desktop was installed, but the app launcher could not be found.".to_string()
        })?;

    let mut command = Command::new(app);
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch Docker Desktop: {}", e))
}

#[cfg(any(test, target_os = "macos"))]
pub(crate) fn docker_desktop_macos_install_script(download_url: &str, username: &str) -> String {
    format!(
        r#"#!/bin/bash
set -euo pipefail
workdir="$(mktemp -d)"
cleanup() {{
  if mount | grep -q "$workdir/mnt"; then
    hdiutil detach "$workdir/mnt" -quiet || true
  fi
  rm -rf "$workdir"
}}
trap cleanup EXIT

dmg="$workdir/Docker.dmg"
mount_dir="$workdir/mnt"
mkdir -p "$mount_dir"
curl -L --fail -o "$dmg" "{download_url}"
spctl --assess --type open --verbose=2 "$dmg"
hdiutil attach "$dmg" -mountpoint "$mount_dir" -nobrowse -quiet
codesign --verify --deep --strict --verbose=2 "$mount_dir/Docker.app"
spctl --assess --type execute --verbose=2 "$mount_dir/Docker.app"
"$mount_dir/Docker.app/Contents/MacOS/install" --accept-license --user="{username}"
"#,
        download_url = download_url,
        username = username,
    )
}

#[cfg(target_os = "macos")]
fn install_docker_macos() -> Result<DockerInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let username = resolve_current_username_macos()?;
    let mut script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(
            docker_desktop_macos_install_script(docker_desktop_macos_download_url(), &username)
                .as_bytes(),
        )
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
        .map_err(|e| format!("Failed to launch elevated Docker Desktop installer: {}", e))?;

    if output.status.success() {
        let _ = launch_docker_desktop_macos();
        Ok(DockerInstallResult {
            state: DockerInstallState::Completed,
            detail: Some(
                "Docker Desktop installation completed. Waiting for Docker to become ready."
                    .to_string(),
            ),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = if !stderr.is_empty() && !stdout.is_empty() {
            format!("{}\n{}", stderr, stdout)
        } else if !stderr.is_empty() {
            stderr
        } else {
            stdout
        };
        let combined_lower = combined.to_lowercase();

        if combined_lower.contains("cancel") && combined_lower.contains("user") {
            Err("Authorization was cancelled or denied.".to_string())
        } else if combined.is_empty() {
            Err("Docker Desktop installation failed.".to_string())
        } else {
            Err(format!("Docker Desktop installation failed: {}", combined))
        }
    }
}

#[cfg(target_os = "macos")]
fn docker_desktop_macos_download_url() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        DOCKER_DESKTOP_MACOS_ARM_URL
    } else {
        DOCKER_DESKTOP_MACOS_INTEL_URL
    }
}

#[cfg(target_os = "macos")]
fn resolve_current_username_macos() -> Result<String, String> {
    if let Ok(username) = std::env::var("USER") {
        let username = username.trim();
        if !username.is_empty() {
            return Ok(username.to_string());
        }
    }

    let output = Command::new("id")
        .args(["-un"])
        .output()
        .map_err(|e| format!("Failed to resolve current username: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to resolve current username: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if username.is_empty() {
        Err("Failed to resolve current username.".to_string())
    } else {
        Ok(username)
    }
}

#[cfg(target_os = "macos")]
fn launch_docker_desktop_macos() -> Result<(), String> {
    Command::new("open")
        .args(["-a", "Docker"])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch Docker Desktop: {}", e))
}

/// Install Docker Engine on Linux.
///
/// Detects the distro from /etc/os-release and picks the right package manager:
///   - Arch-based (Arch, Manjaro, EndeavourOS, Garuda): pacman
///   - Alpine: apk + OpenRC
///   - SUSE-based (openSUSE Leap/Tumbleweed, SLES): zypper
///   - RHEL: official Docker dnf repo (get.docker.com doesn't support RHEL)
///   - Everything else (Debian, Ubuntu, Raspberry Pi OS, Fedora, CentOS, Rocky, etc.):
///     Docker's official get.docker.com convenience script; auto-installs curl/wget
///     if neither is present.
///
/// Adds the current user to the docker group and enables the Docker service via
/// systemd or OpenRC as available. Uses pkexec (polkit) for the GUI privilege prompt.
#[cfg(target_os = "linux")]
pub fn install_docker_linux() -> Result<String, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let username = resolve_current_username()?;
    let pkexec_path = find_executable("pkexec").ok_or_else(|| {
        "pkexec is not installed or not on PATH. Install polkit/pkexec and try again.".to_string()
    })?;

    let mut wrapper_script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary install script: {}", e))?;
    wrapper_script
        .write_all(
            br#"#!/bin/bash
# Docker auto-installer for Companion Hub. Runs as root via pkexec.
# Arg 1: username to add to the docker group.
set -e
export DEBIAN_FRONTEND=noninteractive
USERNAME="$1"

# -- Distro detection ---------------------------------------------------------
DISTRO_ID="unknown"
DISTRO_LIKE=""
if [ -f /etc/os-release ]; then
    DISTRO_ID="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
    DISTRO_LIKE="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
fi

# True if ID equals $1 OR ID_LIKE contains $1 as a whitespace-delimited word.
is_distro() {
    [ "$DISTRO_ID" = "$1" ] && return 0
    case " $DISTRO_LIKE " in *" $1 "*) return 0;; esac
    return 1
}

# -- Init-system: enable + start docker --------------------------------------
enable_and_start_docker() {
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        systemctl enable docker
        systemctl start docker
    elif command -v rc-update >/dev/null 2>&1; then
        rc-update add docker boot || true
        rc-service docker start || true
    elif command -v service >/dev/null 2>&1; then
        service docker start || true
    fi
}

# -- Download helper: curl then wget ------------------------------------------
download_to() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$2" "$1"
    else
        return 1
    fi
}

# -- Per-distro install -------------------------------------------------------

if is_distro arch || is_distro manjaro || is_distro endeavouros || is_distro garuda; then
    pacman -Sy --noconfirm docker docker-compose
    enable_and_start_docker

elif is_distro alpine; then
    apk add --no-cache docker docker-cli-compose
    rc-update add docker boot 2>/dev/null || true
    rc-service docker start 2>/dev/null || true

elif is_distro suse || is_distro opensuse-leap || is_distro opensuse-tumbleweed || is_distro sles; then
    zypper --non-interactive install docker docker-compose
    enable_and_start_docker

elif [ "$DISTRO_ID" = "rhel" ]; then
    # Only true RHEL (ID=rhel): get.docker.com does not support it; use the Docker dnf repo.
    # Rocky Linux, AlmaLinux, CentOS (all have ID_LIKE containing "rhel") are handled by
    # get.docker.com below -- do NOT use is_distro here or they fall into this branch.
    dnf install -y dnf-plugins-core
    # dnf 5 (RHEL 9+) syntax vs dnf 4 (RHEL 8) syntax
    if ! dnf config-manager addrepo \
            --from-repofile https://download.docker.com/linux/rhel/docker-ce.repo 2>/dev/null; then
        dnf config-manager --add-repo \
            https://download.docker.com/linux/rhel/docker-ce.repo
    fi
    dnf install -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    enable_and_start_docker

else
    # Debian, Ubuntu, Raspberry Pi OS, Fedora, CentOS, Rocky Linux, and others.
    # Docker's official convenience script handles all of these.

    # Ensure a downloader is available; install curl if neither curl nor wget is
    # present. ca-certificates rides along: apt treats it as a Recommends, so
    # --no-install-recommends curl alone cannot do HTTPS (curl error 77).
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
            apt-get install -y --no-install-recommends curl ca-certificates
        elif command -v dnf >/dev/null 2>&1; then
            dnf install -y curl ca-certificates
        elif command -v yum >/dev/null 2>&1; then
            yum install -y curl ca-certificates
        else
            printf 'Error: curl/wget not found and could not be installed automatically.\n' >&2
            printf 'Install curl first, then retry.\n' >&2
            exit 1
        fi
    fi

    installer_script="$(mktemp)"
    trap 'rm -f "$installer_script"' EXIT
    download_to https://get.docker.com "$installer_script" \
        || { printf 'Error: failed to download Docker installer from get.docker.com\n' >&2; exit 1; }
    sh "$installer_script"
    enable_and_start_docker
fi

# -- Add user to the docker group (common to all distros) --------------------
if getent group docker >/dev/null 2>&1; then
    usermod -aG docker "$USERNAME"
fi
"#,
        )
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
        Ok("Docker installed successfully. You may need to log out and back in for group changes to take effect.".to_string())
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
                "Docker installation failed with exit code {:?}.",
                output.status.code()
            ))
        } else {
            Err(format!("Docker installation failed: {}", combined))
        }
    }
}
