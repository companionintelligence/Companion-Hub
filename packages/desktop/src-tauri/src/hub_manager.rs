use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(target_os = "linux")]
const MAX_COMMAND_OUTPUT_CHARS: usize = 400;

#[cfg(target_os = "windows")]
const DOCKER_DESKTOP_WINDOWS_INSTALLER_URL: &str =
    "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
#[cfg(target_os = "macos")]
const DOCKER_DESKTOP_MACOS_INTEL_URL: &str = "https://desktop.docker.com/mac/main/amd64/Docker.dmg";
#[cfg(target_os = "macos")]
const DOCKER_DESKTOP_MACOS_ARM_URL: &str = "https://desktop.docker.com/mac/main/arm64/Docker.dmg";

pub fn docker_command() -> Command {
    let docker_path = find_docker_binary();
    let mut cmd = Command::new(docker_path);
    // Ensure common binary paths are in PATH for subprocesses (e.g. docker compose)
    if let Ok(current_path) = std::env::var("PATH") {
        let extra_paths = if cfg!(target_os = "macos") {
            "/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"
        } else if cfg!(target_os = "windows") {
            ""
        } else {
            "/usr/local/bin:/usr/bin"
        };
        if !extra_paths.is_empty() {
            cmd.env("PATH", format!("{}:{}", extra_paths, current_path));
        }
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn command_on_path(binary: &str) -> Option<PathBuf> {
    let locator = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    Command::new(locator)
        .arg(binary)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(PathBuf::from)
        })
}

/// Find the Docker binary, checking common install locations if not in PATH.
fn find_docker_binary() -> PathBuf {
    if let Some(path) = command_on_path("docker") {
        return path;
    }

    #[cfg(target_os = "macos")]
    {
        let candidates = [
            "/usr/local/bin/docker",
            "/opt/homebrew/bin/docker",
            "/Applications/Docker.app/Contents/Resources/bin/docker",
        ];
        for candidate in candidates {
            if std::path::Path::new(candidate).exists() {
                return PathBuf::from(candidate);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let candidates = [
            "/usr/local/bin/docker",
            "/usr/bin/docker",
            "/snap/bin/docker",
        ];
        for candidate in candidates {
            if std::path::Path::new(candidate).exists() {
                return PathBuf::from(candidate);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        for env_var in ["ProgramFiles", "ProgramW6432"] {
            if let Ok(root) = std::env::var(env_var) {
                candidates.push(
                    Path::new(&root)
                        .join("Docker")
                        .join("Docker")
                        .join("resources")
                        .join("bin")
                        .join("docker.exe"),
                );
            }
        }
        for candidate in candidates {
            if candidate.exists() {
                return candidate;
            }
        }
    }

    PathBuf::from(if cfg!(target_os = "windows") {
        "docker.exe"
    } else {
        "docker"
    })
}

/// Paths used by the Hub manager, stored in Tauri app state.
pub struct HubPaths {
    pub data_dir: PathBuf,
    pub compose_path: PathBuf,
    pub env_path: PathBuf,
}

#[derive(Clone, serde::Serialize)]
pub enum HubStatus {
    DockerNotAvailable,
    Stopped,
    Starting,
    Running,
    Error { message: String },
}

#[derive(Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DockerAccessState {
    Available,
    PermissionDenied,
    DaemonUnavailable,
    NotInstalled,
    Error,
}

#[derive(Clone, serde::Serialize)]
pub struct DockerAccessCheck {
    pub state: DockerAccessState,
    pub detail: Option<String>,
}

#[derive(Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DockerInstallState {
    Completed,
    NeedsRestart,
}

#[derive(Clone, serde::Serialize)]
pub struct DockerInstallResult {
    pub state: DockerInstallState,
    pub detail: Option<String>,
}

/// Get the current status of the Hub by inspecting the Docker container.
pub fn get_hub_status() -> HubStatus {
    if !is_docker_available() {
        return HubStatus::DockerNotAvailable;
    }

    // Check ci-os-hub container specifically
    let status = docker_command()
        .args([
            "inspect",
            "--format",
            "{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
            "ci-os-hub",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    if status.is_empty() || status.contains("No such object") || status.contains("Error") {
        return HubStatus::Stopped;
    }

    let parts: Vec<&str> = status.split(':').collect();
    let state = parts.first().copied().unwrap_or("");
    let health = parts.get(1).copied().unwrap_or("");

    match (state, health) {
        ("running", "healthy") => HubStatus::Running,
        ("running", _) => HubStatus::Starting,
        ("restarting", _) => {
            // Check if database is still starting — if so, Hub restart is expected
            let db_status = docker_command()
                .args([
                    "inspect",
                    "--format",
                    "{{.State.Health.Status}}",
                    "ci-hub-db",
                ])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();

            if db_status != "healthy" {
                HubStatus::Starting // DB not ready yet, Hub restart is expected
            } else {
                // DB is healthy but Hub is still restarting — might be a real error
                let restart_count = docker_command()
                    .args(["inspect", "--format", "{{.RestartCount}}", "ci-os-hub"])
                    .output()
                    .map(|o| {
                        String::from_utf8_lossy(&o.stdout)
                            .trim()
                            .parse::<u32>()
                            .unwrap_or(0)
                    })
                    .unwrap_or(0);

                if restart_count <= 3 {
                    HubStatus::Starting
                } else {
                    HubStatus::Error {
                        message: format!(
                            "Hub has restarted {} times. Check Docker logs for details.",
                            restart_count
                        ),
                    }
                }
            }
        }
        ("created", _) | ("exited", _) => HubStatus::Stopped,
        _ => HubStatus::Starting,
    }
}

/// Get the Hub data directory (platform-specific)
pub fn get_hub_data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("companion-hub")
}

/// Check if Docker is available
pub fn is_docker_available() -> bool {
    matches!(check_docker_access().state, DockerAccessState::Available)
}

pub fn check_docker_access() -> DockerAccessCheck {
    let output = match docker_command().arg("info").output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return DockerAccessCheck {
                state: DockerAccessState::NotInstalled,
                detail: Some("Docker CLI was not found on PATH.".to_string()),
            };
        }
        Err(error) => {
            return DockerAccessCheck {
                state: DockerAccessState::Error,
                detail: Some(format!("Failed to run docker info: {}", error)),
            };
        }
    };

    if output.status.success() {
        return DockerAccessCheck {
            state: DockerAccessState::Available,
            detail: None,
        };
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let combined = if !stderr.is_empty() && !stdout.is_empty() {
        format!("{}\n{}", stderr, stdout)
    } else if !stderr.is_empty() {
        stderr.clone()
    } else {
        stdout.clone()
    };
    classify_docker_access_result(&combined, output.status.code())
}

fn classify_docker_access_result(combined: &str, exit_code: Option<i32>) -> DockerAccessCheck {
    let combined_lower = combined.to_lowercase();

    if combined_lower.contains("cannot connect to the docker daemon")
        || combined_lower.contains("is the docker daemon running")
        || combined_lower.contains("error during connect")
        || combined_lower.contains("connection refused")
        || combined_lower.contains("context deadline exceeded")
    {
        return DockerAccessCheck {
            state: DockerAccessState::DaemonUnavailable,
            detail: Some(if combined.is_empty() {
                "Docker is installed, but the daemon is not ready yet.".to_string()
            } else {
                combined.to_string()
            }),
        };
    }

    if combined_lower.contains("permission denied")
        || combined_lower.contains("got permission denied")
        || combined_lower.contains("permission denied while trying to connect")
        || combined_lower.contains("dial unix /var/run/docker.sock: connect: permission denied")
    {
        return DockerAccessCheck {
            state: DockerAccessState::PermissionDenied,
            detail: Some(if combined.is_empty() {
                "Docker is installed, but this user cannot access the Docker daemon yet."
                    .to_string()
            } else {
                combined.to_string()
            }),
        };
    }

    DockerAccessCheck {
        state: DockerAccessState::Error,
        detail: Some(if combined.is_empty() {
            format!("docker info failed with exit code {:?}", exit_code)
        } else {
            combined.to_string()
        }),
    }
}

/// Check if Hub containers exist (stopped or running)
pub fn hub_containers_exist() -> bool {
    docker_command()
        .args([
            "ps",
            "-a",
            "--filter",
            "name=ci-os-hub",
            "--format",
            "{{.Names}}",
        ])
        .output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

/// Start Hub using docker compose up (with port conflict resolution)
pub fn start_hub(compose_path: &Path, env_path: &Path, _data_dir: &Path) -> Result<String, String> {
    // Resolve port conflicts and write to .env before starting
    let resolution = crate::port_manager::refresh_ports_if_needed(env_path)?;

    // Log warnings and info
    let log_path = _data_dir.join("logs").join("port-resolution.log");
    let mut log_lines = vec![format!(
        "[{}] Port resolution:",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
    )];
    for w in &resolution.warnings {
        log_lines.push(format!("  WARN: {}", w));
    }
    for i in &resolution.info {
        log_lines.push(format!("  INFO: {}", i));
    }
    for (var, port) in &resolution.env_vars {
        log_lines.push(format!("  {}={}", var, port));
    }
    let _ = std::fs::write(&log_path, log_lines.join("\n") + "\n");

    let output = docker_command()
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "up",
            "-d",
        ])
        .output()
        .map_err(|e| format!("Failed to run docker compose: {}", e))?;

    if output.status.success() {
        Ok("Hub started successfully".to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Stop Hub containers
pub fn stop_hub(compose_path: &Path, env_path: &Path) -> Result<String, String> {
    let output = docker_command()
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "down",
        ])
        .output()
        .map_err(|e| format!("Failed to stop hub: {}", e))?;

    if output.status.success() {
        Ok("Hub stopped".to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Parse a .env file into a HashMap of key-value pairs.
fn parse_env_file(path: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                map.insert(key.trim().to_string(), value.trim().to_string());
            }
        }
    }
    map
}

/// Generate a random hex string of the given byte length.
fn generate_hex(bytes: usize) -> String {
    (0..bytes)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect()
}

/// Determine the Hub container image tag from the domain.
fn image_for_domain(domain: &str) -> &'static str {
    match domain {
        "ci.computer" => "ghcr.io/companionintelligence/ci-hub:latest",
        "companionintel.com" => "ghcr.io/companionintelligence/ci-hub:staging",
        _ => "ghcr.io/companionintelligence/ci-hub:dev",
    }
}

/// Compute the data directory path string, handling Windows Docker Desktop paths.
fn compute_data_dir_str(data_dir: &Path) -> String {
    if cfg!(windows) {
        let path = data_dir.to_string_lossy().to_string();
        if path.len() >= 2 && path.chars().nth(1) == Some(':') {
            let drive = path.chars().next().unwrap().to_lowercase().to_string();
            format!("/{}{}", drive, path[2..].replace('\\', "/"))
        } else {
            path.replace('\\', "/")
        }
    } else {
        data_dir.to_string_lossy().to_string()
    }
}

/// Initialize Hub data directory and generate .env file.
///
/// Uses a regenerate-and-preserve approach:
/// - Preserved values (read from existing .env, generated if missing): ROOT_FOLDER_HOST, JWT_SECRET, POSTGRES_PASSWORD
/// - Derived values (always recomputed from the current binary): INTERNAL_IP, DOMAIN, CI_CLOUD_URL, CI_HUB_VERSION, CI_HUB_IMAGE, DOCKER_PLATFORM
///
/// Returns (data_dir, compose_path, env_path, env_changed).
pub fn initialize_hub(resource_dir: &Path) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let data_dir = get_hub_data_dir();

    // Create data subdirectories
    let subdirs = [
        "state",
        "repos",
        "apps",
        "logs",
        "media",
        "user-config",
        "app-data",
        "backups",
        "cache",
    ];
    for sub in subdirs {
        std::fs::create_dir_all(data_dir.join(sub))
            .map_err(|e| format!("Failed to create {}: {}", sub, e))?;
    }

    // Copy docker-compose.prod.yml from resources
    let compose_candidates = [
        resource_dir.join("docker-compose.prod.yml"),
        resource_dir
            .join("resources")
            .join("docker-compose.prod.yml"),
        std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .unwrap_or(Path::new("."))
            .join("resources")
            .join("docker-compose.prod.yml"),
    ];

    let log_path = data_dir.join("logs").join("init.log");
    let mut log_lines = vec![format!(
        "[{}] initialize_hub: resource_dir = {:?}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        resource_dir
    )];
    for (i, candidate) in compose_candidates.iter().enumerate() {
        log_lines.push(format!(
            "  candidate[{}]: {:?} exists={}",
            i,
            candidate,
            candidate.exists()
        ));
    }

    let compose_src = compose_candidates.iter().find(|p| p.exists());
    let compose_dst = data_dir.join("docker-compose.prod.yml");

    if let Some(src) = compose_src {
        log_lines.push(format!("  -> using: {:?}", src));
        std::fs::copy(src, &compose_dst)
            .map_err(|e| format!("Failed to copy compose file: {}", e))?;
        log_lines.push("  -> updated in data_dir".to_string());
    } else {
        log_lines.push("  -> WARNING: no compose file found in any candidate path!".to_string());
    }

    // --- Regenerate .env with preserve-and-derive approach ---
    let env_path = data_dir.join(".env");
    let existing = parse_env_file(&env_path);

    // Preserved values — read from existing, generate if missing
    let root_folder_host = existing
        .get("ROOT_FOLDER_HOST")
        .cloned()
        .unwrap_or_else(|| compute_data_dir_str(&data_dir));
    let jwt_secret = existing
        .get("JWT_SECRET")
        .cloned()
        .unwrap_or_else(|| generate_hex(64));
    let postgres_password = existing
        .get("POSTGRES_PASSWORD")
        .cloned()
        .unwrap_or_else(|| generate_hex(32));

    // Derived values — always from current binary
    let domain = option_env!("CI_HUB_DOMAIN").unwrap_or("companionintelligence.com");
    let cloud_url =
        option_env!("CI_HUB_CLOUD_URL").unwrap_or("https://portal.companionintelligence.com");
    let hub_version = option_env!("CI_HUB_BUILD_VERSION").unwrap_or("4.7.0");
    let hub_image = image_for_domain(domain);
    let docker_platform = if cfg!(target_arch = "aarch64") {
        "linux/arm64"
    } else {
        "linux/amd64"
    };

    // Build .env content with deterministic key order
    let env_content = format!(
        "# Preserved (generated once, survive upgrades)\n\
         ROOT_FOLDER_HOST={root_folder_host}\n\
         JWT_SECRET={jwt_secret}\n\
         POSTGRES_PASSWORD={postgres_password}\n\
         \n\
         # Derived (recomputed every launch from the current binary)\n\
         INTERNAL_IP=0.0.0.0\n\
         DOMAIN={domain}\n\
         CI_CLOUD_URL={cloud_url}\n\
         CI_HUB_VERSION={hub_version}\n\
         CI_HUB_IMAGE={hub_image}\n\
         DOCKER_PLATFORM={docker_platform}\n",
        root_folder_host = root_folder_host,
        jwt_secret = jwt_secret,
        postgres_password = postgres_password,
        domain = domain,
        cloud_url = cloud_url,
        hub_version = hub_version,
        hub_image = hub_image,
        docker_platform = docker_platform,
    );

    // Write .env (port manager will append dynamic port vars after this)
    let old_content = std::fs::read_to_string(&env_path).unwrap_or_default();
    // Strip port vars from old content for comparison (port manager manages those)
    let env_changed = strip_port_vars(&old_content) != env_content;
    std::fs::write(&env_path, &env_content).map_err(|e| format!("Failed to write .env: {}", e))?;

    log_lines.push(format!("  .env changed: {}", env_changed));

    // Write init log (append)
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "{}", log_lines.join("\n"))
        });

    // Clean up legacy .docker-config.json if it exists
    let legacy_docker_config = data_dir.join(".docker-config.json");
    if legacy_docker_config.exists() {
        let _ = std::fs::remove_file(&legacy_docker_config);
    }

    Ok((data_dir, compose_dst, env_path))
}

/// Strip dynamic port variables from .env content for comparison purposes.
/// Port manager owns these vars and rewrites them each launch.
fn strip_port_vars(content: &str) -> String {
    let port_vars = [
        "API_PORT=",
        "POSTGRES_PORT=",
        "RABBITMQ_PORT=",
        "TRAEFIK_DASHBOARD_PORT=",
        "HTTP_PORT=",
        "HTTPS_PORT=",
    ];
    content
        .lines()
        .filter(|line| !port_vars.iter().any(|pv| line.starts_with(pv)))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

pub fn install_docker() -> Result<DockerInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_docker_linux().map(|detail| DockerInstallResult {
            state: DockerInstallState::Completed,
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
fn docker_desktop_windows_install_script(download_url: &str) -> String {
    format!(
        r#"param([string]$AppUser)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
& wsl --status | Out-Null
if ($LASTEXITCODE -ne 0) {{
  & wsl --install --no-distribution
  exit 100
}}
$installer = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.exe')
Remove-Item $installer -Force -ErrorAction SilentlyContinue
try {{
  Invoke-WebRequest -UseBasicParsing -Uri '{download_url}' -OutFile $installer
  $signature = Get-AuthenticodeSignature $installer
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
        download_url = download_url,
    )
}

#[cfg(target_os = "windows")]
fn install_docker_windows() -> Result<DockerInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let username = resolve_current_username_windows()?;
    let mut script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(
            docker_desktop_windows_install_script(DOCKER_DESKTOP_WINDOWS_INSTALLER_URL).as_bytes(),
        )
        .map_err(|e| format!("Failed to write Windows installer script: {}", e))?;

    let launch_command = format!(
        "$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{}','-AppUser','{}'); exit $process.ExitCode",
        escape_powershell_single_quoted(&script.path().to_string_lossy()),
        escape_powershell_single_quoted(&username),
    );

    let output = Command::new("powershell.exe")
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

#[cfg(target_os = "windows")]
fn resolve_current_username_windows() -> Result<String, String> {
    if let Ok(username) = std::env::var("USERNAME") {
        let username = username.trim();
        if !username.is_empty() {
            return Ok(username.to_string());
        }
    }

    let output = Command::new("whoami")
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

#[cfg(target_os = "windows")]
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
fn docker_desktop_macos_install_script(download_url: &str, username: &str) -> String {
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

/// Install Docker Engine on Linux using the official convenience script.
/// Uses pkexec for privilege escalation (GUI polkit prompt).
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
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
installer_script="$(mktemp)"
cleanup() {
  rm -f "$installer_script"
}
trap cleanup EXIT
curl -fsSL https://get.docker.com -o "$installer_script"
sh "$installer_script"
usermod -aG docker "$1"
systemctl enable docker
systemctl start docker
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

#[cfg(target_os = "linux")]
fn truncate_command_output(output: &str) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let char_count = trimmed.chars().count();
    if char_count <= MAX_COMMAND_OUTPUT_CHARS {
        return trimmed.to_string();
    }

    let truncated: String = trimmed.chars().take(MAX_COMMAND_OUTPUT_CHARS).collect();
    format!(
        "{}… [truncated {} chars]",
        truncated,
        char_count - MAX_COMMAND_OUTPUT_CHARS
    )
}

#[cfg(target_os = "linux")]
fn format_command_output(stdout: &str, stderr: &str) -> String {
    let stdout = truncate_command_output(stdout);
    let stderr = truncate_command_output(stderr);

    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("stdout: {} | stderr: {}", stdout, stderr),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(any(test, target_os = "macos"))]
    use super::docker_desktop_macos_install_script;
    #[cfg(any(test, target_os = "windows"))]
    use super::docker_desktop_windows_install_script;
    use super::{classify_docker_access_result, DockerAccessState};
    #[cfg(target_os = "linux")]
    use super::{format_command_output, truncate_command_output, MAX_COMMAND_OUTPUT_CHARS};

    #[test]
    fn classifies_daemon_unavailable_before_permission_denied() {
        let result = classify_docker_access_result(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
            Some(1),
        );

        assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
    }

    #[test]
    fn classifies_explicit_permission_denied_as_permission_issue() {
        let result = classify_docker_access_result(
            "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
            Some(1),
        );

        assert!(matches!(result.state, DockerAccessState::PermissionDenied));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn truncates_long_command_output() {
        let output = "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 25);
        let truncated = truncate_command_output(&output);

        assert!(truncated.contains("[truncated 25 chars]"));
        assert!(truncated.starts_with(&"x".repeat(MAX_COMMAND_OUTPUT_CHARS)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn formats_stdout_and_stderr_with_truncation() {
        let stdout = "ok";
        let stderr = "y".repeat(MAX_COMMAND_OUTPUT_CHARS + 10);
        let formatted = format_command_output(stdout, &stderr);

        assert!(formatted.starts_with("stdout: ok | stderr: "));
        assert!(formatted.contains("[truncated 10 chars]"));
    }

    #[test]
    fn windows_installer_script_uses_unique_temp_download_and_validates_signature() {
        let script = docker_desktop_windows_install_script(
            "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
        );

        assert!(script.contains("GetTempFileName()"));
        assert!(script.contains("Get-AuthenticodeSignature"));
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
}
