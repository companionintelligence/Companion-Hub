use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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

/// Serialize rotation + append so concurrent callers cannot interleave
/// renames and writes to `desktop.log`.
static LOG_WRITE_LOCK: Mutex<()> = Mutex::new(());

const MAX_COMMAND_OUTPUT_CHARS: usize = 50_000;
const DESKTOP_LOG_FILENAME: &str = "desktop.log";
#[cfg(target_os = "windows")]
const HUB_ENV_FILENAME: &str = ".env";
#[cfg(not(target_os = "windows"))]
const HUB_ENV_FILENAME: &str = ".env.dev";
#[cfg(target_os = "windows")]
const COMPAT_HUB_ENV_FILENAME: &str = ".env.dev";
#[cfg(not(target_os = "windows"))]
const COMPAT_HUB_ENV_FILENAME: &str = ".env";
const HUB_COMPOSE_FILENAME: &str = "docker-compose.prod.yml";
/// Maximum size of desktop.log before rotation (5 MB).
const MAX_LOG_SIZE_BYTES: u64 = 5 * 1024 * 1024;
/// Number of rotated log files to keep (desktop.log.1, desktop.log.2, ...).
const MAX_LOG_ROTATIONS: usize = 3;
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
const INTERNAL_DOCKER_CONFIG_FILE: &str = ".internal/docker-config.json";
const HUB_DOCKER_CONFIG_FILE: &str = "docker-config.json";
const HUB_START_HEALTHY_TIMEOUT_SECS: u64 = 180;
const DB_START_HEALTHY_TIMEOUT_SECS: u64 = 180;

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

/// A single service's startup state, reported to the frontend loading screen.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    /// Container does not exist yet (pull / create pending).
    Pending,
    /// Container exists but health-check has not passed yet.
    Starting,
    /// Container is running and healthy (or has no health-check and is running).
    Ready,
    /// Container exited or is in an error state.
    Failed,
}

/// Per-service startup info returned to the frontend.
#[derive(Clone, serde::Serialize)]
pub struct ServiceStatus {
    /// Short human-readable label, e.g. "Database".
    pub label: String,
    /// Docker container name, e.g. "ci-hub-db".
    pub container: String,
    pub state: ServiceState,
}

/// Aggregate startup progress across all core Hub services.
#[derive(Clone, serde::Serialize)]
pub struct StartupProgress {
    /// Per-service breakdown.
    pub services: Vec<ServiceStatus>,
    /// 0..=100 overall progress percentage (average of required service states).
    pub progress_pct: u8,
    /// Number of required startup images that are present locally.
    pub image_pulled: u8,
    /// Total number of required startup images.
    pub image_total: u8,
    /// 0..=100 image pull progress percentage.
    pub image_pull_pct: u8,
    /// True once every service is Ready.
    pub all_ready: bool,
}

fn list_local_images() -> std::collections::HashSet<String> {
    let output = docker_command()
        .args(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.ends_with(":<none>"))
        .map(ToOwned::to_owned)
        .collect()
}

fn required_startup_images() -> Vec<String> {
    let env = parse_env_file(&hub_env_path());
    let domain = env
        .get("DOMAIN")
        .map(String::as_str)
        .unwrap_or("companionintelligence.com");
    let hub_image = env
        .get("CI_HUB_IMAGE")
        .cloned()
        .unwrap_or_else(|| image_for_domain(domain).to_string());

    vec![
        hub_image,
        "postgres:14".to_string(),
        "rabbitmq:4-alpine".to_string(),
        "traefik:v3.6.7".to_string(),
    ]
}

/// Query Docker for a list of container states in one `docker inspect` call.
/// Returns a map of container_name → (state, health).
fn inspect_containers(names: &[&str]) -> std::collections::HashMap<String, (String, String)> {
    let mut map = std::collections::HashMap::new();
    if names.is_empty() {
        return map;
    }
    let format = "{{.Name}}:{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}";
    let output = docker_command()
        .arg("inspect")
        .arg("--format")
        .arg(format)
        .args(names)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    for line in output.lines() {
        // Docker prefixes the name with "/" in inspect output
        let line = line.trim().trim_start_matches('/');
        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() == 3 {
            map.insert(
                parts[0].to_string(),
                (parts[1].to_string(), parts[2].to_string()),
            );
        }
    }
    map
}

/// Derive a ServiceState from raw Docker state/health strings.
fn derive_service_state(state: &str, health: &str) -> ServiceState {
    match state {
        "running" => {
            if health == "healthy" || health == "none" {
                ServiceState::Ready
            } else {
                ServiceState::Starting
            }
        }
        "created" | "restarting" => ServiceState::Starting,
        "exited" | "dead" => ServiceState::Failed,
        _ => ServiceState::Pending,
    }
}

/// Translate a service state to a progress score used by averaged startup progress.
///
/// Pending means the container likely does not exist yet (pull/create still in progress),
/// so we keep a small non-zero floor to indicate startup has begun.
fn service_state_score(state: &ServiceState) -> u8 {
    match state {
        ServiceState::Pending => 15,
        ServiceState::Starting => 60,
        ServiceState::Ready => 100,
        ServiceState::Failed => 0,
    }
}

/// Return per-service startup progress for the frontend loading screen.
pub fn get_startup_progress() -> StartupProgress {
    // Core services in startup order. Optional ones (cloudflared, headscale, etc.) are
    // included for visibility but do not block the "all_ready" gate.
    let core: &[(&str, &str, bool)] = &[
        ("ci-hub-db",        "Database",       true),
        ("ci-os-hub-queue",  "Message queue",  true),
        ("ci-os-hub",        "Hub backend",    true),
        ("traefik",          "Router",         true),
    ];
    let optional: &[(&str, &str, bool)] = &[
        ("cloudflared",  "Tunnel",      false),
        ("headscale",    "VPN server",  false),
        ("headplane",    "VPN admin",   false),
        ("hub-tailscale","Tailscale",   false),
    ];

    let all_names: Vec<&str> = core.iter().chain(optional.iter()).map(|(n, _, _)| *n).collect();
    let states = inspect_containers(&all_names);

    let mut services: Vec<ServiceStatus> = Vec::new();
    let mut ready_core: usize = 0;
    let mut core_score_sum: usize = 0;

    for (container, label, _required) in core.iter().chain(optional.iter()) {
        let (state_str, health_str) = states
            .get(*container)
            .map(|(s, h)| (s.as_str(), h.as_str()))
            .unwrap_or(("", ""));
        let svc_state = if state_str.is_empty() {
            ServiceState::Pending
        } else {
            derive_service_state(state_str, health_str)
        };
        services.push(ServiceStatus {
            label: label.to_string(),
            container: container.to_string(),
            state: svc_state,
        });
    }

    // Count ready core services and compute average core score for progress %.
    for (i, (_, _, required)) in core.iter().chain(optional.iter()).enumerate() {
        if *required {
            core_score_sum += service_state_score(&services[i].state) as usize;
            if let ServiceState::Ready = services[i].state {
                ready_core += 1;
            }
        }
    }

    let core_count = core.len();
    let progress_pct = if core_count == 0 {
        0
    } else {
        (core_score_sum / core_count) as u8
    };

    let required_images = required_startup_images();
    let local_images = list_local_images();
    let image_total = required_images.len() as u8;
    let image_pulled = required_images
        .iter()
        .filter(|img| local_images.contains(img.as_str()))
        .count() as u8;
    let image_pull_pct = if image_total == 0 {
        100
    } else {
        ((image_pulled as usize * 100) / image_total as usize) as u8
    };

    let all_ready = ready_core == core_count;

    StartupProgress {
        services,
        progress_pct,
        image_pulled,
        image_total,
        image_pull_pct,
        all_ready,
    }
}

/// Get the current status of the Hub by inspecting the Docker container.
pub fn get_hub_status() -> HubStatus {
    // If a start operation is actively running (including first-time image pulls),
    // report Starting so the frontend shows progress instead of a false "Stopped" state.
    if START_IN_PROGRESS.load(Ordering::SeqCst) {
        return HubStatus::Starting;
    }

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

pub fn hub_env_path_for(data_dir: &Path) -> PathBuf {
    data_dir.join(HUB_ENV_FILENAME)
}

pub fn hub_env_path() -> PathBuf {
    hub_env_path_for(&get_hub_data_dir())
}

fn compat_hub_env_path_for(data_dir: &Path) -> PathBuf {
    data_dir.join(COMPAT_HUB_ENV_FILENAME)
}

fn load_runtime_env_values(
    data_dir: &Path,
    env_path: &Path,
) -> std::collections::HashMap<String, String> {
    let compat_path = compat_hub_env_path_for(data_dir);
    let mut values = if compat_path != env_path {
        parse_env_file(&compat_path)
    } else {
        std::collections::HashMap::new()
    };
    values.extend(parse_env_file(env_path));
    values
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
    let logs_dir = logs_dir_for(data_dir);
    let log_path = desktop_log_path_for(data_dir);
    let entry = format_log_entry(operation, message);

    if let Err(err) = std::fs::create_dir_all(&logs_dir) {
        // Fallback: emit to stderr so the entry is not silently lost.
        stderr_fallback(&format!(
            "[desktop-log-fallback] create_dir_all({}) failed: {}",
            logs_dir.display(),
            err
        ));
        stderr_fallback(&entry);
        return Err(err);
    }

    // Hold the lock across rotation + write so concurrent callers cannot
    // interleave renames and appends.
    let _lock = LOG_WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    rotate_log_if_needed(&log_path, &logs_dir, MAX_LOG_SIZE_BYTES);
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(mut file) => {
            use std::io::Write;
            if let Err(err) = file.write_all(entry.as_bytes()) {
                stderr_fallback(&format!(
                    "[desktop-log-fallback] failed to append to {}: {}",
                    log_path.display(),
                    err
                ));
                stderr_fallback(&entry);
                return Err(err);
            }
        }
        Err(err) => {
            // Last-resort fallback: write to stderr so the message is not
            // silently lost when the log file cannot be opened.
            stderr_fallback(&format!(
                "[desktop-log-fallback] failed to write {}: {}",
                log_path.display(),
                err
            ));
            stderr_fallback(&entry);
            return Err(err);
        }
    }
    Ok(log_path)
}

/// Write `msg` to stderr without panicking.  In a GUI desktop app stderr
/// can be closed/missing, so we must not use `eprintln!` (which unwraps
/// internally).
fn stderr_fallback(msg: &str) {
    use std::io::Write;
    let _ = std::io::stderr().write_all(msg.as_bytes());
    // Ensure a trailing newline so entries don't run together.
    if !msg.ends_with('\n') {
        let _ = std::io::stderr().write_all(b"\n");
    }
}

/// Rotate `desktop.log` when it reaches or exceeds `max_size` bytes.
///
/// Checked before each append, so the active file may slightly exceed
/// `max_size` by the size of the most recent log entry.
///
/// Keeps up to `MAX_LOG_ROTATIONS` historical files:
///   desktop.log.3 → deleted
///   desktop.log.2 → desktop.log.3
///   desktop.log.1 → desktop.log.2
///   desktop.log   → desktop.log.1
fn rotate_log_if_needed(log_path: &Path, logs_dir: &Path, max_size: u64) {
    let size = match std::fs::metadata(log_path) {
        Ok(metadata) => metadata.len(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
        Err(err) => {
            stderr_fallback(&format!(
                "[log-rotate] failed to read metadata for {}: {}",
                log_path.display(),
                err
            ));
            return;
        }
    };
    if size < max_size {
        return;
    }

    // Remove the oldest rotation explicitly (it will be shifted off the end).
    let oldest = logs_dir.join(format!("{}.{}", DESKTOP_LOG_FILENAME, MAX_LOG_ROTATIONS));
    remove_if_exists(&oldest);

    // Shift existing rotations: .2→.3, .1→.2, current→.1.
    // Try rename first; only delete dst and retry when the error is AlreadyExists
    // (Windows) so we don't discard a valid rotated file on other failures.
    for i in (1..MAX_LOG_ROTATIONS).rev() {
        let src = logs_dir.join(format!("{}.{}", DESKTOP_LOG_FILENAME, i));
        let dst = logs_dir.join(format!("{}.{}", DESKTOP_LOG_FILENAME, i + 1));
        rename_or_replace(&src, &dst);
    }
    let rotated = logs_dir.join(format!("{}.1", DESKTOP_LOG_FILENAME));
    rename_or_replace(log_path, &rotated);
}

/// Remove a file, ignoring "not found" but logging other errors to stderr.
fn remove_if_exists(path: &Path) {
    if let Err(err) = std::fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            stderr_fallback(&format!(
                "[log-rotate] failed to remove {}: {}",
                path.display(),
                err
            ));
        }
    }
}

/// Rename `src` to `dst`, skipping silently when `src` doesn't exist.
/// On `AlreadyExists` (Windows), removes `dst` and retries so that the
/// existing destination is only deleted when the rename can actually proceed.
fn rename_or_replace(src: &Path, dst: &Path) {
    match std::fs::rename(src, dst) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            remove_if_exists(dst);
            if let Err(retry_err) = std::fs::rename(src, dst) {
                if retry_err.kind() != std::io::ErrorKind::NotFound {
                    stderr_fallback(&format!(
                        "[log-rotate] failed to rename {} -> {}: {}",
                        src.display(),
                        dst.display(),
                        retry_err
                    ));
                }
            }
        }
        Err(err) => {
            stderr_fallback(&format!(
                "[log-rotate] failed to rename {} -> {}: {}",
                src.display(),
                dst.display(),
                err
            ));
        }
    }
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

fn ensure_internal_docker_config_state(data_dir: &Path) -> Result<TraefikRuntimePreflight, String> {
    ensure_runtime_file(
        &data_dir.join(INTERNAL_DOCKER_CONFIG_FILE),
        "{}",
        None,
    )
}

fn ensure_hub_docker_config_state(data_dir: &Path) -> Result<TraefikRuntimePreflight, String> {
    ensure_runtime_file(&data_dir.join(HUB_DOCKER_CONFIG_FILE), "{}", None)
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
        .env("ENV_FILE", env_path)
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
        .map_err(|e| {
            let message = format!("Failed to run cleanup compose down: {}", e);
            let _ = append_desktop_log_for(data_dir, "hub.cleanup", &message);
            message
        })?;

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

fn is_docker_config_mount_path_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("docker-config.json")
        && (lower.contains("not a directory")
            || lower.contains("is a directory")
            || lower.contains("mount a directory onto a file"))
}

fn inspect_container_state_health(container_name: &str) -> String {
    docker_command()
        .args([
            "inspect",
            "--format",
            "{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
            container_name,
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn wait_for_container_healthy(
    container_name: &str,
    display_name: &str,
    timeout_secs: u64,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_status = String::new();

    while Instant::now() < deadline {
        let status = inspect_container_state_health(container_name);
        if !status.is_empty() {
            last_status = status.clone();
        }

        if status == "running:healthy" {
            return Ok(());
        }

        let state = status.split(':').next().unwrap_or("");
        if matches!(state, "exited" | "dead") {
            return Err(format!(
                "{} container exited during startup (status: {}).",
                display_name, status
            ));
        }

        std::thread::sleep(Duration::from_secs(1));
    }

    Err(format!(
        "Timed out waiting for {} to become healthy (last status: {}).",
        display_name,
        if last_status.is_empty() {
            "unknown"
        } else {
            &last_status
        }
    ))
}

fn wait_for_hub_healthy() -> Result<(), String> {
    wait_for_container_healthy("ci-os-hub", "Hub", HUB_START_HEALTHY_TIMEOUT_SECS)
}

fn start_database_first(compose_path: &Path, env_path: &Path, data_dir: &Path) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Starting database service first to ensure initialization before full stack startup.",
    );

    let output = docker_command()
        .env("ENV_FILE", env_path)
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
            "ci-hub-db",
        ])
        .output()
        .map_err(|error| {
            let message = format!("Failed to start database service: {}", error);
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    if !output.status.success() {
        let failure = if combined_output.is_empty() {
            format!(
                "Database bootstrap failed with exit code {:?}.",
                output.status.code()
            )
        } else {
            format!("Database bootstrap failed. {}", combined_output)
        };
        let _ = append_desktop_log_for(data_dir, "hub.start", &failure);
        return Err(with_view_logs_hint(failure));
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Database bootstrap command succeeded. Waiting for ci-hub-db health.",
    );

    wait_for_container_healthy("ci-hub-db", "Database", DB_START_HEALTHY_TIMEOUT_SECS).map_err(
        |error| {
            let message = format!("Database did not become healthy after bootstrap: {}", error);
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        },
    )
}

/// Start Hub using docker compose up (with port conflict resolution).
///
/// Uses a global `AtomicBool` guard to prevent concurrent invocations.
/// A `Drop` guard ensures the flag is cleared even if the inner logic panics.
pub fn start_hub(compose_path: &Path, env_path: &Path, data_dir: &Path) -> Result<String, String> {
    // Prevent concurrent start attempts.
    if START_IN_PROGRESS.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err()
    {
        let message = "A Hub start operation is already in progress — skipping duplicate request.";
        let _ = append_desktop_log_for(data_dir, "hub.start", message);
        return Ok(message.to_string());
    }

    // RAII guard: always clear the flag when the function exits, including panics.
    struct StartGuard;
    impl Drop for StartGuard {
        fn drop(&mut self) {
            START_IN_PROGRESS.store(false, Ordering::SeqCst);
        }
    }
    let _guard = StartGuard;

    start_hub_inner(compose_path, env_path, data_dir)
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

    if !compose_path.exists() {
        let recover_candidates = compose_resource_candidates(
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(Path::to_path_buf))
                .as_deref()
                .unwrap_or(Path::new(".")),
        );

        if let Some(src) = recover_candidates.iter().find(|candidate| candidate.exists()) {
            std::fs::copy(src, compose_path).map_err(|error| {
                let message = format!(
                    "Compose file was missing and recovery copy from {} failed: {}",
                    src.display(),
                    error
                );
                let _ = append_desktop_log_for(data_dir, "hub.start", &message);
                with_view_logs_hint(message)
            })?;
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Recovered missing compose file at {} from {}",
                    compose_path.display(),
                    src.display()
                ),
            );
        }
    }

    // Ensure the file-mounted Docker config path is a file, not a directory.
    // If Docker ever created this path with the wrong type, compose startup fails
    // with an OCI runtime mount error.
    ensure_hub_docker_config_state(data_dir).map_err(|error| {
        let message = format!(
            "Failed to prepare internal docker-config file before startup: {}",
            error
        );
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    let env_changed = ensure_runtime_env_state(data_dir, env_path).map_err(|error| {
        let message = format!("Failed to prepare runtime env state before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;
    if env_changed {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "Runtime env file was repaired before startup: {}",
                env_path.display()
            ),
        );
    }

    // Resolve port conflicts and write to the runtime env file before starting.
    let resolution = crate::port_manager::refresh_ports_if_needed(env_path).map_err(|error| {
        let message = format!("Port resolution failed before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    // Log port resolution results (centralised into desktop.log)
    let mut log_lines = vec!["Port resolution:".to_string()];
    for w in &resolution.warnings {
        log_lines.push(format!("  WARN: {}", w));
    }
    for i in &resolution.info {
        log_lines.push(format!("  INFO: {}", i));
    }
    for (var, port) in &resolution.env_vars {
        log_lines.push(format!("  {}={}", var, port));
    }
    let _ = append_desktop_log_for(data_dir, "hub.start", &log_lines.join("\n"));

    // Bring up PostgreSQL first and wait for health so role/database initialization
    // completes before the rest of the stack starts.
    start_database_first(compose_path, env_path, data_dir)?;

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
            .env("ENV_FILE", env_path)
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
            let compose_message = if combined_output.is_empty() {
                "docker compose up -d succeeded.".to_string()
            } else {
                format!("docker compose up -d succeeded. {}", combined_output)
            };
            let _ = append_desktop_log_for(data_dir, "hub.start", &compose_message);
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Waiting for ci-os-hub to report running:healthy.",
            );

            match wait_for_hub_healthy() {
                Ok(()) => {
                    let _ = append_desktop_log_for(
                        data_dir,
                        "hub.start",
                        "Hub reached running:healthy state.",
                    );
                    return Ok("Hub started successfully".to_string());
                }
                Err(error) => {
                    let message = format!(
                        "docker compose up -d succeeded but Hub did not become ready: {}",
                        error
                    );
                    let _ = append_desktop_log_for(data_dir, "hub.start", &message);
                    return Err(with_view_logs_hint(message));
                }
            }
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

        // The host path for /root/.docker/config.json can be poisoned as a directory.
        // Self-heal it and retry automatically.
        if is_docker_config_mount_path_error(&combined_output) && attempt < MAX_START_RETRIES {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Detected docker-config mount path type mismatch — attempting self-heal and retry.",
            );
            if let Err(error) = ensure_internal_docker_config_state(data_dir) {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!(
                        "Self-heal of internal docker-config path failed before retry: {}",
                        error
                    ),
                );
            }
            if let Err(error) = ensure_hub_docker_config_state(data_dir) {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!(
                        "Self-heal of hub docker-config path failed before retry: {}",
                        error
                    ),
                );
            }
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }

        // Other OCI runtime errors indicate Docker Desktop / WSL2 issues — retrying without
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
        .env("ENV_FILE", env_path)
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

fn get_non_empty_env_value(
    existing: &std::collections::HashMap<String, String>,
    key: &str,
) -> Option<String> {
    existing
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn render_runtime_env_content(
    data_dir: &Path,
    existing: &std::collections::HashMap<String, String>,
) -> String {
    let root_folder_host = get_non_empty_env_value(existing, "ROOT_FOLDER_HOST")
        .unwrap_or_else(|| compute_data_dir_str(data_dir));
    let jwt_secret =
        get_non_empty_env_value(existing, "JWT_SECRET").unwrap_or_else(|| generate_hex(64));
    let postgres_password = get_non_empty_env_value(existing, "POSTGRES_PASSWORD")
        .unwrap_or_else(|| generate_hex(32));

    let domain = option_env!("CI_HUB_DOMAIN").unwrap_or("companionintelligence.com");
    let cloud_url =
        option_env!("CI_HUB_CLOUD_URL").unwrap_or("https://hub.companionintelligence.com");
    let hub_version = option_env!("CI_HUB_BUILD_VERSION").unwrap_or("4.7.0");
    let hub_image = get_non_empty_env_value(existing, "CI_HUB_IMAGE")
        .unwrap_or_else(|| image_for_domain(domain).to_string());
    let docker_platform = if cfg!(target_arch = "aarch64") {
        "linux/arm64"
    } else {
        "linux/amd64"
    };
    let docker_config_path = data_dir.join(HUB_DOCKER_CONFIG_FILE);

    format!(
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
         DOCKER_PLATFORM={docker_platform}\n\
         DOCKER_CONFIG_PATH={docker_config_path}\n",
        root_folder_host = root_folder_host,
        jwt_secret = jwt_secret,
        postgres_password = postgres_password,
        domain = domain,
        cloud_url = cloud_url,
        hub_version = hub_version,
        hub_image = hub_image,
        docker_platform = docker_platform,
        docker_config_path = docker_config_path.display(),
    )
}

fn ensure_runtime_env_state(data_dir: &Path, env_path: &Path) -> Result<bool, String> {
    let existing = load_runtime_env_values(data_dir, env_path);
    let env_content = render_runtime_env_content(data_dir, &existing);
    let previous_content = std::fs::read_to_string(env_path).unwrap_or_default();
    let changed = strip_port_vars(&previous_content) != env_content;

    if changed {
        std::fs::write(env_path, &env_content).map_err(|e| {
            format!(
                "Failed to write runtime env file at {}: {}",
                env_path.display(),
                e
            )
        })?;
    }

    let compat_env_path = compat_hub_env_path_for(data_dir);
    if compat_env_path != env_path {
        let _ = std::fs::write(&compat_env_path, &env_content);
    }

    Ok(changed)
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

fn compose_resource_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    vec![
        resource_dir.join(HUB_COMPOSE_FILENAME),
        resource_dir.join("resources").join(HUB_COMPOSE_FILENAME),
        std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .unwrap_or(Path::new("."))
            .join("resources")
            .join(HUB_COMPOSE_FILENAME),
        PathBuf::from("/usr/lib/Companion Hub/resources").join(HUB_COMPOSE_FILENAME),
        PathBuf::from("/usr/share/companion-hub").join(HUB_COMPOSE_FILENAME),
    ]
}

/// Initialize Hub data directory and generate .env file.
///
/// Uses a regenerate-and-preserve approach:
/// - Preserved values (read from existing .env, generated if missing): ROOT_FOLDER_HOST, JWT_SECRET, POSTGRES_PASSWORD
/// - Derived values (always recomputed from the current binary): INTERNAL_IP, DOMAIN, CI_CLOUD_URL, CI_HUB_VERSION, CI_HUB_IMAGE, DOCKER_PLATFORM, DOCKER_CONFIG_PATH
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
        ".internal",
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
    let compose_candidates = compose_resource_candidates(resource_dir);

    let mut log_lines = vec![format!("initialize_hub: resource_dir = {:?}", resource_dir)];
    for (i, candidate) in compose_candidates.iter().enumerate() {
        log_lines.push(format!(
            "  candidate[{}]: {:?} exists={}",
            i,
            candidate,
            candidate.exists()
        ));
    }

    let compose_src = compose_candidates.iter().find(|p| p.exists());
    let compose_dst = data_dir.join(HUB_COMPOSE_FILENAME);

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

    // --- Regenerate the runtime env file with preserve-and-derive approach ---
    if let Err(error) = generate_container_docker_config(&data_dir, None) {
        let message = format!("Failed to generate .internal/docker-config.json: {}", error);
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        return Err(with_view_logs_hint(message));
    }
    log_lines.push("  docker-config: .internal/docker-config.json ready".to_string());

    let env_path = hub_env_path_for(&data_dir);
    let existing = load_runtime_env_values(&data_dir, &env_path);

    // Build .env content with deterministic key order
    let env_content = render_runtime_env_content(&data_dir, &existing);

    // Write the primary runtime env file (port manager will append dynamic port vars after this)
    let old_content = std::fs::read_to_string(&env_path).unwrap_or_default();
    // Strip port vars from old content for comparison (port manager manages those)
    let env_changed = strip_port_vars(&old_content) != env_content;
    std::fs::write(&env_path, &env_content).map_err(|e| {
        let message = format!("Failed to write {}: {}", env_path.display(), e);
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        with_view_logs_hint(message)
    })?;

    let compat_env_path = compat_hub_env_path_for(&data_dir);
    if compat_env_path != env_path {
        let _ = std::fs::write(&compat_env_path, &env_content);
    }

    log_lines.push(format!("  {} changed: {}", env_path.display(), env_changed));

    let mut traefik_preflight = prepare_traefik_runtime_state(&data_dir).map_err(|error| {
        let message = format!("Failed to prepare Traefik runtime state: {}", error);
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        with_view_logs_hint(message)
    })?;

    let internal_preflight = ensure_internal_docker_config_state(&data_dir).map_err(|error| {
        let message = format!(
            "Failed to prepare internal docker-config runtime state: {}",
            error
        );
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        with_view_logs_hint(message)
    })?;
    traefik_preflight.merge(internal_preflight);

    let hub_docker_config_preflight = ensure_hub_docker_config_state(&data_dir).map_err(|error| {
        let message = format!(
            "Failed to prepare hub docker-config runtime state: {}",
            error
        );
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        with_view_logs_hint(message)
    })?;
    traefik_preflight.merge(hub_docker_config_preflight);

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

    // Log init summary (centralised into desktop.log)
    let init_summary = log_lines.join("\n");
    let _ = append_desktop_log_for(&data_dir, "initialize", &init_summary);

    // Clean up legacy files that are no longer used
    let legacy_docker_config = data_dir.join(".docker-config.json");
    if legacy_docker_config.exists() {
        let _ = std::fs::remove_file(&legacy_docker_config);
    }
    for legacy_log in ["init.log", "port-resolution.log"] {
        let path = logs_dir_for(&data_dir).join(legacy_log);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }

    Ok(HubInitialization {
        data_dir,
        compose_path: compose_dst,
        env_path,
        traefik_preflight,
    })
}

/// Generate a container-safe Docker config at `.internal/docker-config.json`.
///
/// Reads the host's `~/.docker/config.json`, strips host-only fields that
/// break the Docker CLI inside Linux containers (currentContext, credsStore
/// set to desktop/osxkeychain/wincred/secretservice/pass, plugins, features,
/// hooks), preserves inline `auth` entries, and also preserves `credsStore`
/// and `credHelpers` entries when they are not in the host-only list.
///
/// If the destination path is a directory (stale Docker placeholder from a
/// previous failed mount), it is removed first.
///
/// `host_docker_dir` overrides the default `~/.docker` directory (used by
/// tests to avoid mutating global environment variables).
fn generate_container_docker_config(
    data_dir: &Path,
    host_docker_dir: Option<&Path>,
) -> Result<(), String> {
    let internal_dir = data_dir.join(".internal");
    let config_path = internal_dir.join("docker-config.json");

    // On Windows, Docker may have created a directory at this path when the
    // file was missing during a previous `docker compose up`.  Remove it so
    // we can write a proper file.  Use symlink_metadata to avoid following
    // symlinks — refuse to proceed if the path is a symlink.
    match std::fs::symlink_metadata(&config_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "Refusing to write Docker config at {:?} because the destination is a symlink",
                config_path
            ));
        }
        Ok(metadata) if metadata.is_dir() => {
            match std::fs::remove_dir_all(&config_path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(format!(
                        "Cannot remove stale directory at {:?}: {}",
                        config_path, e
                    ));
                }
            }
        }
        Ok(_) => {} // Regular file — will be overwritten below
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // Does not exist yet
        Err(e) => {
            return Err(format!(
                "Cannot inspect Docker config path at {:?}: {}",
                config_path, e
            ));
        }
    }

    // Resolve the host Docker config path.  When no explicit override is
    // given, fall back to `~/.docker/config.json`.  If the home directory
    // can't be resolved, proceed with an empty config rather than
    // accidentally reading from the current working directory.
    let resolved_docker_dir: Option<PathBuf> = match host_docker_dir {
        Some(d) => Some(d.to_path_buf()),
        None => dirs::home_dir().map(|h| h.join(".docker")),
    };

    let host_config: serde_json::Value = if let Some(docker_dir) = resolved_docker_dir {
        let host_config_path = docker_dir.join("config.json");
        match std::fs::read_to_string(&host_config_path) {
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(config) => config,
                Err(e) => {
                    let msg = format!(
                        "Cannot parse host Docker config at {:?}: {}. Proceeding with empty config.",
                        host_config_path, e
                    );
                    stderr_fallback(&msg);
                    let _ = append_desktop_log_for(data_dir, "docker-config", &msg);
                    serde_json::json!({})
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
            Err(e) => {
                let msg = format!(
                    "Cannot read host Docker config at {:?}: {}. Proceeding with empty config.",
                    host_config_path, e
                );
                stderr_fallback(&msg);
                let _ = append_desktop_log_for(data_dir, "docker-config", &msg);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };

    // Credential-store values that rely on host-only binaries
    let host_only_credstores = ["desktop", "osxkeychain", "wincred", "secretservice", "pass"];

    let mut sanitized = serde_json::Map::new();

    // Preserve auths that carry inline `auth` tokens (the only kind that
    // works without a host-side credential helper binary).
    if let Some(auths) = host_config.get("auths").and_then(|v| v.as_object()) {
        let mut kept = serde_json::Map::new();
        for (registry, entry) in auths {
            if let Some(auth) = entry.get("auth").and_then(|a| a.as_str()) {
                if !auth.is_empty() {
                    kept.insert(
                        registry.clone(),
                        serde_json::json!({ "auth": auth }),
                    );
                }
            }
        }
        if !kept.is_empty() {
            sanitized.insert("auths".to_string(), serde_json::Value::Object(kept));
        }
    }

    // Keep credsStore only if it isn't a host-only helper
    if let Some(creds_store) = host_config.get("credsStore").and_then(|v| v.as_str()) {
        if !host_only_credstores.contains(&creds_store) {
            sanitized.insert(
                "credsStore".to_string(),
                serde_json::Value::String(creds_store.to_string()),
            );
        }
    }

    // Keep per-registry credHelpers that aren't host-only
    if let Some(helpers) = host_config.get("credHelpers").and_then(|v| v.as_object()) {
        let mut kept = serde_json::Map::new();
        for (registry, helper) in helpers {
            if let Some(h) = helper.as_str() {
                if !host_only_credstores.contains(&h) {
                    kept.insert(registry.clone(), serde_json::Value::String(h.to_string()));
                }
            }
        }
        if !kept.is_empty() {
            sanitized.insert("credHelpers".to_string(), serde_json::Value::Object(kept));
        }
    }

    // Only auths (inline), credsStore (non-host-only), and credHelpers
    // (non-host-only) are preserved.  Everything else is dropped:
    // currentContext, plugins, features, hooks, aliases, experimental, etc.
    // — all host-specific and either unused or harmful in-container.

    let content =
        serde_json::to_string_pretty(&serde_json::Value::Object(sanitized))
            .map_err(|e| format!("Cannot serialise docker config: {}", e))?;
    std::fs::create_dir_all(&internal_dir)
        .map_err(|e| format!("Cannot create {}: {}", internal_dir.display(), e))?;

    // On Unix, write to a temp file with mode 0600, flush+sync, then
    // atomically rename over the destination.  This ensures the old config
    // stays in place if the write fails (disk full, crash).
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let tmp_path = internal_dir.join(".docker-config.json.tmp");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp_path)
            .map_err(|e| format!("Cannot open {}: {}", tmp_path.display(), e))?;
        file.write_all(format!("{}\n", content).as_bytes())
            .map_err(|e| format!("Cannot write {}: {}", tmp_path.display(), e))?;
        file.flush()
            .map_err(|e| format!("Cannot flush {}: {}", tmp_path.display(), e))?;
        file.sync_all()
            .map_err(|e| format!("Cannot sync {}: {}", tmp_path.display(), e))?;
        std::fs::rename(&tmp_path, &config_path)
            .map_err(|e| format!("Cannot rename {} -> {}: {}", tmp_path.display(), config_path.display(), e))?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        std::fs::write(&config_path, format!("{}\n", content))
            .map_err(|e| format!("Cannot write {}: {}", config_path.display(), e))?;
    }

    Ok(())
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
        desktop_log_path_for, format_command_output, generate_container_docker_config,
        is_container_name_conflict, is_oci_runtime_error, is_traefik_recreate_required,
        logs_open_target_for, managed_app_container_ps_args, mark_traefik_recreate_required,
        parse_container_ids, prepare_traefik_runtime_state, seeded_traefik_config_contents,
        truncate_command_output, DockerAccessState, MAX_COMMAND_OUTPUT_CHARS, TRAEFIK_ACME_FILE,
        TRAEFIK_CONFIG_FILE, TRAEFIK_DYNAMIC_CONFIG_SEED, TRAEFIK_DYNAMIC_FILE, TRAEFIK_TLS_DIR,
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

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

    #[test]
    fn rotates_desktop_log_when_it_exceeds_max_size() {
        use super::{rotate_log_if_needed, DESKTOP_LOG_FILENAME, MAX_LOG_ROTATIONS};

        // Use a tiny threshold so the test doesn't write multi-MB files.
        const TEST_MAX_SIZE: u64 = 64;

        let tempdir = tempfile::tempdir().expect("tempdir");
        let logs_dir = tempdir.path();
        let log_path = logs_dir.join(DESKTOP_LOG_FILENAME);

        // Create a log file that exceeds the size limit.
        let payload_len = (TEST_MAX_SIZE + 1) as usize;
        let payload = "x".repeat(payload_len);
        std::fs::write(&log_path, &payload).expect("write oversized log");

        rotate_log_if_needed(&log_path, logs_dir, TEST_MAX_SIZE);

        // Original should no longer exist (it was rotated to .1).
        assert!(!log_path.exists(), "original log should have been renamed");
        let rotated = logs_dir.join(format!("{}.1", DESKTOP_LOG_FILENAME));
        assert!(rotated.exists(), "desktop.log.1 should exist");
        let content = std::fs::read_to_string(&rotated).expect("read rotated");
        assert_eq!(content, payload);

        // Rotate again: .1 → .2, new data → .1
        let new_payload = "y".repeat(payload_len);
        std::fs::write(&log_path, &new_payload).expect("write new oversized log");
        rotate_log_if_needed(&log_path, logs_dir, TEST_MAX_SIZE);

        assert!(!log_path.exists());
        let r1 = logs_dir.join(format!("{}.1", DESKTOP_LOG_FILENAME));
        let r2 = logs_dir.join(format!("{}.2", DESKTOP_LOG_FILENAME));
        assert!(r1.exists());
        assert!(r2.exists());
        assert_eq!(
            std::fs::read_to_string(&r1).expect("read r1"),
            new_payload
        );
        assert_eq!(std::fs::read_to_string(&r2).expect("read r2"), payload);

        // Repeated rotations should keep updating .1..=MAX_LOG_ROTATIONS even when
        // those targets already exist, and the oldest entry should be evicted.
        let mut expected_rotations = vec![new_payload.clone(), payload.clone()];
        for i in 0..MAX_LOG_ROTATIONS {
            // Use a short unique prefix + single-byte fill to keep total size
            // just over the limit without allocating unnecessarily large strings.
            let prefix = format!("z{}-", i);
            let p = prefix.clone() + &"z".repeat(payload_len - prefix.len());
            std::fs::write(&log_path, &p).expect("write");
            rotate_log_if_needed(&log_path, logs_dir, TEST_MAX_SIZE);

            expected_rotations.insert(0, p);
            expected_rotations.truncate(MAX_LOG_ROTATIONS);
        }

        for rotation in 1..=MAX_LOG_ROTATIONS {
            let rotated_path =
                logs_dir.join(format!("{}.{}", DESKTOP_LOG_FILENAME, rotation));
            assert!(
                rotated_path.exists(),
                "expected rotated log {} to exist",
                rotated_path.display()
            );
            assert_eq!(
                std::fs::read_to_string(&rotated_path).expect("read rotated log"),
                expected_rotations[rotation - 1],
                "unexpected contents for rotated log {}",
                rotated_path.display()
            );
        }

        let beyond = logs_dir.join(format!(
            "{}.{}",
            DESKTOP_LOG_FILENAME,
            MAX_LOG_ROTATIONS + 1
        ));
        assert!(
            !beyond.exists(),
            "should not keep more than MAX_LOG_ROTATIONS history files"
        );

        // After rotation, a fresh active desktop.log should still be creatable
        // and appendable.
        std::fs::write(&log_path, "active-1").expect("write active log");
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&log_path)
                .expect("open active log for append");
            use std::io::Write;
            file.write_all(b"active-2").expect("append active log");
        }
        assert_eq!(
            std::fs::read_to_string(&log_path).expect("read active log"),
            "active-1active-2"
        );
    }

    /// Write a `~/.docker/config.json` fixture into a temp directory and
    /// return the `.docker` path for use as `host_docker_dir`.
    fn write_docker_config_fixture(fixture: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp_home = tempfile::tempdir().expect("create temp home");
        let docker_dir = tmp_home.path().join(".docker");
        std::fs::create_dir_all(&docker_dir).expect("create .docker dir");
        std::fs::write(docker_dir.join("config.json"), fixture).expect("write fixture");
        (tmp_home, docker_dir)
    }

    #[test]
    fn generates_container_docker_config_stripping_host_fields() {
        let fixture = r#"{
            "auths": {
                "https://index.docker.io/v1/": { "auth": "dXNlcjpwYXNz" }
            },
            "credsStore": "desktop",
            "credHelpers": { "ghcr.io": "desktop" },
            "currentContext": "desktop-linux",
            "plugins": { "debug": { "enabled": true } }
        }"#;

        let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
        let tmp = tempfile::tempdir().expect("create temp dir");
        let data_dir = tmp.path().to_path_buf();
        std::fs::create_dir_all(data_dir.join(".internal")).unwrap();

        generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

        let config_path = data_dir.join(".internal").join("docker-config.json");
        assert!(config_path.is_file(), "config should be a file");

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();

        assert_eq!(
            parsed.get("auths"),
            Some(&serde_json::json!({ "https://index.docker.io/v1/": { "auth": "dXNlcjpwYXNz" } })),
            "inline auths should be preserved"
        );
        assert!(parsed.get("credsStore").is_none(), "host-only credsStore stripped");
        assert!(parsed.get("credHelpers").is_none(), "host-only credHelpers stripped");
        assert!(parsed.get("currentContext").is_none(), "currentContext stripped");
        assert!(parsed.get("plugins").is_none(), "plugins stripped");

        // Verify file permissions are restricted on Unix
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let mode = config_path.metadata().unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "docker-config.json should be 0600");
        }
    }

    #[test]
    fn replaces_stale_directory_with_config_file() {
        let fixture = r#"{ "credsStore": "desktop" }"#;

        let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
        let tmp = tempfile::tempdir().expect("create temp dir");
        let data_dir = tmp.path().to_path_buf();
        let config_path = data_dir.join(".internal").join("docker-config.json");

        // Simulate the stale directory Docker creates
        std::fs::create_dir_all(&config_path).unwrap();
        assert!(config_path.is_dir(), "precondition: should be a directory");

        generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

        assert!(config_path.is_file(), "stale dir should be replaced with a file");
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert!(parsed.is_object());
        assert!(parsed.get("credsStore").is_none());
    }

    #[test]
    fn preserves_non_host_only_cred_helpers() {
        let fixture = r#"{
            "credsStore": "ecr-login",
            "credHelpers": {
                "ghcr.io": "desktop",
                "123456789.dkr.ecr.us-east-1.amazonaws.com": "ecr-login"
            }
        }"#;

        let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
        let tmp = tempfile::tempdir().expect("create temp dir");
        let data_dir = tmp.path().to_path_buf();
        std::fs::create_dir_all(data_dir.join(".internal")).unwrap();

        generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

        let config_path = data_dir.join(".internal").join("docker-config.json");
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();

        assert_eq!(
            parsed.get("credsStore"),
            Some(&serde_json::json!("ecr-login")),
            "non-host-only credsStore should be preserved"
        );
        let helpers = parsed.get("credHelpers").expect("credHelpers should exist");
        assert!(
            helpers.get("ghcr.io").is_none(),
            "host-only credHelper should be stripped"
        );
        assert_eq!(
            helpers.get("123456789.dkr.ecr.us-east-1.amazonaws.com"),
            Some(&serde_json::json!("ecr-login")),
            "non-host-only credHelper should be preserved"
        );
    }
}
