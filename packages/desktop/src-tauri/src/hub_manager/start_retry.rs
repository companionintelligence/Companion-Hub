//! Automatic retries after a sticky start failure.
//!
//! A start that fails for a lasting reason leaves the sticky marker (`markers.rs`), which keeps
//! the UI on Error and stops auto-start and the watchdog. Without this module the marker never
//! expires, so the Hub stays down until the user clicks Start. Here the desktop retries on its
//! own after 5, then 15, then 60 minutes, for at most three retries. When all three have failed,
//! the budget is spent and only an explicit start gets a new one.
//!
//! Time is an argument everywhere, never read from the clock inside the logic, so tests can move
//! it forward without sleeping. Production callers pass [`now_ms`].

use std::path::{Path, PathBuf};

/// Wait before each automatic retry, counted from the failure that scheduled it.
const RETRY_COOLDOWNS_SECS: [u64; 3] = [5 * 60, 15 * 60, 60 * 60];

/// Automatic retries allowed after one failure streak.
pub const MAX_AUTOMATIC_RETRIES: u32 = RETRY_COOLDOWNS_SECS.len() as u32;

const START_RETRY_STATE_FILENAME: &str = "start-retry.state";

/// The retry budget: failures since the Hub last reached healthy, and when the latest one happened.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StartRetryState {
    pub failures: u32,
    pub last_failed_ms: u64,
}

/// What a failed start means for the retry budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryOutcome {
    /// Retry `retry` of [`MAX_AUTOMATIC_RETRIES`] runs after `wait_secs`.
    Scheduled { retry: u32, wait_secs: u64 },
    /// Every automatic retry has been tried and has failed. Only an explicit start can retry now.
    Exhausted { tries: u32 },
}

impl RetryOutcome {
    /// The desktop-log line for a failed start. A scheduled retry logs as a warning and an
    /// exhausted budget as an error; `error_reporting::classify_log_level` makes that split.
    pub fn log_message(self, formatted: &str) -> String {
        match self {
            RetryOutcome::Scheduled { retry, wait_secs } => format!(
                "Start failed (automatic retry {retry} of {MAX_AUTOMATIC_RETRIES} in {} min): {formatted}",
                wait_secs / 60
            ),
            RetryOutcome::Exhausted { tries } => format!(
                "Start failed (sticky failure state set; {tries} automatic retries were tried and failed): {formatted}"
            ),
        }
    }
}

/// Books one more failed start against the budget and says what it means.
pub(crate) fn record_failure_at(
    state: StartRetryState,
    now_ms: u64,
) -> (StartRetryState, RetryOutcome) {
    let failures = state.failures.saturating_add(1);
    let next = StartRetryState {
        failures,
        last_failed_ms: now_ms,
    };
    let outcome = if failures <= MAX_AUTOMATIC_RETRIES {
        RetryOutcome::Scheduled {
            retry: failures,
            wait_secs: RETRY_COOLDOWNS_SECS[(failures - 1) as usize],
        }
    } else {
        RetryOutcome::Exhausted {
            tries: MAX_AUTOMATIC_RETRIES,
        }
    };
    (next, outcome)
}

/// Whether the next automatic retry's cool-down has passed at `now_ms`.
pub(crate) fn retry_due_at(state: StartRetryState, now_ms: u64) -> bool {
    if state.failures == 0 || state.failures > MAX_AUTOMATIC_RETRIES {
        return false;
    }
    let wait_ms = RETRY_COOLDOWNS_SECS[(state.failures - 1) as usize].saturating_mul(1000);
    now_ms >= state.last_failed_ms.saturating_add(wait_ms)
}

fn start_retry_state_path(data_dir: &Path) -> PathBuf {
    data_dir.join(START_RETRY_STATE_FILENAME)
}

/// The stored budget. A missing or unreadable file reads as a fresh budget.
pub fn start_retry_state(data_dir: &Path) -> StartRetryState {
    let content = match std::fs::read_to_string(start_retry_state_path(data_dir)) {
        Ok(content) => content,
        Err(_) => return StartRetryState::default(),
    };
    let mut parts = content.split_whitespace();
    let failures = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let last_failed_ms = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    StartRetryState {
        failures,
        last_failed_ms,
    }
}

fn save_start_retry_state(data_dir: &Path, state: StartRetryState) {
    let _ = std::fs::write(
        start_retry_state_path(data_dir),
        format!("{} {}\n", state.failures, state.last_failed_ms),
    );
}

/// Books a failed start against the stored budget and returns what the failure means.
pub fn record_start_failure(data_dir: &Path, now_ms: u64) -> RetryOutcome {
    let (next, outcome) = record_failure_at(start_retry_state(data_dir), now_ms);
    save_start_retry_state(data_dir, next);
    outcome
}

/// True when the sticky failure has an automatic retry whose cool-down has passed. The caller
/// still checks that the sticky marker is set.
pub fn automatic_retry_due(data_dir: &Path, now_ms: u64) -> bool {
    retry_due_at(start_retry_state(data_dir), now_ms)
}

/// Gives the budget back: an explicit start, or the Hub reaching healthy.
pub fn reset_start_retry_budget(data_dir: &Path) {
    let _ = std::fs::remove_file(start_retry_state_path(data_dir));
}

/// Wall-clock milliseconds for production callers. Tests pass their own times instead.
pub fn now_ms() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0)
}
