//! Tests for the `markers` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn hub_watchdog_decision() {
    use crate::hub_manager::{decide_hub_watchdog_action, HubWatchdogAction};
    // `docker_available` is passed explicitly — probing the real daemon would make this
    // test fail on any machine without Docker installed.
    assert_eq!(
        decide_hub_watchdog_action(2, None, false, false, false, true),
        HubWatchdogAction::None
    );
    assert_eq!(
        decide_hub_watchdog_action(3, None, false, false, false, true),
        HubWatchdogAction::StartHub
    );
    assert_eq!(
        decide_hub_watchdog_action(3, None, true, false, false, true),
        HubWatchdogAction::None
    );
    assert_eq!(
        decide_hub_watchdog_action(3, None, false, true, false, true),
        HubWatchdogAction::None
    );
    assert_eq!(
        decide_hub_watchdog_action(3, Some(60), false, false, false, true),
        HubWatchdogAction::None
    );
    assert_eq!(
        decide_hub_watchdog_action(3, Some(301), false, false, false, true),
        HubWatchdogAction::StartHub
    );
}

#[test]
fn hub_watchdog_wrapper_reports_only_start_hub() {
    use crate::hub_manager::should_trigger_hub_watchdog_for;
    // The wrapper adds nothing but the StartHub -> true mapping (it always passes
    // `api_container_up: false`); exercised through the pure form so the Docker probe
    // stays out of the test.
    assert!(should_trigger_hub_watchdog_for(3, None, false, false, true));
    assert!(!should_trigger_hub_watchdog_for(
        2, None, false, false, true
    ));
    // Docker missing: report false rather than asking for a start_hub that cannot run.
    assert!(!should_trigger_hub_watchdog_for(
        3, None, false, false, false
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
fn detached_start_keeps_desktop_launch_mode_while_the_window_is_open() {
    let dir = tempfile::tempdir().expect("tempdir");
    crate::hub_manager::persist_launch_mode(
        dir.path(),
        crate::hub_manager::PersistedLaunchMode::Desktop,
    );

    let window = crate::hub_manager::try_acquire_desktop_window(dir.path()).expect("window lock");
    assert!(crate::hub_manager::desktop_window_is_open(dir.path()));
    crate::hub_manager::persist_detached_launch_mode(dir.path());
    assert_eq!(
        crate::hub_manager::read_launch_mode(dir.path()),
        crate::hub_manager::PersistedLaunchMode::Desktop
    );

    drop(window);
    assert!(!crate::hub_manager::desktop_window_is_open(dir.path()));
    crate::hub_manager::persist_detached_launch_mode(dir.path());
    assert_eq!(
        crate::hub_manager::read_launch_mode(dir.path()),
        crate::hub_manager::PersistedLaunchMode::Detached
    );
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

/// Stop Hub stops the apps with `docker stop`, and `restart: unless-stopped` leaves a container
/// stopped by hand stopped. So the next start has to start exactly the ones Stop Hub stopped, and
/// only once (Companion-Hub#1938).
#[test]
fn the_next_start_gets_the_app_containers_stop_hub_stopped_once() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path();

    remember_apps_stopped_with_hub(data_dir, &["wordpress-1".to_string(), "db-1".to_string()]);

    assert_eq!(
        take_apps_stopped_with_hub(data_dir),
        ["wordpress-1", "db-1"]
    );
    assert!(take_apps_stopped_with_hub(data_dir).is_empty());
}

/// A second Stop Hub before the Hub was started again finds no app running, and must not lose the
/// apps the first one stopped.
#[test]
fn a_second_stop_hub_keeps_the_apps_the_first_one_stopped() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path();

    remember_apps_stopped_with_hub(data_dir, &["wordpress-1".to_string(), "db-1".to_string()]);
    remember_apps_stopped_with_hub(data_dir, &[]);
    remember_apps_stopped_with_hub(data_dir, &["db-1".to_string(), "cyberchef-1".to_string()]);

    assert_eq!(
        take_apps_stopped_with_hub(data_dir),
        ["wordpress-1", "db-1", "cyberchef-1"]
    );
}
