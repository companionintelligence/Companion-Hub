//! Persisted launch mode, start-failure / user-stopped markers and the watchdog.

use super::*;

const USER_STOPPED_MARKER_FILENAME: &str = ".user-stopped";
const START_FAILED_MARKER_FILENAME: &str = ".start-failed";
const START_FAILED_MARKER_MAX_BYTES: usize = 4 * 1024;
const LAUNCH_MODE_FILENAME: &str = ".launch-mode";
/// The app containers Stop Hub stopped, one ID a line, for the next start to start again.
const APPS_STOPPED_WITH_HUB_FILENAME: &str = ".apps-stopped-with-hub";

/// How the Hub was last launched — used to relaunch in the same mode after an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistedLaunchMode {
    Desktop,
    Detached,
}

impl PersistedLaunchMode {
    fn as_str(self) -> &'static str {
        match self {
            PersistedLaunchMode::Desktop => "desktop",
            PersistedLaunchMode::Detached => "detached",
        }
    }

    fn from_str(raw: &str) -> Self {
        if raw.trim() == "detached" {
            PersistedLaunchMode::Detached
        } else {
            PersistedLaunchMode::Desktop
        }
    }
}

pub fn persist_launch_mode(data_dir: &Path, mode: PersistedLaunchMode) {
    let _ = std::fs::write(
        data_dir.join(LAUNCH_MODE_FILENAME),
        format!("{}\n", mode.as_str()),
    );
}

pub fn read_launch_mode(data_dir: &Path) -> PersistedLaunchMode {
    std::fs::read_to_string(data_dir.join(LAUNCH_MODE_FILENAME))
        .map(|content| PersistedLaunchMode::from_str(content.trim()))
        .unwrap_or(PersistedLaunchMode::Desktop)
}

const DESKTOP_WINDOW_LOCK_FILENAME: &str = ".desktop-window.lock";

/// Held for the life of the desktop process. Closing the file releases the lock,
/// which is how a crashed window stops counting as open.
pub struct DesktopWindowGuard {
    _file: std::fs::File,
}

/// Exclusive lock while this process is the open window. `None` when another
/// window already holds it, or the lock file cannot be created.
pub fn try_acquire_desktop_window(data_dir: &Path) -> Option<DesktopWindowGuard> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(data_dir.join(DESKTOP_WINDOW_LOCK_FILENAME))
        .ok()?;
    if lock_desktop_window(&file) {
        Some(DesktopWindowGuard { _file: file })
    } else {
        None
    }
}

/// Keeps the window lock until this process exits. Dropping it at the end of
/// setup would let a later `--detached` start record headless while the window
/// is still open.
pub fn hold_desktop_window(data_dir: &Path) {
    static HELD: Mutex<Option<DesktopWindowGuard>> = Mutex::new(None);
    let Some(guard) = try_acquire_desktop_window(data_dir) else {
        return;
    };
    if let Ok(mut held) = HELD.lock() {
        *held = Some(guard);
    }
}

pub fn desktop_window_is_open(data_dir: &Path) -> bool {
    try_acquire_desktop_window(data_dir).is_none()
}

/// Records a headless start. Leaves the file alone when a window is already
/// open, so a later update does not relaunch that window headless (#1780).
pub fn persist_detached_launch_mode(data_dir: &Path) {
    if desktop_window_is_open(data_dir) {
        return;
    }
    persist_launch_mode(data_dir, PersistedLaunchMode::Detached);
}

#[cfg(unix)]
fn lock_desktop_window(file: &std::fs::File) -> bool {
    use std::os::unix::io::AsRawFd;
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

#[cfg(windows)]
fn lock_desktop_window(file: &std::fs::File) -> bool {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Overlapped {
        internal: usize,
        internal_high: usize,
        offset: u32,
        offset_high: u32,
        h_event: *mut std::ffi::c_void,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LockFileEx(
            file: *mut std::ffi::c_void,
            flags: u32,
            reserved: u32,
            bytes_low: u32,
            bytes_high: u32,
            overlapped: *mut Overlapped,
        ) -> i32;
    }
    const LOCKFILE_FAIL_IMMEDIATELY: u32 = 0x0000_0001;
    const LOCKFILE_EXCLUSIVE_LOCK: u32 = 0x0000_0002;
    let mut overlapped = Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0,
        offset_high: 0,
        h_event: std::ptr::null_mut(),
    };
    unsafe {
        LockFileEx(
            file.as_raw_handle() as *mut std::ffi::c_void,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            1,
            0,
            &mut overlapped,
        ) != 0
    }
}

fn user_stopped_marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(USER_STOPPED_MARKER_FILENAME)
}

fn start_failed_marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(START_FAILED_MARKER_FILENAME)
}

/// Truncate a failure string for the sticky UI / marker file.
fn truncate_start_failure_message(message: &str, max_chars: usize) -> String {
    let trimmed = message.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn is_compose_missing_race_error(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed.contains("no such file or directory")
        && (trimmed.contains("docker-compose") || trimmed.contains("compose"))
}

/// Whether a start failure should stick until the user confirms Retry.
/// Transient setup races (compose not copied yet) must not block the real auto-start.
fn is_docker_not_running_error(raw: &str) -> bool {
    raw.contains("Docker is not running")
}

pub fn should_persist_start_failure(raw: &str) -> bool {
    !is_compose_missing_race_error(raw) && !is_docker_not_running_error(raw)
}

/// Turn raw docker/compose failures into a sticky, user-facing message.
pub fn format_start_failure_message(raw: &str) -> String {
    let trimmed = raw.trim();
    // Already normalized (e.g. retry path wrote the sticky message back through).
    if trimmed.starts_with("Docker Hub rate-limited")
        || trimmed.starts_with("Hub start ran before desktop setup finished")
        || trimmed.starts_with("Docker is not running")
    {
        return truncate_start_failure_message(trimmed, START_FAILED_MARKER_MAX_BYTES);
    }

    let detail = truncate_start_failure_message(trimmed, 900);

    if trimmed.contains("429 Too Many Requests") || trimmed.contains("Too Many Requests") {
        return format!(
            "Docker Hub rate-limited image pulls from this machine's IP (HTTP 429). Wait several minutes, optionally run `docker login` for higher pull limits, then confirm Retry.\n\n{}",
            detail
        );
    }

    if is_compose_missing_race_error(trimmed) {
        return format!(
            "Hub start ran before desktop setup finished copying the compose file. Setup will continue momentarily.\n\n{}",
            detail
        );
    }

    detail
}

/// Persist the last start failure so the UI stays on Error and auto-start/watchdog stop retrying.
/// Returns the normalized message written to disk.
pub fn mark_start_failed(data_dir: &Path, message: &str) -> String {
    let formatted = format_start_failure_message(message);
    let bytes = truncate_start_failure_message(&formatted, START_FAILED_MARKER_MAX_BYTES);
    let _ = std::fs::write(start_failed_marker_path(data_dir), &bytes);
    bytes
}

/// Clear sticky start-failure state (user confirmed retry, or Hub reached healthy).
pub fn clear_start_failed(data_dir: &Path) {
    let _ = std::fs::remove_file(start_failed_marker_path(data_dir));
}

/// Returns the sticky start-failure message, if any.
pub fn read_start_failed(data_dir: &Path) -> Option<String> {
    let path = start_failed_marker_path(data_dir);
    let content = std::fs::read_to_string(path).ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// True when a prior start failed and the user has not confirmed a retry yet.
pub fn is_start_failed(data_dir: &Path) -> bool {
    start_failed_marker_path(data_dir).exists()
}

pub(crate) fn stack_dev_mode_enabled() -> bool {
    std::env::var("CI_HUB_STACK_DEV")
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// Record that the user intentionally stopped the Hub.
/// Called from `stop_hub()` so the next app launch skips auto-start.
pub fn mark_user_stopped(data_dir: &Path) {
    let _ = std::fs::write(
        user_stopped_marker_path(data_dir),
        b"Hub was intentionally stopped by the user.\n",
    );
}

/// Clear the user-stopped marker when the user explicitly starts the Hub.
/// Also called at the beginning of `start_hub()`.
pub fn clear_user_stopped(data_dir: &Path) {
    let _ = std::fs::remove_file(user_stopped_marker_path(data_dir));
}

/// Returns `true` if the user intentionally stopped the Hub on last use.
pub fn is_user_stopped(data_dir: &Path) -> bool {
    user_stopped_marker_path(data_dir).exists()
}

fn apps_stopped_with_hub_path(data_dir: &Path) -> PathBuf {
    data_dir.join(APPS_STOPPED_WITH_HUB_FILENAME)
}

fn read_apps_stopped_with_hub(data_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(apps_stopped_with_hub_path(data_dir))
        .map(|content| parse_container_ids(&content))
        .unwrap_or_default()
}

/// Adds the app containers Stop Hub just stopped to the ones the next start starts again, so a
/// second Stop Hub, which finds none running, keeps the first one's.
pub(crate) fn remember_apps_stopped_with_hub(data_dir: &Path, container_ids: &[String]) {
    let mut ids = read_apps_stopped_with_hub(data_dir);
    for id in container_ids {
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return;
    }
    let content: String = ids.iter().map(|id| format!("{id}\n")).collect();
    let _ = std::fs::write(apps_stopped_with_hub_path(data_dir), content);
}

/// The app containers Stop Hub stopped since the Hub last started, which the caller starts again.
/// Forgets them, so they are started once.
pub(crate) fn take_apps_stopped_with_hub(data_dir: &Path) -> Vec<String> {
    let ids = read_apps_stopped_with_hub(data_dir);
    let _ = std::fs::remove_file(apps_stopped_with_hub_path(data_dir));
    ids
}

fn marker_written_at_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since_epoch = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    u64::try_from(since_epoch.as_millis()).ok()
}

/// When the user stopped the Hub, in Unix milliseconds: the marker's write time.
pub fn user_stopped_at_ms(data_dir: &Path) -> Option<u64> {
    marker_written_at_ms(&user_stopped_marker_path(data_dir))
}

/// When the last start failed, in Unix milliseconds: the marker's write time.
pub fn start_failed_at_ms(data_dir: &Path) -> Option<u64> {
    marker_written_at_ms(&start_failed_marker_path(data_dir))
}

/// Consecutive failed tray health probes before a full `start_hub` is attempted
/// when the Hub container is missing or hard-stopped.
pub const HUB_WATCHDOG_FAILURE_THRESHOLD: u32 = 3;
/// Longer threshold before bouncing a wedged-but-running `ci-hub` container.
pub const HUB_WATCHDOG_WEDGE_FAILURE_THRESHOLD: u32 = 6;
/// Minimum time between watchdog-triggered recovery attempts.
pub const HUB_WATCHDOG_COOLDOWN_SECS: u64 = 300;

/// Action selected by the tray health watchdog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HubWatchdogAction {
    None,
    /// Containers missing / stopped — full compose `start_hub`.
    StartHub,
    /// Docker reports Running/Starting but the API is unreachable — restart `ci-hub` only.
    RestartWedgedContainer,
}

/// Pure decision helper for the tray watchdog (unit-tested).
///
/// `api_container_up` is true when [`get_hub_status`] reports `Running` or `Starting`
/// (container present and not hard-stopped). In that case we never call full
/// `start_hub` — only an optional single-container bounce after a longer threshold.
pub fn decide_hub_watchdog_action(
    consecutive_health_failures: u32,
    cooldown_elapsed_secs: Option<u64>,
    user_stopped: bool,
    start_failed: bool,
    api_container_up: bool,
    docker_available: bool,
) -> HubWatchdogAction {
    // If Docker is not running there is nothing we can do — skip silently.
    if !docker_available {
        return HubWatchdogAction::None;
    }
    // Respect intentional stop and sticky start failures — both require explicit user action.
    if user_stopped || start_failed {
        return HubWatchdogAction::None;
    }
    if let Some(elapsed) = cooldown_elapsed_secs {
        if elapsed < HUB_WATCHDOG_COOLDOWN_SECS {
            return HubWatchdogAction::None;
        }
    }
    if api_container_up {
        if consecutive_health_failures >= HUB_WATCHDOG_WEDGE_FAILURE_THRESHOLD {
            return HubWatchdogAction::RestartWedgedContainer;
        }
        return HubWatchdogAction::None;
    }
    if consecutive_health_failures >= HUB_WATCHDOG_FAILURE_THRESHOLD {
        return HubWatchdogAction::StartHub;
    }
    HubWatchdogAction::None
}

/// Backward-compatible wrapper: true only when a full `start_hub` should run.
pub fn should_trigger_hub_watchdog(
    consecutive_health_failures: u32,
    cooldown_elapsed_secs: Option<u64>,
    user_stopped: bool,
    start_failed: bool,
) -> bool {
    should_trigger_hub_watchdog_for(
        consecutive_health_failures,
        cooldown_elapsed_secs,
        user_stopped,
        start_failed,
        is_docker_available(),
    )
}

/// Pure form of [`should_trigger_hub_watchdog`] (unit-tested): takes `docker_available`
/// instead of probing the daemon, so tests do not need Docker on the machine.
pub(crate) fn should_trigger_hub_watchdog_for(
    consecutive_health_failures: u32,
    cooldown_elapsed_secs: Option<u64>,
    user_stopped: bool,
    start_failed: bool,
    docker_available: bool,
) -> bool {
    matches!(
        decide_hub_watchdog_action(
            consecutive_health_failures,
            cooldown_elapsed_secs,
            user_stopped,
            start_failed,
            false,
            docker_available,
        ),
        HubWatchdogAction::StartHub
    )
}

/// Containers exist but the hub API is not running/starting — needs `start_hub`.
pub fn hub_needs_runtime_recovery() -> bool {
    if START_IN_PROGRESS.load(Ordering::SeqCst) {
        return false;
    }
    if !is_docker_available() {
        return false;
    }
    if !hub_containers_exist() {
        return false;
    }
    !matches!(get_hub_status(), HubStatus::Running | HubStatus::Starting)
}

/// Restart only the Hub API container after a wedged-API detection.
pub fn restart_wedged_hub_container() -> Result<String, String> {
    let name = hub_container_name();
    let _ = append_desktop_log(
        "tray.watchdog",
        &format!("Restarting wedged {name} container (API unreachable while Docker reports up)."),
    );
    let output = docker_command()
        .args(["restart", name])
        .output()
        .map_err(|e| format!("Failed to restart {name}: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("docker restart {name} failed: {stderr}"));
    }
    Ok(format!("Restarted {name}"))
}

// ─── Desktop log reader ───────────────────────────────────────────────────────
