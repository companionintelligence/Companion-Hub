//! Tests for the `markers` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn hub_watchdog_decision() {
    assert!(!crate::hub_manager::should_trigger_hub_watchdog(
        2, None, false, false
    ));
    assert!(crate::hub_manager::should_trigger_hub_watchdog(
        3, None, false, false
    ));
    assert!(!crate::hub_manager::should_trigger_hub_watchdog(
        3, None, true, false
    ));
    assert!(!crate::hub_manager::should_trigger_hub_watchdog(
        3, None, false, true
    ));
    assert!(!crate::hub_manager::should_trigger_hub_watchdog(
        3,
        Some(60),
        false,
        false
    ));
    assert!(crate::hub_manager::should_trigger_hub_watchdog(
        3,
        Some(301),
        false,
        false
    ));
}

#[test]
fn hub_watchdog_skips_compose_up_when_container_is_up() {
    use crate::hub_manager::{decide_hub_watchdog_action, HubWatchdogAction};
    // Three failures used to trigger start_hub — must not when the container is already up.
    assert_eq!(
        decide_hub_watchdog_action(3, None, false, false, true, true),
        HubWatchdogAction::None
    );
    assert_eq!(
        decide_hub_watchdog_action(5, None, false, false, true, true),
        HubWatchdogAction::None
    );
    assert_eq!(
        decide_hub_watchdog_action(6, None, false, false, true, true),
        HubWatchdogAction::RestartWedgedContainer
    );
    assert_eq!(
        decide_hub_watchdog_action(6, Some(60), false, false, true, true),
        HubWatchdogAction::None
    );
    assert_eq!(
        decide_hub_watchdog_action(3, None, false, false, false, true),
        HubWatchdogAction::StartHub
    );
    assert_eq!(
        decide_hub_watchdog_action(6, None, true, false, true, true),
        HubWatchdogAction::None
    );
    assert_eq!(
        decide_hub_watchdog_action(3, None, false, false, false, false),
        HubWatchdogAction::None
    );
}

#[test]
fn format_start_failure_message_rate_limit() {
    let msg = crate::hub_manager::format_start_failure_message(
            "Database bootstrap failed. Error response from daemon: unexpected status from HEAD request: 429 Too Many Requests",
        );
    assert!(msg.contains("Docker Hub rate-limited"));
    assert!(msg.contains("429"));
}

#[test]
fn compose_missing_race_is_not_sticky() {
    let err = "docker compose pull failed. open /home/ci/.local/share/companion-hub/docker-compose.prod.yml: no such file or directory";
    assert!(!crate::hub_manager::should_persist_start_failure(err));
    assert!(crate::hub_manager::should_persist_start_failure(
        "Database bootstrap failed. 429 Too Many Requests"
    ));
    // Seed materialization failures must stick — they are not a setup race.
    assert!(crate::hub_manager::should_persist_start_failure(
            "Failed to materialize /home/ci/.local/share/companion-hub/docker-compose.prod.yml from the embedded seed (no bundled resource found): Permission denied"
        ));
}

#[test]
fn start_failed_marker_roundtrip() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert!(!crate::hub_manager::is_start_failed(dir.path()));
    crate::hub_manager::mark_start_failed(dir.path(), "429 Too Many Requests on postgres:14");
    assert!(crate::hub_manager::is_start_failed(dir.path()));
    let stored = crate::hub_manager::read_start_failed(dir.path()).expect("message");
    assert!(stored.contains("Docker Hub rate-limited"));
    crate::hub_manager::clear_start_failed(dir.path());
    assert!(!crate::hub_manager::is_start_failed(dir.path()));
}
