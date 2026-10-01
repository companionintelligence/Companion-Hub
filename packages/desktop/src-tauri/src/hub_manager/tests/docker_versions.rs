//! Tests for the `docker_versions` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

const COMPOSE_2_32_REFUSED: &str = "Companion Hub needs Docker Compose 2.33 or newer. This computer has Compose 2.32.4. Update Docker, then start the Hub again.";
const ENGINE_27_WARNING: &str = "Docker Engine 27.5.1 ignores the network priority the Hub relies on, so the Hub, Traefik, and the Tailscale helper may use the wrong network for internet and host traffic. Update Docker Engine to 28 or newer.";

fn versions(compose: Option<&str>, engine: Option<&str>) -> DockerVersions {
    DockerVersions {
        compose: compose.map(str::to_string),
        engine: engine.map(str::to_string),
    }
}

fn desktop_log(data_dir: &std::path::Path) -> String {
    std::fs::read_to_string(desktop_log_path_for(data_dir)).expect("desktop log")
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
fn refuses_a_compose_older_than_2_33_and_names_it() {
    // Compose 2.32 rejects the stack file outright, whatever the engine.
    for engine in [Some("29.6.0"), Some("27.5.1"), None] {
        assert_eq!(
            docker_compose_too_old_message(&versions(Some("2.32.4"), engine)).as_deref(),
            Some(COMPOSE_2_32_REFUSED),
            "{engine:?}"
        );
    }
    assert_eq!(
        docker_compose_too_old_message(&versions(Some("v2.32.4"), None)).as_deref(),
        Some(COMPOSE_2_32_REFUSED)
    );
    for compose in ["2.33.0", "2.40.3-desktop.1", "5.1.4"] {
        assert_eq!(
            docker_compose_too_old_message(&versions(Some(compose), Some("27.5.1"))),
            None,
            "{compose}"
        );
    }
}

#[test]
fn warns_about_an_engine_older_than_28_without_refusing_it() {
    // Engine 27 runs the file and ignores `gw_priority`: a warning, never the refusal.
    assert_eq!(
        docker_engine_too_old_warning(&versions(Some("5.1.4"), Some("27.5.1"))).as_deref(),
        Some(ENGINE_27_WARNING)
    );
    assert_eq!(
        docker_compose_too_old_message(&versions(Some("5.1.4"), Some("27.5.1"))),
        None
    );
    for engine in ["28.0.0", "28.5.1", "29.6.0"] {
        assert_eq!(
            docker_engine_too_old_warning(&versions(Some("5.1.4"), Some(engine))),
            None,
            "{engine}"
        );
    }
}

#[test]
fn neither_refuses_nor_warns_on_a_version_it_could_not_read() {
    for unreadable in [None, Some("dev")] {
        assert_eq!(
            docker_compose_too_old_message(&versions(unreadable, Some("29.6.0"))),
            None
        );
        assert_eq!(
            docker_engine_too_old_warning(&versions(Some("5.1.4"), unreadable)),
            None
        );
    }
}

#[test]
fn stops_the_start_on_an_old_compose_and_logs_why() {
    let tempdir = tempfile::tempdir().expect("tempdir");

    let error = check_docker_versions(tempdir.path(), &versions(Some("2.32.4"), Some("29.6.0")))
        .expect_err("an old Compose stops the start");

    assert_eq!(error, COMPOSE_2_32_REFUSED);
    // A Compose that is too old stays too old until someone updates it: the failure sticks, so
    // the watchdog does not keep retrying a start that cannot work.
    assert!(should_persist_start_failure(&error));
    assert_eq!(format_start_failure_message(&error), error);
    let log = desktop_log(tempdir.path());
    assert!(log.contains("hub.start: Docker versions: compose=2.32.4 engine=29.6.0"));
    assert!(log.contains(&error));
    assert!(!log.contains("WARNING"));
}

#[test]
fn starts_on_an_old_engine_and_logs_what_is_degraded() {
    let tempdir = tempfile::tempdir().expect("tempdir");

    check_docker_versions(tempdir.path(), &versions(Some("5.1.4"), Some("27.5.1")))
        .expect("Engine 27 runs the stack file, so the start goes on");

    let log = desktop_log(tempdir.path());
    assert!(log.contains(&format!("hub.start: WARNING: {ENGINE_27_WARNING}")));
}

#[test]
fn refuses_an_old_compose_and_still_warns_about_an_old_engine() {
    let tempdir = tempfile::tempdir().expect("tempdir");

    let error = check_docker_versions(tempdir.path(), &versions(Some("2.32.4"), Some("27.5.1")))
        .expect_err("an old Compose stops the start");

    assert_eq!(error, COMPOSE_2_32_REFUSED);
    let log = desktop_log(tempdir.path());
    assert!(log.contains(&format!("WARNING: {ENGINE_27_WARNING}")));
    assert!(log.contains(COMPOSE_2_32_REFUSED));
}

#[test]
fn starts_and_logs_when_a_version_cannot_be_read() {
    let tempdir = tempfile::tempdir().expect("tempdir");

    check_docker_versions(tempdir.path(), &versions(Some("5.1.4"), None))
        .expect("an unreadable engine version does not block the start");

    let log = desktop_log(tempdir.path());
    assert!(log.contains("Docker versions: compose=5.1.4 engine=unknown"));
    assert!(log.contains("Could not read the Docker Engine version; starting without checking it."));
    assert!(!log.contains("Could not read the Docker Compose version"));
    assert!(!log.contains("WARNING"));
}
