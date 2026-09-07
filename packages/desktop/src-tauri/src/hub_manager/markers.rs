//! Persisted launch mode, start-failure / user-stopped markers and the watchdog.

use super::*;

const USER_STOPPED_MARKER_FILENAME: &str = ".user-stopped";
const START_FAILED_MARKER_FILENAME: &str = ".start-failed";
const START_FAILED_MARKER_MAX_BYTES: usize = 4 * 1024;
const LAUNCH_MODE_FILENAME: &str = ".launch-mode";

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
    matches!(
        decide_hub_watchdog_action(
            consecutive_health_failures,
            cooldown_elapsed_secs,
            user_stopped,
            start_failed,
            false,
            is_docker_available(),
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
