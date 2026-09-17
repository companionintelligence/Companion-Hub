//! Tests for the `status` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn startup_progress_keeps_private_vpn_visible_but_non_blocking() {
    let (core, optional) = startup_service_definitions(true);

    assert_eq!(core.len(), 4);
    assert!(core
        .iter()
        .any(|(container, label, _)| *container == "ci-hub" && *label == "Hub backend"));
    assert!(core
        .iter()
        .any(|(container, label, _)| *container == "ci-hub-queue" && *label == "Message queue"));
    assert!(optional
        .iter()
        .any(|(container, label, required)| *container == "hub-tailscale"
            && *label == "Private VPN"
            && !required));
}

#[test]
fn startup_progress_does_not_treat_ollama_as_compose_container() {
    let (_, optional) = startup_service_definitions(false);

    assert!(!optional
        .iter()
        .any(|(container, _, _)| *container == "ci-hub-ollama"));
}

fn at(offset_secs: i64) -> chrono::DateTime<chrono::Utc> {
    use chrono::TimeZone;
    chrono::Utc
        .timestamp_opt(1_789_600_000 + offset_secs, 0)
        .unwrap()
}

fn container(status: &str) -> ContainerInspect {
    ContainerInspect {
        status: status.to_string(),
        health: "none".to_string(),
        ..Default::default()
    }
}

#[test]
fn parse_inspect_line_reads_the_state_json() {
    let line = "/ci-hub-db\t{\"Status\":\"exited\",\"Running\":false,\"ExitCode\":137,\"Error\":\"\",\"StartedAt\":\"2026-09-16T14:07:24.1Z\",\"FinishedAt\":\"2026-09-16T16:25:24.229711442Z\",\"Health\":{\"Status\":\"unhealthy\",\"FailingStreak\":0,\"Log\":[]}}";

    let (name, parsed) = parse_inspect_line(line).expect("line parses");

    assert_eq!(name, "ci-hub-db");
    assert_eq!(parsed.status, "exited");
    assert_eq!(parsed.health, "unhealthy");
    assert_eq!(parsed.exit_code, 137);
    assert!(parsed.error.is_empty());
    assert_eq!(
        parsed.finished_at.map(|finished| finished.to_rfc3339()),
        Some("2026-09-16T16:25:24.229711442+00:00".to_string())
    );
}

#[test]
fn parse_inspect_line_treats_no_health_check_and_zero_times_as_absent() {
    let line = "/traefik\t{\"Status\":\"created\",\"ExitCode\":0,\"Error\":\"Bind for 0.0.0.0:8880 failed: port is already allocated\",\"StartedAt\":\"0001-01-01T00:00:00Z\",\"FinishedAt\":\"0001-01-01T00:00:00Z\"}";

    let (_, parsed) = parse_inspect_line(line).expect("line parses");

    assert_eq!(parsed.health, "none");
    assert_eq!(parsed.started_at, None);
    assert_eq!(parsed.finished_at, None);
    assert_eq!(
        parsed.error,
        "Bind for 0.0.0.0:8880 failed: port is already allocated"
    );
}

#[test]
fn parse_inspect_line_skips_lines_without_state_json() {
    assert!(parse_inspect_line("").is_none());
    assert!(parse_inspect_line("ci-hub:running:healthy").is_none());
    assert!(parse_inspect_line("/ci-hub\tnot json").is_none());
}

#[test]
fn a_hub_the_user_stopped_shows_every_service_as_stopped() {
    let ctx = CoreServiceContext {
        user_stopped: true,
        ..Default::default()
    };
    let mut killed_on_stop = container("exited");
    killed_on_stop.exit_code = 137;

    assert_eq!(
        derive_core_service_state(None, &ctx),
        (ServiceState::Stopped, None)
    );
    assert_eq!(
        derive_core_service_state(Some(&killed_on_stop), &ctx),
        (ServiceState::Stopped, None)
    );
}

#[test]
fn an_exited_container_is_stopped_when_clean_and_failed_otherwise() {
    let ctx = CoreServiceContext::default();
    let clean = container("exited");
    let mut crashed = container("exited");
    crashed.exit_code = 1;

    assert_eq!(
        derive_core_service_state(Some(&clean), &ctx),
        (ServiceState::Stopped, None)
    );
    assert_eq!(
        derive_core_service_state(Some(&crashed), &ctx),
        (ServiceState::Failed, Some("Exited with code 1".to_string()))
    );
}

#[test]
fn after_a_failed_start_docker_errors_explain_the_failure() {
    let ctx = CoreServiceContext {
        start_failed: true,
        ..Default::default()
    };
    let mut blocked = container("created");
    blocked.error = "Bind for 0.0.0.0:6543 failed: port is already allocated".to_string();

    assert_eq!(
        derive_core_service_state(Some(&blocked), &ctx),
        (ServiceState::Failed, Some(blocked.error.clone()))
    );
    assert_eq!(
        derive_core_service_state(Some(&container("created")), &ctx),
        (ServiceState::NotStarted, None)
    );
    assert_eq!(
        derive_core_service_state(None, &ctx),
        (ServiceState::NotStarted, None)
    );
}

#[test]
fn during_a_start_only_containers_that_exit_after_it_began_have_failed() {
    let ctx = CoreServiceContext {
        start_in_progress: true,
        start_began_at: Some(at(0)),
        ..Default::default()
    };
    let mut leftover = container("exited");
    leftover.exit_code = 137;
    leftover.finished_at = Some(at(-3_600));
    let mut crashed = container("exited");
    crashed.exit_code = 1;
    crashed.finished_at = Some(at(20));

    assert_eq!(
        derive_core_service_state(Some(&leftover), &ctx),
        (ServiceState::Pending, None)
    );
    assert_eq!(
        derive_core_service_state(Some(&crashed), &ctx),
        (ServiceState::Failed, Some("Exited with code 1".to_string()))
    );
    assert_eq!(
        derive_core_service_state(None, &ctx),
        (ServiceState::Pending, None)
    );
}

#[test]
fn running_containers_follow_their_health_check() {
    let ctx = CoreServiceContext::default();
    let mut waiting = container("running");
    waiting.health = "starting".to_string();
    let mut healthy = container("running");
    healthy.health = "healthy".to_string();

    assert_eq!(
        derive_core_service_state(Some(&waiting), &ctx),
        (ServiceState::Starting, None)
    );
    assert_eq!(
        derive_core_service_state(Some(&healthy), &ctx),
        (ServiceState::Ready, None)
    );
    assert_eq!(
        derive_core_service_state(Some(&container("running")), &ctx),
        (ServiceState::Ready, None)
    );
}

#[test]
fn starting_secs_counts_from_the_container_start_only_while_starting() {
    let mut waiting = container("running");
    waiting.started_at = Some(at(0));

    assert_eq!(
        starting_secs(Some(&waiting), &ServiceState::Starting, at(192)),
        Some(192)
    );
    assert_eq!(
        starting_secs(Some(&waiting), &ServiceState::Ready, at(192)),
        None
    );
    assert_eq!(starting_secs(None, &ServiceState::Starting, at(192)), None);
}

#[test]
fn downloads_count_for_half_the_percentage_only_when_this_start_downloaded() {
    assert_eq!(startup_progress_pct(15, 50, false), 15);
    assert_eq!(startup_progress_pct(15, 50, true), 33);
    assert_eq!(startup_progress_pct(100, 100, true), 100);
    assert_eq!(startup_progress_pct(0, 0, true), 0);
}
