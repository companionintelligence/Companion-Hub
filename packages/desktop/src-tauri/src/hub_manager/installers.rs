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
fn powershell_authenticode_helper() -> &'static str {
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
fn escape_powershell_single_quoted(value: &str) -> String {
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

#[cfg(target_os = "linux")]
fn resolve_current_username() -> Result<String, String> {
    let output = Command::new("id")
        .args(["-un"])
        .output()
        .map_err(|e| format!("Failed to resolve current username: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to resolve current username: {}",
            format_command_output(
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr)
            )
        ));
    }

    let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if username.is_empty() {
        Err("Failed to resolve current username from current UID.".to_string())
    } else {
        Ok(username)
    }
}

#[cfg(target_os = "linux")]
fn find_executable(binary: &str) -> Option<PathBuf> {
    Command::new("which")
        .arg(binary)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(PathBuf::from(path))
            }
        })
}

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

#[cfg(target_os = "linux")]
fn rocm_probe_path(data_dir: &Path) -> PathBuf {
    data_dir.join("state/hardware/rocm.json")
}

#[cfg(target_os = "linux")]
fn rocm_install_state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("state/hardware/rocm-install.json")
}

#[cfg(target_os = "linux")]
fn write_rocm_install_state(data_dir: &Path, phase: &str, message: &str) {
    let path = rocm_install_state_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = serde_json::json!({
        "phase": phase,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
        "message": message,
    });
    if let Ok(serialized) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(path, format!("{}\n", serialized));
    }
}

/// Refresh the host ROCm probe cache (`state/hardware/rocm.json`) on Linux.
pub fn refresh_rocm_host_probe_cache(data_dir: &Path) {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = data_dir;
        return;
    }

    #[cfg(target_os = "linux")]
    {
        let probe_path = rocm_probe_path(data_dir);
        if let Some(parent) = probe_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let has_kfd = Path::new("/dev/kfd").exists() && Path::new("/dev/dri").exists();
        let source = if has_kfd {
            "host-dev-kfd"
        } else {
            let smi = Command::new("sh")
                .arg("-lc")
                .arg("rocm-smi --version")
                .output();
            match smi {
                Ok(output) if output.status.success() => {
                    let stdout_raw = String::from_utf8_lossy(&output.stdout);
                    let stdout = stdout_raw.trim();
                    if !stdout.is_empty() {
                        let payload = serde_json::json!({
                            "available": false,
                            "source": "host-rocm-smi",
                            "updatedAt": chrono::Utc::now().to_rfc3339(),
                            "message": "ROCm drivers detected but /dev/kfd is not ready yet. Restart may be required.",
                        });
                        if let Ok(serialized) = serde_json::to_string_pretty(&payload) {
                            let _ = std::fs::write(&probe_path, format!("{}\n", serialized));
                            let _ = append_desktop_log_for(
                                data_dir,
                                "gpu.probe",
                                &format!(
                                    "Updated host ROCm probe cache at {} (drivers present, /dev/kfd missing)",
                                    probe_path.display()
                                ),
                            );
                        }
                        return;
                    }
                }
                _ => {}
            }
            "host-dev-kfd"
        };

        let available = has_kfd;
        let payload = serde_json::json!({
            "available": available,
            "source": source,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        });
        if let Ok(serialized) = serde_json::to_string_pretty(&payload) {
            let _ = std::fs::write(&probe_path, format!("{}\n", serialized));
            let _ = append_desktop_log_for(
                data_dir,
                "gpu.probe",
                &format!(
                    "Updated host ROCm probe cache at {} (available={})",
                    probe_path.display(),
                    available
                ),
            );
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RocmInstallState {
    RebootRequired,
    Completed,
    Failed,
}

#[derive(Clone, serde::Serialize)]
pub struct RocmInstallResult {
    pub state: RocmInstallState,
    pub detail: Option<String>,
}

/// Install ROCm on Ubuntu via pkexec-elevated AMDGPU installer script.
pub fn install_rocm() -> Result<RocmInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_rocm_linux();
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("ROCm auto-install is only supported on Linux.".to_string())
    }
}

/// Re-probe host ROCm devices and refresh install state after reboot.
pub fn verify_rocm_probe() -> Result<RocmInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        let data_dir = get_hub_data_dir();
        refresh_rocm_host_probe_cache(&data_dir);

        let has_kfd = Path::new("/dev/kfd").exists() && Path::new("/dev/dri").exists();
        if has_kfd {
            write_rocm_install_state(&data_dir, "completed", "ROCm is ready.");
            return Ok(RocmInstallResult {
                state: RocmInstallState::Completed,
                detail: Some("ROCm is available on the host.".to_string()),
            });
        }

        write_rocm_install_state(
            &data_dir,
            "reboot_required",
            "Restart your computer, reopen Companion Hub, then verify again.",
        );
        Ok(RocmInstallResult {
            state: RocmInstallState::RebootRequired,
            detail: Some(
                "ROCm is not ready yet. Restart your computer if you recently installed drivers."
                    .to_string(),
            ),
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("ROCm verification is only supported on Linux.".to_string())
    }
}

#[cfg(any(test, target_os = "linux"))]
pub(crate) fn rocm_linux_install_script() -> &'static str {
    r#"#!/bin/bash
# ROCm auto-installer for Companion Hub. Runs as root via pkexec.
# Arg 1: username to add to render/video groups.
# Arg 2: Hub state directory (…/companion-hub/state).
set -euo pipefail
USERNAME="$1"
STATE_DIR="$2"
HARDWARE_DIR="${STATE_DIR}/hardware"
mkdir -p "$HARDWARE_DIR"

write_state() {
  phase="$1"
  msg="$2"
  cat > "${HARDWARE_DIR}/rocm-install.json" <<EOF
{
  "phase": "$phase",
  "updatedAt": "$(date -Iseconds)",
  "message": "$msg"
}
EOF
}

write_state "downloading" "Downloading AMDGPU installer…"

. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "Error: ROCm auto-install is only supported on Ubuntu." >&2
  write_state "failed" "Unsupported operating system"
  exit 1
fi

case "${VERSION_ID:-}" in
  22.04) CODENAME=jammy ;;
  24.04|26.04) CODENAME=noble ;;
  *)
    echo "Error: Unsupported Ubuntu version ${VERSION_ID}. Use 22.04, 24.04, or 26.04." >&2
    write_state "failed" "Unsupported Ubuntu version"
    exit 1
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
write_state "installing" "Installing ROCm packages…"

apt-get update
apt-get install -y wget gpg curl ca-certificates \
  "linux-headers-$(uname -r)" 2>/dev/null \
  || apt-get install -y wget gpg curl ca-certificates linux-headers-generic

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
BASE_URL="https://repo.radeon.com/amdgpu-install/latest/ubuntu/${CODENAME}"
DEB="$(curl -fsSL "${BASE_URL}/" | grep -oE 'amdgpu-install_[0-9][^"]+_all\.deb' | head -1 || true)"
if [ -z "$DEB" ]; then
  echo "Error: Could not find amdgpu-install package for Ubuntu ${VERSION_ID} (${CODENAME})." >&2
  write_state "failed" "Could not find AMDGPU installer package"
  exit 1
fi

curl -fsSL "${BASE_URL}/${DEB}" -o "$WORKDIR/amdgpu-install.deb"
apt-get install -y "$WORKDIR/amdgpu-install.deb"
amdgpu-install -y --usecase=rocm

for grp in render video; do
  if getent group "$grp" >/dev/null 2>&1; then
    usermod -aG "$grp" "$USERNAME" || true
  fi
done

cat > "${HARDWARE_DIR}/rocm.json" <<EOF
{
  "available": false,
  "source": "host-dev-kfd",
  "updatedAt": "$(date -Iseconds)"
}
EOF

write_state "reboot_required" "Restart your computer to finish ROCm setup."
echo "ROCm installation complete. A system restart is required."
"#
}

#[cfg(target_os = "linux")]
fn install_rocm_linux() -> Result<RocmInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let data_dir = get_hub_data_dir();
    let state_dir = data_dir.join("state");
    let username = resolve_current_username()?;
    let pkexec_path = find_executable("pkexec").ok_or_else(|| {
        "pkexec is not installed or not on PATH. Install polkit/pkexec and try again.".to_string()
    })?;

    write_rocm_install_state(&data_dir, "downloading", "Downloading AMDGPU installer…");
    let _ = append_desktop_log_for(
        &data_dir,
        "rocm.install",
        "Starting ROCm installation via pkexec",
    );

    let mut wrapper_script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary install script: {}", e))?;
    wrapper_script
        .write_all(rocm_linux_install_script().as_bytes())
        .map_err(|e| format!("Failed to write install script: {}", e))?;

    let permissions = std::fs::Permissions::from_mode(0o700);
    wrapper_script
        .as_file()
        .set_permissions(permissions)
        .map_err(|e| format!("Failed to set install script permissions: {}", e))?;

    let output = Command::new(&pkexec_path)
        .arg(wrapper_script.path())
        .arg(&username)
        .arg(state_dir)
        .output()
        .map_err(|e| format!("Failed to run pkexec ROCm installer: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = format_command_output(&stdout, &stderr);
    let _ = append_desktop_log_for(
        &data_dir,
        "rocm.install",
        &truncate_command_output(&combined),
    );

    if output.status.success() {
        write_rocm_install_state(
            &data_dir,
            "reboot_required",
            "Restart your computer to finish ROCm setup.",
        );
        Ok(RocmInstallResult {
            state: RocmInstallState::RebootRequired,
            detail: Some(
                "ROCm packages installed. Restart your computer, reopen Hub, then click Verify."
                    .to_string(),
            ),
        })
    } else {
        write_rocm_install_state(&data_dir, "failed", "ROCm installation failed");
        let combined_lower = combined.to_lowercase();

        if combined_lower.contains("dismissed")
            || combined_lower.contains("not authorized")
            || combined_lower.contains("authorization required")
            || combined_lower.contains("authentication failed")
        {
            Err("Authorization was cancelled or denied.".to_string())
        } else if combined.is_empty() {
            Err(format!(
                "ROCm installation failed with exit code {:?}.",
                output.status.code()
            ))
        } else {
            Err(format!("ROCm installation failed: {}", combined))
        }
    }
}

/// Install a licensing-free Docker engine. Docker Desktop requires a paid
/// subscription for organizations with >250 employees or >$10M revenue; these
/// paths run the open-source Docker Engine instead:
///   - macOS: Colima (Engine in a lightweight vz VM). Homebrew when present,
///     otherwise verified binaries (colima + lima + docker CLI) into /usr/local.
///   - Windows: Docker Engine inside WSL2 (Ubuntu), TCP-exposed on
///     127.0.0.1:2375 with a docker context — no Docker Desktop involved.
///   - Linux: the standard Engine install (already licensing-free).
pub fn install_docker_engine_alternative() -> Result<DockerInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_docker_linux().map(|detail| DockerInstallResult {
            state: DockerInstallState::NeedsRestart,
            detail: Some(detail),
        });
    }

    #[cfg(target_os = "macos")]
    {
        return install_colima_macos();
    }

    #[cfg(target_os = "windows")]
    {
        return install_docker_wsl2_windows();
    }

    #[allow(unreachable_code)]
    Err("No licensing-free engine path is available on this platform.".to_string())
}

/// Elevated phase of the no-Homebrew Colima install: place colima, lima, and
/// the docker CLI under /usr/local. Checksums are verified for colima (per-asset
/// .sha256sum) and lima (release SHA256SUMS); Docker's static CLI publishes no
/// checksums, so it relies on TLS like the get.docker.com path.
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn colima_macos_binary_install_script() -> &'static str {
    r#"#!/bin/bash
set -euo pipefail
workdir="$(mktemp -d)"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT
cd "$workdir"

ARCH="$(uname -m)"   # arm64 | x86_64
case "$ARCH" in
  arm64) DOCKER_ARCH_DIR="aarch64" ;;
  x86_64) DOCKER_ARCH_DIR="x86_64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# colima: version-less asset names, so latest/download is stable; verify sha256.
curl -fsSL -o colima "https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-${ARCH}"
curl -fsSL -o colima.sha256sum "https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-${ARCH}.sha256sum"
# The published file references the asset name; check against our local name.
expected="$(awk '{print $1}' colima.sha256sum)"
echo "${expected}  colima" | shasum -a 256 -c -
install -m 0755 colima /usr/local/bin/colima

# lima: asset names embed the version; resolve the tag from the GitHub API.
LIMA_TAG="$(curl -fsSL https://api.github.com/repos/lima-vm/lima/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
test -n "$LIMA_TAG"
LIMA_VERSION="${LIMA_TAG#v}"
curl -fsSL -o lima.tar.gz "https://github.com/lima-vm/lima/releases/download/${LIMA_TAG}/lima-${LIMA_VERSION}-Darwin-${ARCH}.tar.gz"
curl -fsSL -o lima-SHA256SUMS "https://github.com/lima-vm/lima/releases/download/${LIMA_TAG}/SHA256SUMS"
grep "lima-${LIMA_VERSION}-Darwin-${ARCH}.tar.gz" lima-SHA256SUMS | awk '{print $1}' | { read -r sum; echo "${sum}  lima.tar.gz" | shasum -a 256 -c -; }
# Extract the whole tarball to one prefix: limactl resolves ../share/lima
# (guest agents, templates) relative to its own binary.
tar -xzf lima.tar.gz -C /usr/local

# docker CLI (static, client-only): no latest pointer — scrape the index.
DOCKER_TGZ="$(curl -fsSL "https://download.docker.com/mac/static/stable/${DOCKER_ARCH_DIR}/" | grep -o 'docker-[0-9][0-9.]*\.tgz' | sort -uV | tail -1)"
test -n "$DOCKER_TGZ"
curl -fsSL -o docker.tgz "https://download.docker.com/mac/static/stable/${DOCKER_ARCH_DIR}/${DOCKER_TGZ}"
tar -xzf docker.tgz
install -m 0755 docker/docker /usr/local/bin/docker
"#
}

/// User phase of the Colima install (never root — brew refuses it, and the VM
/// must belong to the user). Installs via Homebrew when available; otherwise
/// assumes the binary phase already ran, registers a LaunchAgent for autostart,
/// and waits until `docker info` answers (first start downloads a ~350 MB VM
/// image, so the ceiling is generous).
#[cfg(any(test, target_os = "macos"))]
pub(crate) fn colima_macos_start_script() -> &'static str {
    r#"#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

BREW=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [ -x "$candidate" ]; then BREW="$candidate"; break; fi
done

if [ -n "$BREW" ]; then
  "$BREW" install colima docker
  "$BREW" services start colima
else
  # Binary install path: autostart via a per-user LaunchAgent.
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$HOME/Library/LaunchAgents/com.companionhub.colima.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.companionhub.colima</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/colima</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
  launchctl unload "$HOME/Library/LaunchAgents/com.companionhub.colima.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/com.companionhub.colima.plist"
fi

# First start downloads the VM image (~350 MB); wait until the engine answers.
for _ in $(seq 1 120); do
  if docker info >/dev/null 2>&1; then exit 0; fi
  sleep 5
done
echo "Timed out waiting for the Colima engine to come up." >&2
exit 1
"#
}

#[cfg(target_os = "macos")]
fn install_colima_macos() -> Result<DockerInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let brew_present = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .any(|p| Path::new(p).exists());

    // Without Homebrew the binaries must be placed under /usr/local first —
    // the only step that needs admin rights.
    if !brew_present {
        let mut script = NamedTempFile::new()
            .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
        script
            .write_all(colima_macos_binary_install_script().as_bytes())
            .map_err(|e| format!("Failed to write Colima installer script: {}", e))?;
        script
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed to set installer script permissions: {}", e))?;

        let applescript = format!(
            "do shell script quoted form of POSIX path of \"{}\" with administrator privileges",
            script.path().to_string_lossy().replace('"', "\\\"")
        );
        let output = Command::new("osascript")
            .args(["-e", &applescript])
            .output()
            .map_err(|e| format!("Failed to launch elevated Colima installer: {}", e))?;
        if !output.status.success() {
            let combined = format_command_output(
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr),
            );
            let combined_lower = combined.to_lowercase();
            if combined_lower.contains("cancel") && combined_lower.contains("user") {
                return Err("Authorization was cancelled or denied.".to_string());
            }
            return Err(format!("Colima binary installation failed: {}", combined));
        }
    }

    // Brew install, autostart registration, colima start, and the readiness
    // wait all run as the user — never root.
    let mut start_script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary start script: {}", e))?;
    start_script
        .write_all(colima_macos_start_script().as_bytes())
        .map_err(|e| format!("Failed to write Colima start script: {}", e))?;
    start_script
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Failed to set start script permissions: {}", e))?;

    let output = Command::new("bash")
        .arg(start_script.path())
        .output()
        .map_err(|e| format!("Failed to run Colima start script: {}", e))?;

    if output.status.success() {
        Ok(DockerInstallResult {
            state: DockerInstallState::Completed,
            detail: Some(
                "Colima installed and the Docker Engine is running (context \"colima\")."
                    .to_string(),
            ),
        })
    } else {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        if combined.is_empty() {
            Err("Colima installation failed.".to_string())
        } else {
            Err(format!("Colima installation failed: {}", combined))
        }
    }
}

/// Windows: Docker Engine inside WSL2, no Docker Desktop.
///
/// The install is split across two PowerShell scripts so that only the steps
/// that genuinely need Windows admin run elevated, and everything that is
/// inherently per-user runs as the logged-in user. This matters because:
///   - WSL distros, the docker context (`~/.docker`) and the Startup keepalive
///     are all per-user; if they were created by an elevated *other* admin
///     account (over-the-shoulder UAC) the Hub — running as the real user —
///     would never see them, so `docker info` would keep failing after a
///     "successful" install.
///   - The Colima path on macOS already uses this elevated-then-user split.
///
/// Exit code contract for the **elevated** script matches the Docker Desktop
/// installer: 100 = WSL was just enabled and Windows must reboot (NeedsRestart);
/// 0 = elevated work done. The **user** script returns 0 once the engine is
/// reachable.
///
/// Design notes (all verified against MS Learn / Docker docs):
///   - `wsl --install -d Ubuntu --no-launch` registers Ubuntu without the
///     interactive first-run user creation; `wsl -u root` works without it.
///     Once the WSL platform is enabled, adding/running a distro is per-user and
///     does not require Windows admin.
///   - Ubuntu's docker-ce systemd unit uses `-H fd://`, which conflicts with a
///     daemon.json `hosts` key — TCP exposure needs a systemd drop-in instead.
///   - WSL2 localhost forwarding makes tcp://127.0.0.1:2375 reachable from
///     Windows, but only while the distro runs — and systemd services do NOT
///     keep the VM alive, hence the hidden `sleep infinity` keepalive in the
///     user's Startup folder.
///   - docker.exe goes where find_docker_binary() already looks, and a docker
///     context (stored in ~/.docker, read at runtime) points it at the TCP
///     endpoint — no env vars, so the running Hub needs no restart.

/// Elevated phase: the only two operations that require Windows admin — enabling
/// the WSL platform (reboot via exit 100 the first time) and writing the static
/// docker CLI into Program Files where `find_docker_binary()` looks.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn wsl2_engine_elevated_script() -> String {
    format!(
        "{}{}",
        powershell_authenticode_helper(),
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:WSL_UTF8 = '1'

# Phase 1: WSL platform itself (admin + reboot when absent). The status probe is
# allowed to fail (WSL absent) — relax briefly so its non-zero exit doesn't become
# a terminating error under Stop, then restore Stop for the download cmdlets below.
$ErrorActionPreference = 'Continue'
& wsl.exe --status | Out-Null
$wslPresent = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = 'Stop'
if (-not $wslPresent) {
  & wsl.exe --install --no-distribution
  exit 100
}

# Phase 2: static docker CLI where the Hub already looks for it (Program Files
# needs admin to write). Idempotent: skip when docker.exe is already present.
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
# Prefer ProgramW6432 (the 64-bit root even under 32-bit/WOW64 PowerShell) so the
# CLI lands where the 64-bit Hub's find_docker_binary() looks.
$programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$dockerBin = Join-Path $programFiles 'Docker\Docker\resources\bin'
if (-not (Test-Path (Join-Path $dockerBin 'docker.exe'))) {
  $index = (Invoke-WebRequest -UseBasicParsing -Uri "https://download.docker.com/win/static/stable/$arch/").Content
  $zips = @([regex]::Matches($index, 'docker-[0-9][0-9.]*\.zip') | ForEach-Object { $_.Value } | Sort-Object { [version]($_ -replace 'docker-|\.zip', '') })
  if ($zips.Count -eq 0) { throw 'Could not determine the latest static docker CLI version.' }
  $latest = $zips[-1]
  $zipPath = Join-Path $Env:TEMP $latest
  $extract = Join-Path $Env:TEMP 'companionhub-docker-cli'
  Invoke-WebRequest -UseBasicParsing -Uri "https://download.docker.com/win/static/stable/$arch/$latest" -OutFile $zipPath
  try {
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zipPath -DestinationPath $extract
    # Validate authenticity beyond TLS, matching the Docker Desktop installer.
    $extractedExe = Join-Path $extract 'docker\docker.exe'
    $signature = Get-CompanionHubAuthenticodeSignature $extractedExe
    if ($signature.Status -ne 'Valid') {
      throw "Downloaded docker CLI signature validation failed: $($signature.Status)"
    }
    if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'Docker') {
      throw "Downloaded docker CLI signer was not recognized as Docker."
    }
    New-Item -ItemType Directory -Force -Path $dockerBin | Out-Null
    Copy-Item $extractedExe (Join-Path $dockerBin 'docker.exe') -Force
  } finally {
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
  }
}
exit 0
"#
    )
}

/// User phase: runs non-elevated as the logged-in user so all per-user state
/// (distro registration, docker context, Startup keepalive) lands in the real
/// profile. Assumes the elevated phase already enabled WSL and placed docker.exe.
#[cfg(any(test, target_os = "windows"))]
pub(crate) fn wsl2_engine_user_script() -> String {
    let linux_setup = r#"set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v dockerd >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi
printf '[boot]\nsystemd=true\n' > /etc/wsl.conf
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375\n' > /etc/systemd/system/docker.service.d/companionhub-tcp.conf
systemctl enable docker 2>/dev/null || true"#;

    format!(
        r#"# Continue (not Stop): this phase runs probes that are *expected* to fail —
# `docker context inspect` before the context exists, `docker info` /
# `systemctl is-system-running` while the engine is still starting. Under Stop a
# native command's non-zero exit (or stderr) becomes a terminating error, so the
# must-succeed steps instead assert $LASTEXITCODE explicitly and `throw`.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$env:WSL_UTF8 = '1'

# Phase 3: Ubuntu distro, registered without the interactive first-run (owned by
# the logged-in user since this runs non-elevated).
$distros = (& wsl.exe -l -q) | ForEach-Object {{ $_.Trim() }}
$distro = $distros | Where-Object {{ $_ -eq 'Ubuntu' -or $_ -match '^Ubuntu-' }} | Select-Object -First 1
if (-not $distro) {{
  & wsl.exe --install -d Ubuntu --no-launch
  if ($LASTEXITCODE -ne 0) {{ throw "Ubuntu installation failed with exit code $LASTEXITCODE" }}
  $distro = 'Ubuntu'
}}

# Phase 4: Docker Engine + systemd TCP drop-in inside the distro (as root).
$setup = @'
{linux_setup}
'@ -replace "`r`n", "`n"
$setup | & wsl.exe -d $distro -u root -- sh
if ($LASTEXITCODE -ne 0) {{ throw "Docker Engine setup inside WSL failed with exit code $LASTEXITCODE" }}

# Restart the distro so wsl.conf + the drop-in take effect.
& wsl.exe --terminate $distro
& wsl.exe -d $distro -u root -- true

# Phase 5: route the CLI at the WSL engine via a context (read from ~/.docker
# at runtime — no env vars, no Hub restart needed).
# Prefer ProgramW6432 (the 64-bit root even under 32-bit/WOW64 PowerShell) so we
# read the CLI from where the 64-bit Hub's find_docker_binary() placed it.
$programFiles = if ($env:ProgramW6432) {{ $env:ProgramW6432 }} else {{ $env:ProgramFiles }}
$dockerBin = Join-Path $programFiles 'Docker\Docker\resources\bin'
$dockerExe = Join-Path $dockerBin 'docker.exe'
if (-not (Test-Path $dockerExe)) {{ throw "Static docker CLI is missing at $dockerExe." }}
& $dockerExe context inspect {wsl_context} 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {{
  & $dockerExe context create {wsl_context} --docker host=tcp://127.0.0.1:2375 | Out-Null
  if ($LASTEXITCODE -ne 0) {{ throw "Failed to create the {wsl_context} docker context." }}
}}
& $dockerExe context use {wsl_context} | Out-Null
if ($LASTEXITCODE -ne 0) {{ throw "Failed to select the {wsl_context} docker context." }}

# Phase 6: keepalive at logon — systemd services do not keep the WSL VM alive.
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'CompanionHub-WSL-Docker.vbs'
Set-Content -Path $vbs -Value "CreateObject(""Wscript.Shell"").Run ""wsl.exe -d $distro -u root -- sleep infinity"", 0, False"

# Keepalive for this session too, then wait for the engine.
Start-Process -WindowStyle Hidden -FilePath 'wsl.exe' -ArgumentList '-d',$distro,'-u','root','--','sleep','infinity'
# Wait up to 30 s for systemd to finish booting before polling Docker.
for ($s = 0; $s -lt 15; $s++) {{
  $state = (& wsl.exe -d $distro -u root -- systemctl is-system-running 2>$null)
  if ($state -match 'running|degraded') {{ break }}
  Start-Sleep -Seconds 2
}}
for ($i = 0; $i -lt 60; $i++) {{
  & $dockerExe info 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {{ exit 0 }}
  Start-Sleep -Seconds 5
}}
throw 'Timed out waiting for the Docker Engine inside WSL2 to come up.'
"#,
        linux_setup = linux_setup,
        wsl_context = DOCKER_CONTEXT_WSL_ENGINE,
    )
}

/// True when the WSL platform is already enabled (`wsl --status` succeeds). Used
/// to decide whether the elevated phase has anything to do.
#[cfg(target_os = "windows")]
fn wsl_platform_present() -> bool {
    let mut command = Command::new("wsl.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    command.env("WSL_UTF8", "1");
    command
        .arg("--status")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// True when the static docker CLI is already in Program Files (where the
/// elevated phase would otherwise place it). Resolves the root with the same
/// ProgramW6432-first preference the install scripts use, so the pre-check looks
/// at exactly the path the elevated phase writes and the user phase reads —
/// otherwise a CLI present only under Program Files (x86) could wrongly skip the
/// elevated phase and make the user phase throw "missing".
#[cfg(target_os = "windows")]
fn program_files_docker_present() -> bool {
    let root = std::env::var("ProgramW6432")
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("ProgramFiles").ok());
    match root {
        Some(root) => Path::new(&root)
            .join("Docker")
            .join("Docker")
            .join("resources")
            .join("bin")
            .join("docker.exe")
            .exists(),
        None => false,
    }
}

/// Run a PowerShell script, optionally elevated. Returns the captured output so
/// the caller can map exit codes to the install-result contract.
#[cfg(target_os = "windows")]
fn run_powershell_script(
    script_body: &str,
    elevated: bool,
) -> Result<std::process::Output, String> {
    use std::io::Write as IoWrite;

    // PowerShell -File refuses scripts without a .ps1 extension.
    let mut script = tempfile::Builder::new()
        .suffix(".ps1")
        .tempfile()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(script_body.as_bytes())
        .map_err(|e| format!("Failed to write temporary installer script: {}", e))?;
    // Close our writable handle before executing: on Windows, PowerShell cannot
    // run a .ps1 that is still held open by this process ("the process cannot
    // access the file ... because it is being used by another process").
    // into_temp_path() keeps the file on disk and still deletes it on drop.
    let script_path = script.into_temp_path();
    let script_path_str = script_path.to_string_lossy();

    let mut command = Command::new("powershell.exe");
    command.creation_flags(CREATE_NO_WINDOW);

    if elevated {
        // Elevate via a nested Start-Process -Verb RunAs and propagate the inner
        // exit code. The -File path is wrapped in embedded double quotes because
        // Start-Process flattens -ArgumentList into a command line without
        // re-quoting elements, so an unquoted temp path containing spaces (e.g. a
        // profile dir with a space) would break `-File`.
        let launch_command = format!(
            "$ErrorActionPreference = 'Stop'; $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','\"{}\"'); exit $process.ExitCode",
            escape_powershell_single_quoted(&script_path_str),
        );
        command.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &launch_command,
        ]);
    } else {
        // Non-elevated: run as the logged-in Hub user directly.
        command.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script_path_str,
        ]);
    }

    command
        .output()
        .map_err(|e| format!("Failed to launch WSL2 engine installer: {}", e))
}

#[cfg(target_os = "windows")]
fn install_docker_wsl2_windows() -> Result<DockerInstallResult, String> {
    // Elevation is only needed when the WSL platform must be enabled or the
    // static docker CLI is missing from Program Files. Skipping it on re-runs
    // avoids an unnecessary UAC prompt.
    if !wsl_platform_present() || !program_files_docker_present() {
        let output = run_powershell_script(&wsl2_engine_elevated_script(), true)?;
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        let combined_lower = combined.to_lowercase();
        match output.status.code() {
            Some(0) => {}
            Some(100) => {
                return Ok(DockerInstallResult {
                    state: DockerInstallState::NeedsRestart,
                    detail: Some(
                        "WSL was installed or enabled. Restart Windows, then reopen Companion Hub to continue Docker setup."
                            .to_string(),
                    ),
                });
            }
            _ if combined_lower.contains("cancel") && combined_lower.contains("user") => {
                return Err("Authorization was cancelled or denied.".to_string());
            }
            _ if combined.is_empty() => {
                return Err(format!(
                    "WSL2 Docker Engine installation failed with exit code {:?}.",
                    output.status.code()
                ));
            }
            _ => {
                return Err(format!(
                    "WSL2 Docker Engine installation failed: {}",
                    combined
                ));
            }
        }
    }

    // User phase: per-user state (distro, docker context, Startup keepalive) is
    // created as the logged-in user so the running Hub can see it.
    let output = run_powershell_script(&wsl2_engine_user_script(), false)?;
    let combined = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    match output.status.code() {
        Some(0) => Ok(DockerInstallResult {
            state: DockerInstallState::Completed,
            detail: Some(format!(
                "Docker Engine is running inside WSL2 (context \"{DOCKER_CONTEXT_WSL_ENGINE}\")."
            )),
        }),
        _ if combined.is_empty() => Err(format!(
            "WSL2 Docker Engine installation failed with exit code {:?}.",
            output.status.code()
        )),
        _ => Err(format!(
            "WSL2 Docker Engine installation failed: {}",
            combined
        )),
    }
}
