use std::collections::HashSet;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::hub_env::{
    compiled_public_domain, default_hub_image, resolve_runtime_hub_image,
    runtime_hub_version_for_image, unquote_env_value,
};
use crate::hub_names::*;
use crate::portal_url::{compiled_ci_cloud_url, launch_portal_url, PortalUrlResolution};

mod cli_install;
mod compose;
mod containers;
mod credentials;
mod docker_access;
mod docker_vm;
mod host_probe;
mod installers;
mod lifecycle;
mod logging;
mod markers;
mod runtime_env;
mod runtime_state;
mod status;
mod windows_paths;
mod wsl;

#[cfg(test)]
mod tests;

pub(crate) use cli_install::*;
pub use compose::*;
pub use containers::*;
pub(crate) use credentials::*;
pub use docker_access::*;
pub(crate) use docker_vm::*;
pub(crate) use host_probe::*;
pub use installers::*;
pub use lifecycle::*;
pub use logging::*;
pub use markers::*;
pub use runtime_env::*;
pub(crate) use runtime_state::*;
pub use status::*;
pub(crate) use windows_paths::*;
// Every consumer of these is #[cfg(windows)], so on other hosts the re-export
// resolves to nothing and rustc flags it. It is load-bearing on Windows.
#[allow(unused_imports)]
pub(crate) use wsl::*;

#[cfg(target_os = "windows")]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Tauri bundle identifier (tauri.conf.json `identifier`). On Windows this names
/// the WebView2 user-data folder: `%LOCALAPPDATA%\<identifier>\EBWebView`.
#[cfg(target_os = "windows")]
const WEBVIEW_IDENTIFIER: &str = "computer.ci.app.hub";
/// Records the desktop version whose boot last reconciled the WebView2 cache, so
/// the corrupt-cache cleanup runs once per update instead of on every launch.
#[cfg(target_os = "windows")]
const WEBVIEW_CACHE_VERSION_MARKER: &str = ".webview-cache-version";
/// Regenerable WebView2 disk-cache directories cleared after an update. Excludes
/// `Local Storage`, `Cookies`, `Network`, and `IndexedDB` so login/session and
/// UI preferences survive the cleanup.
#[cfg(target_os = "windows")]
const WEBVIEW_DISK_CACHE_SUBDIRS: &[&str] = &[
    "EBWebView\\Default\\Cache",
    "EBWebView\\Default\\Code Cache",
    "EBWebView\\Default\\GPUCache",
    "EBWebView\\GrShaderCache",
    "EBWebView\\ShaderCache",
];

/// Maximum number of start attempts (1 initial + 2 retries with exponential
/// backoff of 2 s then 4 s).  `start_hub` / `start_hub_inner` are blocking
/// functions — callers from async contexts should use `spawn_blocking`.
const MAX_START_RETRIES: u32 = 3;

/// Global guard: true while a `start_hub` call is in progress.
static START_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// When the current or most recent `start_hub` call began, in Unix milliseconds (0 = never).
static START_BEGAN_AT_MS: AtomicU64 = AtomicU64::new(0);

/// True once a startup-progress poll during the current start found an image still missing.
/// Download progress then counts toward the startup percentage until the Hub is ready.
static START_IMAGE_DOWNLOADS_SEEN: AtomicBool = AtomicBool::new(false);

/// True while the current start still has to run its final `compose up --force-recreate`.
/// The database and queue it brings up first are replaced then, so they are not ready yet.
static START_RECREATE_PENDING: AtomicBool = AtomicBool::new(false);

/// `(hub .env mtime, is_private_vpn)` — avoids parsing the env file on every hub status poll (~3s).
static PRIVATE_VPN_ENV_CACHE: Mutex<Option<(Option<std::time::SystemTime>, bool)>> =
    Mutex::new(None);

/// Serialize rotation + append so concurrent callers cannot interleave
/// renames and writes to `desktop.log`.
static LOG_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Acquire a mutex guard, recovering the inner value if the lock was poisoned by
/// a panic in another thread. These mutexes guard short-lived cache/status/log
/// state where continuing with the existing value is safe and strictly better
/// than propagating a poison panic. This matters now that the release profile
/// unwinds panics (rather than aborting): a panic while a lock was held would
/// otherwise turn every later `.lock().unwrap()` on the hot status-polling path
/// into a fresh panic.
fn lock_recovering<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

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
pub const HUB_COMPOSE_FILENAME: &str = "docker-compose.prod.yml";
/// Maximum size of desktop.log before rotation (5 MB).
const MAX_LOG_SIZE_BYTES: u64 = 5 * 1024 * 1024;
/// Number of rotated log files to keep (desktop.log.1, desktop.log.2, ...).
const MAX_LOG_ROTATIONS: usize = 3;
/// Local/dev ACME placeholder — never use example.com (LetsEncrypt rejects it).
const DEFAULT_TRAEFIK_ACME_EMAIL: &str = "admin@localhost";
const TRAEFIK_ACME_DEFAULT_CONTENT: &str = "{}";
const TRAEFIK_CONFIG_SEED: &str = include_str!("../../../../backend/assets/traefik/traefik.yml");
/// Compile-time copy of the bundled compose file. Used as a last-resort fallback
/// when no `docker-compose.prod.yml` resource is found on disk at runtime (e.g.
/// `cargo tauri dev`, or a packaging layout where the resource path doesn't match
/// any candidate). Guarantees the data-dir compose file always exists so startup
/// never fails with a missing-compose error.
const HUB_COMPOSE_SEED: &str = include_str!("../../resources/docker-compose.prod.yml");
const TRAEFIK_DYNAMIC_CONFIG_SEED: &str =
    include_str!("../../../../backend/assets/traefik/dynamic/dynamic.yml");
const TRAEFIK_RECREATE_MARKER_FILENAME: &str = ".traefik-recreate-required";
const TRAEFIK_STATE_DIR: &str = "state/traefik";
const TRAEFIK_CONFIG_DIR: &str = "state/traefik/config";
const TRAEFIK_DYNAMIC_DIR: &str = "state/traefik/dynamic";
const TRAEFIK_TLS_DIR: &str = "state/traefik/tls";
const TRAEFIK_CONFIG_FILE: &str = "state/traefik/config/traefik.yml";
const TRAEFIK_DYNAMIC_FILE: &str = "state/traefik/dynamic/dynamic.yml";
const TRAEFIK_ACME_FILE: &str = "state/traefik/acme_storage.json";
const HUB_DOCKER_CONFIG_FILE: &str = ".docker/config.json";
#[cfg(target_os = "windows")]
const HOST_CLI_FILENAME: &str = "cihub.exe";
#[cfg(not(target_os = "windows"))]
const HOST_CLI_FILENAME: &str = "cihub";
const LEGACY_DOCKER_CONFIG_PATHS: &[&str] = &["docker-config.json", ".internal/docker-config.json"];
const HUB_START_HEALTHY_TIMEOUT_SECS: u64 = 180;
const DB_START_HEALTHY_TIMEOUT_SECS: u64 = 180;

#[cfg(any(test, target_os = "windows"))]
const DOCKER_DESKTOP_WINDOWS_INTEL_INSTALLER_URL: &str =
    "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
#[cfg(any(test, target_os = "windows"))]
const DOCKER_DESKTOP_WINDOWS_ARM_INSTALLER_URL: &str =
    "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe";
#[cfg(target_os = "macos")]
const DOCKER_DESKTOP_MACOS_INTEL_URL: &str = "https://desktop.docker.com/mac/main/amd64/Docker.dmg";
#[cfg(target_os = "macos")]
const DOCKER_DESKTOP_MACOS_ARM_URL: &str = "https://desktop.docker.com/mac/main/arm64/Docker.dmg";

#[cfg(target_os = "windows")]
const OLLAMA_WINDOWS_INSTALLER_URL: &str = "https://ollama.com/download/OllamaSetup.exe";
// Universal binary (arm64 + x86_64) — one zip for all Macs.
#[cfg(target_os = "macos")]
const OLLAMA_MACOS_ZIP_URL: &str = "https://ollama.com/download/Ollama-darwin.zip";
/// Synthetic startup row id — Ollama runs on the host (127.0.0.1:11434), not in compose.
const HOST_OLLAMA_SERVICE_ID: &str = "host-ollama";
const HOST_OLLAMA_API_URL: &str = "http://127.0.0.1:11434/api/tags";
const HOST_OLLAMA_PROBE_TIMEOUT: Duration = Duration::from_millis(500);
const HOST_OLLAMA_PROBE_CACHE_TTL: Duration = Duration::from_secs(10);
const HUB_API_LIVE_PROBE_TIMEOUT: Duration = Duration::from_millis(800);
const HUB_API_LIVE_PROBE_CACHE_TTL: Duration = Duration::from_secs(2);
/// `docker info` is expensive; reuse the last access check across hub-status polls.
const DOCKER_ACCESS_CACHE_TTL: Duration = Duration::from_secs(5);

struct CachedHostOllamaProbe {
    checked_at: Instant,
    available: bool,
}

struct CachedHubApiLiveProbe {
    checked_at: Instant,
    available: bool,
}

static HOST_OLLAMA_PROBE_CACHE: Mutex<Option<CachedHostOllamaProbe>> = Mutex::new(None);
static HUB_API_LIVE_PROBE_CACHE: Mutex<Option<CachedHubApiLiveProbe>> = Mutex::new(None);

fn base_docker_command() -> Command {
    let docker_path = find_docker_binary();
    let mut cmd = Command::new(docker_path);
    // Ensure common binary paths are in PATH for subprocesses (e.g. docker compose
    // plug-ins and credential helpers such as docker-credential-desktop must be
    // findable even when the Tauri process inherits a stripped PATH).
    if let Ok(current_path) = std::env::var("PATH") {
        if cfg!(target_os = "macos") {
            let extra =
                "/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin";
            cmd.env("PATH", format!("{}:{}", extra, current_path));
        } else if cfg!(target_os = "windows") {
            // Prepend Docker Desktop's resources\bin directory so credential
            // helpers (docker-credential-desktop.exe) and compose plug-ins are
            // findable when the Tauri process inherits a PATH that was set
            // before Docker Desktop added its own entries.
            let mut bin_dirs: Vec<String> = Vec::new();
            for var in &["ProgramFiles", "ProgramW6432"] {
                if let Ok(root) = std::env::var(var) {
                    let dir = format!("{}\\Docker\\Docker\\resources\\bin", root);
                    if !bin_dirs.contains(&dir) {
                        bin_dirs.push(dir);
                    }
                }
            }
            if !bin_dirs.is_empty() {
                let extra = bin_dirs.join(";");
                cmd.env("PATH", format!("{};{}", extra, current_path));
            }
        } else {
            let extra = "/usr/local/bin:/usr/bin";
            cmd.env("PATH", format!("{}:{}", extra, current_path));
        }
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub fn docker_command() -> Command {
    let mut cmd = base_docker_command();
    if let Some(docker_host) = preferred_docker_host() {
        cmd.env("DOCKER_HOST", docker_host);
        // Sticky CLI contexts must not override the pinned Hub engine.
        cmd.env_remove("DOCKER_CONTEXT");
    }
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

static DOCKER_ACCESS_CACHE: Mutex<Option<(Instant, DockerAccessCheck)>> = Mutex::new(None);

fn docker_access_cache_is_fresh(checked_at: Instant, now: Instant, ttl: Duration) -> bool {
    now.saturating_duration_since(checked_at) < ttl
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OllamaInstallState {
    Completed,
}

#[derive(Clone, serde::Serialize)]
pub struct OllamaInstallResult {
    pub state: OllamaInstallState,
    pub detail: Option<String>,
}

/// A single service's startup state, reported to the frontend loading screen.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    /// Container does not exist yet (pull / create pending).
    Pending,
    /// Container exists but health-check has not passed yet.
    Starting,
    /// Container is running and healthy (or has no health-check and is running).
    Ready,
    /// Container exited or could not start, and nothing explains it.
    Failed,
    /// Optional service is not present or not running — does not block startup.
    Unavailable,
    /// The user stopped the Hub, or the container exited cleanly.
    Stopped,
    /// The last start failed before this container was created or started.
    NotStarted,
}

/// Per-service startup info returned to the frontend.
#[derive(Clone, serde::Serialize)]
pub struct ServiceStatus {
    /// Short human-readable label, e.g. "Database".
    pub label: String,
    /// Docker container name, e.g. "ci-hub-db".
    pub container: String,
    pub state: ServiceState,
    /// When true, this row is informational only and never blocks `all_ready`.
    pub optional: bool,
    /// What went wrong, for `Failed`: Docker's error for the container, or its exit code.
    pub detail: Option<String>,
    /// For `Starting`: seconds since the container started, while it waits on its health check.
    pub starting_secs: Option<u64>,
}

/// Aggregate startup progress across all core Hub services.
#[derive(Clone, serde::Serialize)]
pub struct StartupProgress {
    /// Per-service breakdown.
    pub services: Vec<ServiceStatus>,
    /// 0..=100 overall progress percentage: the average of required service states, averaged
    /// again with `image_pull_pct` when this start had images to download.
    pub progress_pct: u8,
    /// Number of required startup images that are present locally.
    pub image_pulled: u8,
    /// Total number of required startup images.
    pub image_total: u8,
    /// 0..=100 image pull progress percentage.
    pub image_pull_pct: u8,
    /// True once every required core service is Ready (optional rows are ignored).
    pub all_ready: bool,
    /// A `start_hub` call is running right now.
    pub start_in_progress: bool,
    /// The user stopped the Hub and has not started it since.
    pub user_stopped: bool,
    /// When the user stopped the Hub, in Unix milliseconds.
    pub user_stopped_at_ms: Option<u64>,
    /// Why the last start failed, while the failure is still sticky.
    pub start_error: Option<String>,
    /// When the last start failed, in Unix milliseconds.
    pub start_failed_at_ms: Option<u64>,
    pub docker_access: DockerAccessCheck,
    /// The Hub API answers its liveness check.
    pub hub_api_live: bool,
}

/// Get the Hub data directory (platform-specific)
pub fn get_hub_data_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    let base = dirs::home_dir()
        .map(|home| {
            linux_data_home(
                std::env::var_os("XDG_DATA_HOME").as_deref().map(Path::new),
                std::env::var("SNAP_NAME").ok().as_deref(),
                &home,
            )
        })
        .or_else(dirs::data_dir);
    #[cfg(not(target_os = "linux"))]
    let base = dirs::data_dir();
    base.unwrap_or_else(|| PathBuf::from("."))
        .join("companion-hub")
}

/// `XDG_DATA_HOME` when it is absolute, as `dirs::data_dir()` reads it, else `~/.local/share`,
/// ignoring a value another snap set: a terminal inside a snap app, such as VS Code from the Snap
/// Store, points it at the app's own `~/snap/<name>/<rev>/.local/share`. Same rule as
/// `usableXdgDataHome` in `scripts/lib/paths.ts`, so `cihub` finds the same folder.
#[cfg(target_os = "linux")]
fn linux_data_home(xdg_data_home: Option<&Path>, snap_name: Option<&str>, home: &Path) -> PathBuf {
    const OWN_SNAP_NAME: &str = "companion-hub";
    let other_snap_running = snap_name
        .map(str::trim)
        .is_some_and(|name| !name.is_empty() && name != OWN_SNAP_NAME);
    // `<name>_<key>` is a parallel install of the snap `<name>`.
    let other_snaps_folder = |path: &Path| {
        path.strip_prefix(home.join("snap"))
            .ok()
            .and_then(|rest| rest.iter().next())
            .is_some_and(|folder| {
                folder.to_str().and_then(|name| name.split('_').next()) != Some(OWN_SNAP_NAME)
            })
    };
    match xdg_data_home {
        Some(path) if path.is_absolute() && !other_snap_running && !other_snaps_folder(path) => {
            path.to_path_buf()
        }
        _ => home.join(".local/share"),
    }
}

/// Whether the WebView2 disk cache should be reconciled for `current_version`.
/// True when no version was recorded yet (fresh install / first run with this
/// logic) or when the recorded version differs from the running binary.
#[cfg(any(test, target_os = "windows"))]
fn webview_cache_clear_needed(last_version: Option<&str>, current_version: &str) -> bool {
    match last_version {
        Some(value) => value.trim() != current_version.trim(),
        None => true,
    }
}

/// Root of the WebView2 user-data folder on Windows.
#[cfg(target_os = "windows")]
fn windows_webview_user_data_dir() -> Option<PathBuf> {
    dirs::data_local_dir().map(|base| base.join(WEBVIEW_IDENTIFIER))
}

/// Clear the WebView2 disk cache once after the desktop binary version changes.
///
/// An in-place update on Windows force-kills the running app (Restart Manager)
/// while WebView2 may be mid-write to its on-disk cache. The next launch then
/// fails every bundled asset with `net::ERR_CACHE_READ_FAILURE` (the cache index
/// references content files that were never flushed) and shows a blank window.
/// Microsoft's guidance is to clear the cache when this corruption is detected;
/// because the corruption is introduced by the update, we proactively drop the
/// regenerable cache directories the first time each new version boots. The
/// bundled UI loads from local files, so a cold cache costs nothing here.
///
/// Best-effort and idempotent: errors are ignored, and the version marker is
/// written even when the cache directory is absent so this runs at most once per
/// version. No-op on non-Windows platforms (WebKitGTK/WKWebView were unaffected).
pub fn clear_stale_webview_cache_on_version_change(current_version: &str) {
    #[cfg(target_os = "windows")]
    {
        let data_dir = get_hub_data_dir();
        // Track the marker next to the cache it describes (machine-local
        // LocalAppData), not in the roaming hub data dir, so a roaming Windows
        // profile cannot carry a "already cleared" marker to a machine whose
        // local cache was never touched. Fall back to the hub data dir only if
        // LocalAppData cannot be resolved.
        let webview_dir = windows_webview_user_data_dir();
        let marker = webview_dir
            .clone()
            .unwrap_or_else(|| data_dir.clone())
            .join(WEBVIEW_CACHE_VERSION_MARKER);
        let last_version = std::fs::read_to_string(&marker)
            .ok()
            .map(|value| value.trim().to_string());

        if !webview_cache_clear_needed(last_version.as_deref(), current_version) {
            return;
        }

        if let Some(base) = webview_dir {
            let mut cleared = Vec::new();
            for sub in WEBVIEW_DISK_CACHE_SUBDIRS {
                let target = base.join(sub);
                if target.exists() && std::fs::remove_dir_all(&target).is_ok() {
                    cleared.push(*sub);
                }
            }
            if !cleared.is_empty() {
                let _ = append_desktop_log_for(
                    &data_dir,
                    "webview.cache",
                    &format!(
                        "Cleared stale WebView2 disk cache after version change to {} (removed: {}).",
                        current_version,
                        cleared.join(", ")
                    ),
                );
            }
        }

        if let Some(parent) = marker.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&marker, current_version);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = current_version;
    }
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

// ─── User-stopped marker ──────────────────────────────────────────────────────
//
// When the user explicitly stops the Hub (via tray menu or the UI), we write a
// sentinel file so that the next desktop launch does NOT auto-restart the Hub.
// The marker is removed when the user explicitly starts the Hub again.

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
