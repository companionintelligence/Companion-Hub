//! Tests for the `containers` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn prefers_a_running_legacy_hub_over_an_exited_canonical_container() {
    let names = ["ci-hub", "ci-os-hub"];
    let chosen = crate::hub_manager::first_preferred_container(&names, |name| match name {
        "ci-hub" => "exited:none".to_string(),
        "ci-os-hub" => "running:healthy".to_string(),
        _ => String::new(),
    });

    assert_eq!(chosen, Some("ci-os-hub"));
}

#[test]
fn wait_decision_keeps_looking_when_the_new_name_exited() {
    let decision = crate::hub_manager::named_container_wait_decision(
        &["ci-hub", "ci-os-hub"],
        &[("ci-hub", "exited:none"), ("ci-os-hub", "running:starting")],
        "Hub",
    );

    assert_eq!(
        decision,
        crate::hub_manager::NamedContainerWaitDecision::KeepWaiting
    );
}

#[test]
fn wait_decision_succeeds_when_the_legacy_name_is_healthy() {
    let decision = crate::hub_manager::named_container_wait_decision(
        &["ci-hub", "ci-os-hub"],
        &[("ci-hub", "exited:none"), ("ci-os-hub", "running:healthy")],
        "Hub",
    );

    assert_eq!(
        decision,
        crate::hub_manager::NamedContainerWaitDecision::Ready
    );
}

#[test]
fn wait_decision_fails_only_when_every_known_name_has_exited() {
    let decision = crate::hub_manager::named_container_wait_decision(
        &["ci-hub", "ci-os-hub"],
        &[("ci-hub", "exited:none"), ("ci-os-hub", "dead:none")],
        "Hub",
    );

    assert!(matches!(
        decision,
        crate::hub_manager::NamedContainerWaitDecision::Failed(message) if message.contains("exited during startup")
    ));
}

#[test]
fn rocm_linux_installer_script_gates_on_ubuntu_and_supported_versions() {
    let script = rocm_linux_install_script();

    assert!(script.contains(r#"${ID:-}" != "ubuntu"#));
    assert!(script.contains("22.04) CODENAME=jammy"));
    assert!(script.contains("24.04|26.04) CODENAME=noble"));
    assert!(script.contains("amdgpu-install"));
    assert!(script.contains("--usecase=rocm"));
    assert!(script.contains("reboot_required"));
    assert!(script.contains("repo.radeon.com/amdgpu-install"));
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
fn detects_host_port_bind_conflict_from_traefik_publish_error() {
    let output = r#"Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:443 -> 127.0.0.1:0: listen tcp 0.0.0.0:443: bind: address already in use"#;
    assert!(is_host_port_bind_conflict(output));
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
