//! Tests for the `docker_versions` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

fn versions(compose: Option<&str>, engine: Option<&str>) -> DockerVersions {
    DockerVersions {
        compose: compose.map(str::to_string),
        engine: engine.map(str::to_string),
    }
}

#[test]
fn parses_the_versions_docker_prints() {
    for (raw, expected) in [
        ("2.40.3-desktop.1", DockerVersion(2, 40, 3)),
        ("v2.33.0", DockerVersion(2, 33, 0)),
        ("5.1.4", DockerVersion(5, 1, 4)),
        ("28.5.1", DockerVersion(28, 5, 1)),
        ("29.6.0\n", DockerVersion(29, 6, 0)),
        ("2.32.4", DockerVersion(2, 32, 4)),
        ("27.5.1", DockerVersion(27, 5, 1)),
        ("28.2.2-0ubuntu1~24.04.1", DockerVersion(28, 2, 2)),
        ("20.10.24+dfsg1", DockerVersion(20, 10, 24)),
        (
            "Docker Compose version v2.24.6-desktop.1",
            DockerVersion(2, 24, 6),
        ),
        ("28.0", DockerVersion(28, 0, 0)),
    ] {
        assert_eq!(parse_docker_version(raw), Some(expected), "{raw}");
    }
}

#[test]
fn reads_nothing_from_output_without_a_version() {
    for raw in ["", "dev", "29", "unknown", "99999999999999999999.1.0"] {
        assert_eq!(parse_docker_version(raw), None, "{raw}");
    }
}

#[test]
fn orders_versions_by_number_not_by_text() {
    assert!(DockerVersion(2, 40, 3) > DockerVersion(2, 33, 0));
    assert!(DockerVersion(2, 9, 0) < DockerVersion(2, 33, 0));
    assert!(DockerVersion(5, 1, 4) > DockerVersion(2, 33, 0));
    assert!(DockerVersion(27, 5, 1) < DockerVersion(28, 0, 0));
    assert_eq!(MIN_DOCKER_COMPOSE_VERSION, DockerVersion(2, 33, 0));
    assert_eq!(MIN_DOCKER_ENGINE_VERSION, DockerVersion(28, 0, 0));
}

#[test]
fn names_both_versions_when_either_is_too_old() {
    let expected = "Companion Hub needs Docker Compose 2.33 or newer and Docker Engine 28 or newer. This computer has Compose 2.32.4 and Engine 27.5.1. Update Docker, then start the Hub again.";
    assert_eq!(
        docker_too_old_message(&versions(Some("2.32.4"), Some("27.5.1"))).as_deref(),
        Some(expected)
    );
    // Compose alone too old: the file is refused before the engine is ever asked.
    assert_eq!(
        docker_too_old_message(&versions(Some("v2.32.4"), Some("29.6.0"))).as_deref(),
        Some("Companion Hub needs Docker Compose 2.33 or newer and Docker Engine 28 or newer. This computer has Compose 2.32.4 and Engine 29.6.0. Update Docker, then start the Hub again.")
    );
    // The engine alone too old: a new Compose cannot give it `gw_priority`.
    assert!(
        docker_too_old_message(&versions(Some("2.40.3-desktop.1"), Some("27.5.1")))
            .is_some_and(|message| message.contains("Compose 2.40.3-desktop.1 and Engine 27.5.1"))
    );
}

#[test]
fn says_nothing_when_both_are_new_enough() {
    for (compose, engine) in [
        ("2.33.0", "28.0.0"),
        ("2.40.3-desktop.1", "28.5.1"),
        ("5.1.4", "29.6.0"),
    ] {
        assert_eq!(
            docker_too_old_message(&versions(Some(compose), Some(engine))),
            None,
            "{compose} / {engine}"
        );
    }
}

#[test]
fn does_not_refuse_on_a_version_it_could_not_read() {
    assert_eq!(docker_too_old_message(&versions(None, None)), None);
    assert_eq!(
        docker_too_old_message(&versions(Some("dev"), Some("29.6.0"))),
        None
    );
    assert_eq!(docker_too_old_message(&versions(Some("5.1.4"), None)), None);
    // …but one it could read still counts, and the message names only what was found.
    assert_eq!(
        docker_too_old_message(&versions(None, Some("27.5.1"))).as_deref(),
        Some("Companion Hub needs Docker Compose 2.33 or newer and Docker Engine 28 or newer. This computer has Engine 27.5.1. Update Docker, then start the Hub again.")
    );
}

#[test]
fn stops_the_start_on_an_old_docker_and_logs_why() {
    let tempdir = tempfile::tempdir().expect("tempdir");

    let error = check_docker_versions(tempdir.path(), &versions(Some("2.32.4"), Some("27.5.1")))
        .expect_err("an old Docker stops the start");

    assert!(error.starts_with("Companion Hub needs Docker Compose 2.33 or newer"));
    // A Docker that is too old stays too old until someone updates it: the failure sticks, so the
    // watchdog does not keep retrying a start that cannot work.
    assert!(should_persist_start_failure(&error));
    assert_eq!(format_start_failure_message(&error), error);
    let log = std::fs::read_to_string(desktop_log_path_for(tempdir.path())).expect("desktop log");
    assert!(log.contains("Docker versions: compose=2.32.4 engine=27.5.1"));
    assert!(log.contains(&error));
}

#[test]
fn starts_and_logs_when_a_version_cannot_be_read() {
    let tempdir = tempfile::tempdir().expect("tempdir");

    check_docker_versions(tempdir.path(), &versions(Some("5.1.4"), None))
        .expect("an unreadable engine version does not block the start");

    let log = std::fs::read_to_string(desktop_log_path_for(tempdir.path())).expect("desktop log");
    assert!(log.contains("Docker versions: compose=5.1.4 engine=unknown"));
    assert!(log.contains("Could not read the Docker Engine version; starting without checking it."));
    assert!(!log.contains("Could not read the Docker Compose version"));
}
