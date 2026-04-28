use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Maximum number of start attempts (1 initial + 2 retries with exponential
/// backoff of 2 s then 4 s).  `start_hub` / `start_hub_inner` are blocking
/// functions — callers from async contexts should use `spawn_blocking`.
const MAX_START_RETRIES: u32 = 3;

/// Global guard: true while a `start_hub` call is in progress.
static START_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

const MAX_COMMAND_OUTPUT_CHARS: usize = 400;
const DESKTOP_LOG_FILENAME: &str = "desktop.log";
const MANAGED_APP_CONTAINER_LABEL_FILTER: &str = "label=ci-os-hub.managed=true";
const MANAGED_APP_CONTAINER_URN_FILTER: &str = "label=ci-os-hub.appurn";
const DEFAULT_TRAEFIK_ACME_EMAIL: &str = "admin@companionintelligence.com";
const TRAEFIK_ACME_DEFAULT_CONTENT: &str = "{}";
const TRAEFIK_CONFIG_SEED: &str = include_str!("../../../backend/assets/traefik/traefik.yml");
const TRAEFIK_DYNAMIC_CONFIG_SEED: &str =
    include_str!("../../../backend/assets/traefik/dynamic/dynamic.yml");
const TRAEFIK_RECREATE_MARKER_FILENAME: &str = ".traefik-recreate-required";
const TRAEFIK_STATE_DIR: &str = "state/traefik";
const TRAEFIK_CONFIG_DIR: &str = "state/traefik/config";
const TRAEFIK_DYNAMIC_DIR: &str = "state/traefik/dynamic";
const TRAEFIK_TLS_DIR: &str = "state/traefik/tls";
const TRAEFIK_CONFIG_FILE: &str = "state/traefik/config/traefik.yml";
const TRAEFIK_DYNAMIC_FILE: &str = "state/traefik/dynamic/dynamic.yml";
const TRAEFIK_ACME_FILE: &str = "state/traefik/acme_storage.json";

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

    let mut command = Command::new(locator);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    command
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TraefikRuntimePreflight {
    pub changed: bool,
    pub repaired_conflicting_paths: bool,
}

impl TraefikRuntimePreflight {
    fn merge(&mut self, other: Self) {
        self.changed |= other.changed;
        self.repaired_conflicting_paths |= other.repaired_conflicting_paths;
    }
}

#[derive(Debug)]
pub struct HubInitialization {
    pub data_dir: PathBuf,
    pub compose_path: PathBuf,
    pub env_path: PathBuf,
    pub traefik_preflight: TraefikRuntimePreflight,
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
                            "Hub has restarted {} times. Open tray → View Logs for details.",
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

pub(crate) fn logs_dir_for(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

pub fn logs_dir() -> PathBuf {
    logs_dir_for(&get_hub_data_dir())
}

pub(crate) fn desktop_log_path_for(data_dir: &Path) -> PathBuf {
    logs_dir_for(data_dir).join(DESKTOP_LOG_FILENAME)
}

pub fn desktop_log_path() -> PathBuf {
    desktop_log_path_for(&get_hub_data_dir())
}

pub(crate) fn logs_open_target_for(data_dir: &Path) -> PathBuf {
    logs_dir_for(data_dir)
}

pub fn logs_open_target() -> PathBuf {
    logs_open_target_for(&get_hub_data_dir())
}

pub(crate) fn managed_app_container_ps_args() -> [&'static str; 6] {
    [
        "ps",
        "-q",
        "--filter",
        MANAGED_APP_CONTAINER_LABEL_FILTER,
        "--filter",
        MANAGED_APP_CONTAINER_URN_FILTER,
    ]
}

fn parse_container_ids(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn format_log_entry(operation: &str, message: &str) -> String {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return format!("[{}] {}\n", timestamp, operation);
    }

    let mut lines = trimmed.lines();
    let first_line = lines.next().unwrap_or_default().trim_end();
    let mut formatted = format!("[{}] {}: {}\n", timestamp, operation, first_line);
    for line in lines {
        formatted.push_str(&format!("    {}\n", line.trim_end()));
    }
    formatted
}

pub(crate) fn append_desktop_log_for(
    data_dir: &Path,
    operation: &str,
    message: &str,
) -> std::io::Result<PathBuf> {
    let log_path = desktop_log_path_for(data_dir);
    std::fs::create_dir_all(logs_dir_for(data_dir))?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    use std::io::Write;
    file.write_all(format_log_entry(operation, message).as_bytes())?;
    Ok(log_path)
}

pub fn append_desktop_log(operation: &str, message: &str) -> std::io::Result<PathBuf> {
    append_desktop_log_for(&get_hub_data_dir(), operation, message)
}

fn with_view_logs_hint(message: impl Into<String>) -> String {
    format!("{} Open tray → View Logs for details.", message.into())
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
    let references_windows_docker_pipe = combined_lower.contains("//./pipe/docker")
        || combined_lower.contains("\\\\.\\pipe\\docker")
        || combined_lower.contains("%2f%2f.%2fpipe%2fdocker");
    let windows_pipe_not_ready = references_windows_docker_pipe
        && (combined_lower.contains("the system cannot find the file specified")
            || combined_lower.contains("the pipe has been ended")
            || combined_lower.contains("the semaphore timeout period has expired"));

    if combined_lower.contains("cannot connect to the docker daemon")
        || combined_lower.contains("is the docker daemon running")
        || combined_lower.contains("error during connect")
        || combined_lower.contains("connection refused")
        || combined_lower.contains("context deadline exceeded")
        || combined_lower.contains("this error may indicate that the docker daemon is not running")
        || windows_pipe_not_ready
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
        || combined_lower.contains("access is denied")
        || combined_lower.contains("must be run with elevated privileges")
        || combined_lower.contains("requested operation requires elevation")
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

fn traefik_recreate_marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TRAEFIK_RECREATE_MARKER_FILENAME)
}

pub(crate) fn is_traefik_recreate_required(data_dir: &Path) -> bool {
    traefik_recreate_marker_path(data_dir).exists()
}

fn mark_traefik_recreate_required(data_dir: &Path) -> Result<(), String> {
    let marker_path = traefik_recreate_marker_path(data_dir);
    std::fs::write(
        &marker_path,
        b"Traefik container must be recreated before the next startup.\n",
    )
    .map_err(|error| {
        format!(
            "Failed to persist Traefik recreate marker at {}: {}",
            marker_path.display(),
            error
        )
    })
}

fn clear_traefik_recreate_required(data_dir: &Path) -> Result<(), String> {
    let marker_path = traefik_recreate_marker_path(data_dir);
    if !marker_path.exists() {
        return Ok(());
    }

    std::fs::remove_file(&marker_path).map_err(|error| {
        format!(
            "Failed to clear Traefik recreate marker at {}: {}",
            marker_path.display(),
            error
        )
    })
}

fn seeded_traefik_config_contents() -> String {
    TRAEFIK_CONFIG_SEED.replace("{{ACME_EMAIL}}", DEFAULT_TRAEFIK_ACME_EMAIL)
}

fn ensure_runtime_directory(path: &Path) -> Result<TraefikRuntimePreflight, String> {
    let mut result = TraefikRuntimePreflight::default();

    if path.exists() {
        if path.is_dir() {
            return Ok(result);
        }

        std::fs::remove_file(path).map_err(|error| {
            format!(
                "Failed to remove conflicting file at {}: {}",
                path.display(),
                error
            )
        })?;
        result.changed = true;
        result.repaired_conflicting_paths = true;
    }

    std::fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create directory {}: {}", path.display(), error))?;
    result.changed = true;
    Ok(result)
}

fn ensure_seeded_text_file(path: &Path, contents: &str) -> Result<TraefikRuntimePreflight, String> {
    let mut result = TraefikRuntimePreflight::default();

    if let Some(parent) = path.parent() {
        result.merge(ensure_runtime_directory(parent)?);
    }

    if path.exists() {
        if path.is_dir() {
            std::fs::remove_dir_all(path).map_err(|error| {
                format!(
                    "Failed to remove conflicting directory at {}: {}",
                    path.display(),
                    error
                )
            })?;
            result.changed = true;
            result.repaired_conflicting_paths = true;
        } else {
            let existing = std::fs::read(path)
                .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
            if existing == contents.as_bytes() {
                return Ok(result);
            }
        }
    }

    std::fs::write(path, contents)
        .map_err(|error| format!("Failed to write {}: {}", path.display(), error))?;
    result.changed = true;
    Ok(result)
}

fn ensure_runtime_file(
    path: &Path,
    default_contents: &str,
    file_mode: Option<u32>,
) -> Result<TraefikRuntimePreflight, String> {
    let mut result = TraefikRuntimePreflight::default();

    if let Some(parent) = path.parent() {
        result.merge(ensure_runtime_directory(parent)?);
    }

    let should_write = if path.exists() {
        if path.is_dir() {
            std::fs::remove_dir_all(path).map_err(|error| {
                format!(
                    "Failed to remove conflicting directory at {}: {}",
                    path.display(),
                    error
                )
            })?;
            result.changed = true;
            result.repaired_conflicting_paths = true;
            true
        } else {
            false
        }
    } else {
        true
    };

    if should_write {
        std::fs::write(path, default_contents)
            .map_err(|error| format!("Failed to write {}: {}", path.display(), error))?;
        if let Some(mode) = file_mode {
            set_file_mode(path, mode)?;
        }
        result.changed = true;
    }

    Ok(result)
}

fn set_file_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|error| {
            format!("Failed to set permissions on {}: {}", path.display(), error)
        })?;
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (path, mode);
    }

    Ok(())
}

fn prepare_traefik_runtime_state(data_dir: &Path) -> Result<TraefikRuntimePreflight, String> {
    let mut result = TraefikRuntimePreflight::default();

    for relative_dir in [
        TRAEFIK_STATE_DIR,
        TRAEFIK_CONFIG_DIR,
        TRAEFIK_DYNAMIC_DIR,
        TRAEFIK_TLS_DIR,
    ] {
        result.merge(ensure_runtime_directory(&data_dir.join(relative_dir))?);
    }

    result.merge(ensure_seeded_text_file(
        &data_dir.join(TRAEFIK_CONFIG_FILE),
        &seeded_traefik_config_contents(),
    )?);
    result.merge(ensure_seeded_text_file(
        &data_dir.join(TRAEFIK_DYNAMIC_FILE),
        TRAEFIK_DYNAMIC_CONFIG_SEED,
    )?);
    result.merge(ensure_runtime_file(
        &data_dir.join(TRAEFIK_ACME_FILE),
        TRAEFIK_ACME_DEFAULT_CONTENT,
        Some(0o600),
    )?);

    Ok(result)
}

fn remove_existing_traefik_container(data_dir: &Path) -> Result<(), String> {
    let output = docker_command()
        .args(["rm", "-f", "traefik"])
        .output()
        .map_err(|error| {
            format!(
                "Failed to remove the existing Traefik container before recreate: {}",
                error
            )
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );
    let combined_lower = combined_output.to_lowercase();

    if output.status.success() {
        let message = if combined_output.is_empty() {
            "Removed existing Traefik container before recreate.".to_string()
        } else {
            format!(
                "Removed existing Traefik container before recreate. {}",
                combined_output
            )
        };
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        return Ok(());
    }

    if combined_lower.contains("no such container") || combined_lower.contains("no such object") {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            "Traefik recreate was requested, but no existing Traefik container was present.",
        );
        return Ok(());
    }

    if combined_output.is_empty() {
        Err(format!(
            "Failed to remove the existing Traefik container before recreate (exit code {:?}).",
            output.status.code()
        ))
    } else {
        Err(format!(
            "Failed to remove the existing Traefik container before recreate. {}",
            combined_output
        ))
    }
}

/// Remove stale project containers left behind by a previous installation.
/// Runs `docker compose down --remove-orphans` to clean up before a fresh start.
pub fn cleanup_stale_project_containers(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.cleanup",
        "Cleaning up stale containers before start.",
    );

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
            "--remove-orphans",
        ])
        .output()
        .map_err(|e| format!("Failed to run cleanup compose down: {}", e))?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    // Log result but treat non-zero exit as non-fatal — the subsequent start
    // will surface any real problem.
    if output.status.success() {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.cleanup",
            &format!("Stale container cleanup succeeded. {}", combined_output),
        );
    } else {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.cleanup",
            &format!(
                "Stale container cleanup returned non-zero (non-fatal). {}",
                combined_output
            ),
        );
    }

    Ok(())
}

/// Returns `true` if the error output indicates a Docker container name conflict
/// ("is already in use by container").
fn is_container_name_conflict(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("is already in use by container")
}

/// Returns `true` if the error output indicates an OCI runtime creation failure.
fn is_oci_runtime_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("oci runtime create failed") || lower.contains("failed to create shim task")
}

/// Start Hub using docker compose up (with port conflict resolution).
///
/// Uses a global `AtomicBool` guard to prevent concurrent invocations.
pub fn start_hub(compose_path: &Path, env_path: &Path, data_dir: &Path) -> Result<String, String> {
    // Prevent concurrent start attempts.
    if START_IN_PROGRESS.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err()
    {
        let message = "A Hub start operation is already in progress — skipping duplicate request.";
        let _ = append_desktop_log_for(data_dir, "hub.start", message);
        return Ok(message.to_string());
    }

    let result = start_hub_inner(compose_path, env_path, data_dir);
    START_IN_PROGRESS.store(false, Ordering::SeqCst);
    result
}

/// Inner start logic, called under the `START_IN_PROGRESS` guard.
fn start_hub_inner(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<String, String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Requested start via docker compose up -d\ncompose={}\nenv={}",
            compose_path.display(),
            env_path.display()
        ),
    );

    let traefik_preflight = prepare_traefik_runtime_state(data_dir).map_err(|error| {
        let message = format!("Traefik runtime preflight failed before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    if traefik_preflight.changed {
        mark_traefik_recreate_required(data_dir).map_err(|error| {
            let message = format!(
                "Traefik runtime preflight changed mounted state, but the recreate marker could not be written: {}",
                error
            );
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;
    }

    let recreate_traefik = is_traefik_recreate_required(data_dir);
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Traefik runtime preflight: changed={} repaired_conflicting_paths={} recreate_pending={}",
            traefik_preflight.changed,
            traefik_preflight.repaired_conflicting_paths,
            recreate_traefik
        ),
    );

    if recreate_traefik {
        remove_existing_traefik_container(data_dir).map_err(|error| {
            let message = format!("Traefik recreate preparation failed: {}", error);
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;
        // Traefik container has been removed — clear the marker now regardless of
        // whether compose-up succeeds.  The marker's purpose ("Traefik must be
        // recreated") is satisfied once the old container is gone.
        if let Err(error) = clear_traefik_recreate_required(data_dir) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Traefik container removed but the recreate marker could not be cleared: {}",
                    error
                ),
            );
        }
    }

    // Resolve port conflicts and write to .env before starting
    let resolution = crate::port_manager::refresh_ports_if_needed(env_path).map_err(|error| {
        let message = format!("Port resolution failed before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    // Log warnings and info
    let log_path = logs_dir_for(data_dir).join("port-resolution.log");
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
    let _ = append_desktop_log_for(data_dir, "hub.start", &log_lines.join("\n"));

    // Attempt compose up with automatic retry on transient container conflicts.
    let mut last_error = String::new();
    for attempt in 1..=MAX_START_RETRIES {
        if attempt > 1 {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!("Retry attempt {}/{} after transient failure.", attempt, MAX_START_RETRIES),
            );
        }

        let output = match docker_command()
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
        {
            Ok(output) => output,
            Err(e) => {
                let message = format!("Failed to run docker compose up -d: {}", e);
                let _ = append_desktop_log_for(data_dir, "hub.start", &message);
                return Err(with_view_logs_hint(message));
            }
        };

        let combined_output = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );

        if output.status.success() {
            let message = if combined_output.is_empty() {
                "docker compose up -d succeeded.".to_string()
            } else {
                format!("docker compose up -d succeeded. {}", combined_output)
            };
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            return Ok("Hub started successfully".to_string());
        }

        last_error = combined_output.clone();
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!("docker compose up -d failed (attempt {}). {}", attempt, combined_output),
        );

        // Container name conflicts are self-healable: run compose down to clear them,
        // then retry.
        if is_container_name_conflict(&combined_output) && attempt < MAX_START_RETRIES {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Detected stale container name conflict — running compose down to self-heal.",
            );
            let _ = cleanup_stale_project_containers(compose_path, env_path, data_dir);
            // Brief pause to let Docker release resources.
            std::thread::sleep(std::time::Duration::from_secs(2));
            continue;
        }

        // OCI runtime errors indicate Docker Desktop / WSL2 issues — retrying without
        // user intervention is unlikely to help.
        if is_oci_runtime_error(&combined_output) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "OCI runtime error detected — Docker Desktop may need to be restarted. Stopping retries.",
            );
            break;
        }

        // Any other transient failure — wait a moment and retry.
        if attempt < MAX_START_RETRIES {
            std::thread::sleep(std::time::Duration::from_secs(2u64.pow(attempt)));
        }
    }

    let failure = if last_error.is_empty() {
        "docker compose up -d failed after all retry attempts.".to_string()
    } else {
        format!("docker compose up -d failed. {}", last_error)
    };
    let _ = append_desktop_log_for(data_dir, "hub.start", &failure);
    Err(with_view_logs_hint(failure))
}

/// Stop Hub containers
pub fn stop_hub(compose_path: &Path, env_path: &Path) -> Result<String, String> {
    let data_dir = get_hub_data_dir();
    let _ = append_desktop_log_for(
        &data_dir,
        "hub.stop",
        &format!(
            "Requested stop via docker compose down\ncompose={}\nenv={}",
            compose_path.display(),
            env_path.display()
        ),
    );

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
        .map_err(|e| {
            let message = format!("Failed to run docker compose down: {}", e);
            let _ = append_desktop_log_for(&data_dir, "hub.stop", &message);
            with_view_logs_hint(message)
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    if output.status.success() {
        let message = if combined_output.is_empty() {
            "docker compose down succeeded.".to_string()
        } else {
            format!("docker compose down succeeded. {}", combined_output)
        };
        let _ = append_desktop_log_for(&data_dir, "hub.stop", &message);
        Ok("Hub stopped".to_string())
    } else {
        let failure = if combined_output.is_empty() {
            format!(
                "docker compose down failed with exit code {:?}.",
                output.status.code()
            )
        } else {
            format!("docker compose down failed. {}", combined_output)
        };
        let _ = append_desktop_log_for(&data_dir, "hub.stop", &failure);
        Err(with_view_logs_hint(failure))
    }
}

pub fn stop_managed_app_containers() -> Result<Option<String>, String> {
    let output = docker_command()
        .args(managed_app_container_ps_args())
        .output()
        .map_err(|error| format!("Failed to list running app containers: {}", error))?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    if !output.status.success() {
        return Err(if combined_output.is_empty() {
            format!(
                "Listing running app containers failed with exit code {:?}.",
                output.status.code()
            )
        } else {
            format!("Listing running app containers failed. {}", combined_output)
        });
    }

    let ids = parse_container_ids(&String::from_utf8_lossy(&output.stdout));
    if ids.is_empty() {
        return Ok(None);
    }

    let mut command = docker_command();
    command.arg("stop");
    for id in &ids {
        command.arg(id);
    }

    let stop_output = command
        .output()
        .map_err(|error| format!("Failed to stop running app containers: {}", error))?;

    let combined_stop_output = format_command_output(
        &String::from_utf8_lossy(&stop_output.stdout),
        &String::from_utf8_lossy(&stop_output.stderr),
    );

    if stop_output.status.success() {
        Ok(Some(if combined_stop_output.is_empty() {
            format!("Stopped {} running app container(s).", ids.len())
        } else {
            format!(
                "Stopped {} running app container(s). {}",
                ids.len(),
                combined_stop_output
            )
        }))
    } else {
        Err(if combined_stop_output.is_empty() {
            format!(
                "Stopping running app containers failed with exit code {:?}.",
                stop_output.status.code()
            )
        } else {
            format!(
                "Stopping running app containers failed. {}",
                combined_stop_output
            )
        })
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
/// Returns the initialized desktop data paths and Traefik preflight result.
pub fn initialize_hub(resource_dir: &Path) -> Result<HubInitialization, String> {
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
    let _ = append_desktop_log_for(
        &data_dir,
        "initialize",
        &format!(
            "Initializing desktop resources from {}",
            resource_dir.display()
        ),
    );

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
        std::fs::copy(src, &compose_dst).map_err(|e| {
            let message = format!("Failed to copy compose file from {:?}: {}", src, e);
            let _ = append_desktop_log_for(&data_dir, "initialize", &message);
            with_view_logs_hint(message)
        })?;
        log_lines.push("  -> updated in data_dir".to_string());
    } else {
        log_lines.push("  -> WARNING: no compose file found in any candidate path!".to_string());
        let _ = append_desktop_log_for(
            &data_dir,
            "initialize",
            "No docker-compose.prod.yml resource was found in any candidate path.",
        );
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
    std::fs::write(&env_path, &env_content).map_err(|e| {
        let message = format!("Failed to write .env: {}", e);
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        with_view_logs_hint(message)
    })?;

    log_lines.push(format!("  .env changed: {}", env_changed));

    let traefik_preflight = prepare_traefik_runtime_state(&data_dir).map_err(|error| {
        let message = format!("Failed to prepare Traefik runtime state: {}", error);
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        with_view_logs_hint(message)
    })?;

    if traefik_preflight.changed {
        mark_traefik_recreate_required(&data_dir).map_err(|error| {
            let message = format!(
                "Traefik runtime state changed, but the recreate marker could not be written: {}",
                error
            );
            let _ = append_desktop_log_for(&data_dir, "initialize", &message);
            with_view_logs_hint(message)
        })?;
    }

    let recreate_pending = is_traefik_recreate_required(&data_dir);
    log_lines.push(format!(
        "  traefik preflight: changed={} repaired_conflicting_paths={} recreate_pending={}",
        traefik_preflight.changed, traefik_preflight.repaired_conflicting_paths, recreate_pending,
    ));

    // Write init log (append)
    let init_summary = log_lines.join("\n");
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "{}", init_summary)
        });
    let _ = append_desktop_log_for(&data_dir, "initialize", &init_summary);

    // Clean up legacy .docker-config.json if it exists
    let legacy_docker_config = data_dir.join(".docker-config.json");
    if legacy_docker_config.exists() {
        let _ = std::fs::remove_file(&legacy_docker_config);
    }

    Ok(HubInitialization {
        data_dir,
        compose_path: compose_dst,
        env_path,
        traefik_preflight,
    })
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

pub(crate) fn format_command_output(stdout: &str, stderr: &str) -> String {
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
    use super::{
        append_desktop_log_for, classify_docker_access_result, clear_traefik_recreate_required,
        desktop_log_path_for, format_command_output, is_container_name_conflict,
        is_oci_runtime_error, is_traefik_recreate_required, logs_open_target_for,
        managed_app_container_ps_args, mark_traefik_recreate_required, parse_container_ids,
        prepare_traefik_runtime_state, seeded_traefik_config_contents, truncate_command_output,
        DockerAccessState, MAX_COMMAND_OUTPUT_CHARS, TRAEFIK_ACME_FILE, TRAEFIK_CONFIG_FILE,
        TRAEFIK_DYNAMIC_CONFIG_SEED, TRAEFIK_DYNAMIC_FILE, TRAEFIK_TLS_DIR,
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use std::os::unix::fs::PermissionsExt;

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

    #[test]
    fn classifies_windows_named_pipe_not_found_as_daemon_unavailable() {
        let result = classify_docker_access_result(
            "open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
            Some(1),
        );

        assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
    }

    #[test]
    fn classifies_windows_access_denied_as_permission_issue() {
        let result = classify_docker_access_result(
            "open //./pipe/docker_engine: Access is denied. In the default daemon configuration on Windows, the docker client must be run with elevated privileges to connect.",
            Some(1),
        );

        assert!(matches!(result.state, DockerAccessState::PermissionDenied));
    }

    #[test]
    fn truncates_long_command_output() {
        let output = "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 25);
        let truncated = truncate_command_output(&output);

        assert!(truncated.contains("[truncated 25 chars]"));
        assert!(truncated.starts_with(&"x".repeat(MAX_COMMAND_OUTPUT_CHARS)));
    }

    #[test]
    fn formats_stdout_and_stderr_with_truncation() {
        let stdout = "ok";
        let stderr = "y".repeat(MAX_COMMAND_OUTPUT_CHARS + 10);
        let formatted = format_command_output(stdout, &stderr);

        assert!(formatted.starts_with("stdout: ok | stderr: "));
        assert!(formatted.contains("[truncated 10 chars]"));
    }

    #[test]
    fn appends_desktop_log_entries_to_the_consolidated_log() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let log_path =
            append_desktop_log_for(tempdir.path(), "hub.start", "first line\nsecond line")
                .expect("append desktop log");
        let content = std::fs::read_to_string(log_path).expect("read log");

        assert!(content.contains("hub.start: first line"));
        assert!(content.contains("    second line"));
    }

    #[test]
    fn view_logs_opens_the_logs_folder_even_when_desktop_log_exists() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let logs_dir = tempdir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).expect("create logs dir");

        assert_eq!(logs_open_target_for(tempdir.path()), logs_dir);

        let desktop_log = desktop_log_path_for(tempdir.path());
        std::fs::write(&desktop_log, "ready").expect("write desktop log");

        assert_eq!(logs_open_target_for(tempdir.path()), logs_dir);
    }

    #[test]
    fn tray_stop_targets_running_app_containers_by_ci_hub_labels() {
        assert_eq!(
            managed_app_container_ps_args(),
            [
                "ps",
                "-q",
                "--filter",
                "label=ci-os-hub.managed=true",
                "--filter",
                "label=ci-os-hub.appurn",
            ]
        );
    }

    #[test]
    fn parses_running_app_container_ids_from_docker_ps_output() {
        assert_eq!(
            parse_container_ids("abc123\n\n def456 \n"),
            vec!["abc123".to_string(), "def456".to_string()]
        );
    }

    #[test]
    fn prepares_fresh_traefik_runtime_state_for_desktop_runtime() {
        let tempdir = tempfile::tempdir().expect("tempdir");

        let result = prepare_traefik_runtime_state(tempdir.path()).expect("prepare traefik");

        let config_path = tempdir.path().join(TRAEFIK_CONFIG_FILE);
        let dynamic_path = tempdir.path().join(TRAEFIK_DYNAMIC_FILE);
        let acme_path = tempdir.path().join(TRAEFIK_ACME_FILE);
        let tls_dir = tempdir.path().join(TRAEFIK_TLS_DIR);

        assert!(result.changed);
        assert!(!result.repaired_conflicting_paths);
        assert!(config_path.is_file());
        assert!(dynamic_path.is_file());
        assert!(acme_path.is_file());
        assert!(tls_dir.is_dir());
        assert_eq!(
            std::fs::read_to_string(&config_path).expect("read traefik config"),
            seeded_traefik_config_contents()
        );
        assert_eq!(
            std::fs::read_to_string(&dynamic_path).expect("read dynamic config"),
            TRAEFIK_DYNAMIC_CONFIG_SEED
        );
        assert_eq!(
            std::fs::read_to_string(&acme_path).expect("read acme file"),
            "{}"
        );
        assert!(!is_traefik_recreate_required(tempdir.path()));

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let mode = std::fs::metadata(&acme_path)
                .expect("acme metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn heals_poisoned_traefik_mount_paths_back_to_files() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let config_path = tempdir.path().join(TRAEFIK_CONFIG_FILE);
        let dynamic_path = tempdir.path().join(TRAEFIK_DYNAMIC_FILE);
        let acme_path = tempdir.path().join(TRAEFIK_ACME_FILE);

        std::fs::create_dir_all(&config_path).expect("create poisoned config directory");
        std::fs::create_dir_all(&dynamic_path).expect("create poisoned dynamic directory");
        std::fs::create_dir_all(&acme_path).expect("create poisoned acme directory");

        let result = prepare_traefik_runtime_state(tempdir.path()).expect("prepare traefik");

        assert!(result.changed);
        assert!(result.repaired_conflicting_paths);
        assert!(config_path.is_file());
        assert!(dynamic_path.is_file());
        assert!(acme_path.is_file());
        assert_eq!(
            std::fs::read_to_string(&config_path).expect("read healed traefik config"),
            seeded_traefik_config_contents()
        );
        assert_eq!(
            std::fs::read_to_string(&dynamic_path).expect("read healed dynamic config"),
            TRAEFIK_DYNAMIC_CONFIG_SEED
        );
        assert_eq!(
            std::fs::read_to_string(&acme_path).expect("read healed acme file"),
            "{}"
        );
    }

    #[test]
    fn traefik_recreate_marker_can_be_set_and_cleared() {
        let tempdir = tempfile::tempdir().expect("tempdir");

        assert!(!is_traefik_recreate_required(tempdir.path()));

        mark_traefik_recreate_required(tempdir.path()).expect("mark recreate required");
        assert!(is_traefik_recreate_required(tempdir.path()));

        clear_traefik_recreate_required(tempdir.path()).expect("clear recreate required");
        assert!(!is_traefik_recreate_required(tempdir.path()));
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

    // --- is_container_name_conflict / is_oci_runtime_error classifiers ---

    #[test]
    fn detects_container_name_conflict_from_docker_daemon_message() {
        let output = r#"Error response from daemon: Conflict. The container name "/ci-hub-app" is already in use by container "8dfafdbc3a40". You have to remove (or rename) that container to be able to reuse that name."#;
        assert!(is_container_name_conflict(output));
        assert!(!is_oci_runtime_error(output));
    }

    #[test]
    fn detects_container_name_conflict_case_insensitively() {
        let output = r#"service-app-1  Recreate
Error response from daemon: CONFLICT. The container name "/ci-hub-app" IS ALREADY IN USE BY CONTAINER "8dfafdbc3a40"."#;
        assert!(is_container_name_conflict(output));
    }

    #[test]
    fn does_not_treat_port_allocation_failure_as_container_name_conflict() {
        let output = "Error response from daemon: driver failed programming external connectivity on endpoint ci-hub-app-1: Bind for 0.0.0.0:5432 failed: port is already allocated";
        assert!(!is_container_name_conflict(output));
    }

    #[test]
    fn detects_oci_runtime_create_failed_message() {
        let output = r#"Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: "/app/start.sh": stat /app/start.sh: no such file or directory: unknown"#;
        assert!(is_oci_runtime_error(output));
        assert!(!is_container_name_conflict(output));
    }

    #[test]
    fn detects_failed_to_create_shim_task_message() {
        let output = "service-app-1  Starting\nError response from daemon: failed to create shim task: context deadline exceeded: unknown";
        assert!(is_oci_runtime_error(output));
    }

    #[test]
    fn does_not_treat_pull_access_denied_as_oci_runtime_error() {
        let output = "Error response from daemon: pull access denied for ci-hub-app, repository does not exist or may require 'docker login'";
        assert!(!is_oci_runtime_error(output));
    }
}
