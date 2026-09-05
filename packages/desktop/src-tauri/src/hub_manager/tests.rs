//! Unit tests for the hub_manager modules.

use super::*;

#[test]
fn prefers_a_running_legacy_hub_over_an_exited_canonical_container() {
    let names = ["ci-hub", "ci-os-hub"];
    let chosen = super::first_preferred_container(&names, |name| match name {
        "ci-hub" => "exited:none".to_string(),
        "ci-os-hub" => "running:healthy".to_string(),
        _ => String::new(),
    });

    assert_eq!(chosen, Some("ci-os-hub"));
}

#[test]
fn wait_decision_keeps_looking_when_the_new_name_exited() {
    let decision = super::named_container_wait_decision(
        &["ci-hub", "ci-os-hub"],
        &[("ci-hub", "exited:none"), ("ci-os-hub", "running:starting")],
        "Hub",
    );

    assert_eq!(decision, super::NamedContainerWaitDecision::KeepWaiting);
}

#[test]
fn wait_decision_succeeds_when_the_legacy_name_is_healthy() {
    let decision = super::named_container_wait_decision(
        &["ci-hub", "ci-os-hub"],
        &[("ci-hub", "exited:none"), ("ci-os-hub", "running:healthy")],
        "Hub",
    );

    assert_eq!(decision, super::NamedContainerWaitDecision::Ready);
}

#[test]
fn wait_decision_fails_only_when_every_known_name_has_exited() {
    let decision = super::named_container_wait_decision(
        &["ci-hub", "ci-os-hub"],
        &[("ci-hub", "exited:none"), ("ci-os-hub", "dead:none")],
        "Hub",
    );

    assert!(matches!(
        decision,
        super::NamedContainerWaitDecision::Failed(message) if message.contains("exited during startup")
    ));
}

#[test]
fn webview_cache_clear_needed_decision() {
    // Fresh install / first run with this logic → clear.
    assert!(super::webview_cache_clear_needed(None, "0.2.27"));
    // Version changed (post-update first boot) → clear.
    assert!(super::webview_cache_clear_needed(Some("0.2.26"), "0.2.27"));
    // Same version (normal relaunch) → keep cache, no cleanup.
    assert!(!super::webview_cache_clear_needed(Some("0.2.27"), "0.2.27"));
    // Tolerate trailing whitespace/newline from the marker file.
    assert!(!super::webview_cache_clear_needed(
        Some("0.2.27\n"),
        "0.2.27"
    ));
}

#[test]
fn docker_access_cache_ttl_is_five_seconds() {
    use std::time::{Duration, Instant};
    let start = Instant::now();
    assert!(super::docker_access_cache_is_fresh(
        start,
        start,
        Duration::from_secs(5)
    ));
    assert!(super::docker_access_cache_is_fresh(
        start,
        start + Duration::from_secs(4),
        Duration::from_secs(5)
    ));
    assert!(!super::docker_access_cache_is_fresh(
        start,
        start + Duration::from_secs(5),
        Duration::from_secs(5)
    ));
}

#[test]
fn hub_watchdog_decision() {
    assert!(!super::should_trigger_hub_watchdog(2, None, false, false));
    assert!(super::should_trigger_hub_watchdog(3, None, false, false));
    assert!(!super::should_trigger_hub_watchdog(3, None, true, false));
    assert!(!super::should_trigger_hub_watchdog(3, None, false, true));
    assert!(!super::should_trigger_hub_watchdog(
        3,
        Some(60),
        false,
        false
    ));
    assert!(super::should_trigger_hub_watchdog(
        3,
        Some(301),
        false,
        false
    ));
}

#[test]
fn hub_watchdog_skips_compose_up_when_container_is_up() {
    use super::{decide_hub_watchdog_action, HubWatchdogAction};
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
    let msg = super::format_start_failure_message(
            "Database bootstrap failed. Error response from daemon: unexpected status from HEAD request: 429 Too Many Requests",
        );
    assert!(msg.contains("Docker Hub rate-limited"));
    assert!(msg.contains("429"));
}

#[test]
fn compose_missing_race_is_not_sticky() {
    let err = "docker compose pull failed. open /home/ci/.local/share/companion-hub/docker-compose.prod.yml: no such file or directory";
    assert!(!super::should_persist_start_failure(err));
    assert!(super::should_persist_start_failure(
        "Database bootstrap failed. 429 Too Many Requests"
    ));
    // Seed materialization failures must stick — they are not a setup race.
    assert!(super::should_persist_start_failure(
            "Failed to materialize /home/ci/.local/share/companion-hub/docker-compose.prod.yml from the embedded seed (no bundled resource found): Permission denied"
        ));
}

#[test]
fn ensure_hub_compose_file_writes_embedded_seed_when_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let compose_path = dir.path().join(super::HUB_COMPOSE_FILENAME);
    assert!(!compose_path.exists());

    super::ensure_hub_compose_file(&compose_path, dir.path()).expect("write seed");

    let written = std::fs::read_to_string(&compose_path).expect("read compose");
    assert!(
        written.contains("services:"),
        "seed should be a compose file"
    );
    assert!(written.len() > 100);
}

#[test]
fn ensure_hub_compose_file_is_noop_when_present() {
    let dir = tempfile::tempdir().expect("tempdir");
    let compose_path = dir.path().join(super::HUB_COMPOSE_FILENAME);
    std::fs::write(&compose_path, "services: {}\n").expect("seed existing");

    super::ensure_hub_compose_file(&compose_path, dir.path()).expect("noop");

    let written = std::fs::read_to_string(&compose_path).expect("read compose");
    assert_eq!(written, "services: {}\n");
}

#[test]
fn start_failed_marker_roundtrip() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert!(!super::is_start_failed(dir.path()));
    super::mark_start_failed(dir.path(), "429 Too Many Requests on postgres:14");
    assert!(super::is_start_failed(dir.path()));
    let stored = super::read_start_failed(dir.path()).expect("message");
    assert!(stored.contains("Docker Hub rate-limited"));
    super::clear_start_failed(dir.path());
    assert!(!super::is_start_failed(dir.path()));
}

#[cfg(target_os = "linux")]
use super::current_docker_context_name;
#[cfg(any(test, target_os = "macos"))]
use super::docker_desktop_macos_install_script;
#[cfg(any(test, target_os = "windows"))]
use super::docker_desktop_windows_download_url;
#[cfg(any(test, target_os = "windows"))]
use super::docker_desktop_windows_install_script;
#[cfg(any(test, target_os = "windows"))]
use super::docker_desktop_windows_outer_launch_command;
#[cfg(unix)]
use super::host_container_uid_gid;
#[cfg(any(test, target_os = "linux"))]
use super::ollama_linux_install_script;
#[cfg(any(test, target_os = "macos"))]
use super::ollama_macos_install_script;
#[cfg(any(test, target_os = "windows"))]
use super::ollama_windows_install_script;
#[cfg(not(target_os = "windows"))]
use super::parse_docker_socket_uid_gid;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::preferred_unix_cli_install_dir;
#[cfg(any(test, target_os = "linux"))]
use super::rocm_linux_install_script;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::unix_profile_for_shell;
#[cfg(any(test, target_os = "windows"))]
use super::wsl2_engine_elevated_script;
#[cfg(any(test, target_os = "windows"))]
use super::wsl2_engine_user_script;
use super::{
    append_desktop_log_for, classify_docker_access_result, clear_traefik_recreate_required,
    clear_tunnel_token, derive_optional_service_state, desktop_log_path_for, files_match,
    format_command_output, generate_container_docker_config, host_docker_socket_path,
    is_container_name_conflict, is_host_port_bind_conflict, is_oci_runtime_error,
    is_traefik_recreate_required, legacy_managed_app_container_ps_args, logs_open_target_for,
    managed_app_container_ps_args, mark_traefik_recreate_required, merge_compose_profiles,
    parse_container_ids, paths_match_by_components, prepare_traefik_runtime_state,
    private_vpn_enabled_from_map, seeded_traefik_config_contents,
    should_defer_docker_bind_mount_probe, startup_service_definitions, truncate_command_output,
    tunnel_dir_for, tunnel_token_path_for, tunnel_user_cleared_marker_path_for, DockerAccessState,
    ServiceState, MAX_COMMAND_OUTPUT_CHARS, TRAEFIK_ACME_FILE, TRAEFIK_CONFIG_FILE,
    TRAEFIK_DYNAMIC_CONFIG_SEED, TRAEFIK_DYNAMIC_FILE, TRAEFIK_TLS_DIR,
};
#[cfg(any(test, target_os = "macos"))]
use super::{colima_macos_binary_install_script, colima_macos_start_script};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[test]
fn classifies_daemon_unavailable_before_permission_denied() {
    let result = classify_docker_access_result(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
            Some(1),
        );

    assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
}

#[test]
fn classifies_explicit_permission_denied_as_permission_issue() {
    let result = classify_docker_access_result(
            "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
            Some(1),
        );

    assert!(matches!(result.state, DockerAccessState::PermissionDenied));
}

#[test]
fn classifies_windows_named_pipe_not_found_as_daemon_unavailable() {
    let result = classify_docker_access_result(
        "open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
        Some(1),
    );

    assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
}

#[test]
fn classifies_windows_access_denied_as_permission_issue() {
    let result = classify_docker_access_result(
            "open //./pipe/docker_engine: Access is denied. In the default daemon configuration on Windows, the docker client must be run with elevated privileges to connect.",
            Some(1),
        );

    assert!(matches!(result.state, DockerAccessState::PermissionDenied));
}

#[test]
fn defers_bind_mount_probe_until_docker_is_ready() {
    assert!(!should_defer_docker_bind_mount_probe(
        &DockerAccessState::Available
    ));
    assert!(should_defer_docker_bind_mount_probe(
        &DockerAccessState::DaemonUnavailable
    ));
    assert!(should_defer_docker_bind_mount_probe(
        &DockerAccessState::NotInstalled
    ));
    assert!(should_defer_docker_bind_mount_probe(
        &DockerAccessState::PermissionDenied
    ));
    assert!(should_defer_docker_bind_mount_probe(
        &DockerAccessState::Error
    ));
}

#[test]
fn prefers_docker_host_unix_socket_path() {
    crate::docker_engine::clear_process_pin();
    let original = std::env::var_os("DOCKER_HOST");
    let original_ci = std::env::var_os("CI_HUB_DOCKER_HOST");
    unsafe {
        std::env::remove_var("CI_HUB_DOCKER_HOST");
        std::env::set_var("DOCKER_HOST", "unix:///tmp/ci-hub-docker.sock");
    }

    assert_eq!(
        host_docker_socket_path(),
        PathBuf::from("/tmp/ci-hub-docker.sock")
    );

    if let Some(value) = original {
        unsafe {
            std::env::set_var("DOCKER_HOST", value);
        }
    } else {
        unsafe {
            std::env::remove_var("DOCKER_HOST");
        }
    }
    if let Some(value) = original_ci {
        unsafe {
            std::env::set_var("CI_HUB_DOCKER_HOST", value);
        }
    } else {
        unsafe {
            std::env::remove_var("CI_HUB_DOCKER_HOST");
        }
    }
    crate::docker_engine::clear_process_pin();
}

#[cfg(target_os = "linux")]
#[test]
fn reads_current_docker_context_from_config_fixture() {
    let fixture = r#"{ "currentContext": "desktop-linux" }"#;
    let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);

    assert_eq!(
        current_docker_context_name(Some(&docker_dir)),
        Some("desktop-linux".to_string())
    );
}

#[cfg(target_os = "linux")]
#[test]
fn ignores_default_docker_context_name() {
    let fixture = r#"{ "currentContext": "default" }"#;
    let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);

    assert_eq!(current_docker_context_name(Some(&docker_dir)), None);
}

#[test]
fn parses_docker_context_host_from_inspect_output() {
    let inspect_output = r#"[{
            "Name": "desktop-linux",
            "Endpoints": {
                "docker": {
                    "Host": "unix:///home/test/.docker/desktop/docker.sock"
                }
            }
        }]"#;

    assert_eq!(
        crate::docker_engine::docker_context_host_from_inspect_output(inspect_output),
        Some("unix:///home/test/.docker/desktop/docker.sock".to_string())
    );
}

#[test]
fn unreachable_desktop_falls_through_to_system_affinity() {
    // Selection matrix: Desktop not in reachable set; system has Hub stack.
    use crate::docker_engine::{
        select_docker_engine, DockerEngineCandidate, DockerEngineKind, ReachableEngine,
    };
    let engines = vec![ReachableEngine {
        candidate: DockerEngineCandidate {
            label: "system".to_string(),
            docker_host: "unix:///var/run/docker.sock".to_string(),
            kind: DockerEngineKind::System,
            context_name: None,
        },
        has_hub_identity: true,
        hub_host_ports: vec!["6543".to_string()],
    }];
    let (selected, reason) = select_docker_engine(&engines, None).unwrap();
    assert_eq!(selected.docker_host, "unix:///var/run/docker.sock");
    assert!(reason.contains("affinity"));
}

#[cfg(not(target_os = "windows"))]
#[test]
fn parses_docker_socket_stat_output() {
    assert_eq!(parse_docker_socket_uid_gid("0:0"), Some((0, 0)));
    assert_eq!(parse_docker_socket_uid_gid("0:998\n"), Some((0, 998)));
    assert_eq!(parse_docker_socket_uid_gid("bad"), None);
}

#[test]
fn truncates_long_command_output() {
    let output = "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 25);
    let truncated = truncate_command_output(&output);

    assert!(truncated.contains("[truncated 25 chars]"));
    assert!(truncated.starts_with(&"x".repeat(MAX_COMMAND_OUTPUT_CHARS)));
}

#[test]
fn formats_stdout_and_stderr_with_truncation() {
    let stdout = "ok";
    let stderr = "y".repeat(MAX_COMMAND_OUTPUT_CHARS + 10);
    let formatted = format_command_output(stdout, &stderr);

    assert!(formatted.starts_with("stdout: ok | stderr: "));
    assert!(formatted.contains("[truncated 10 chars]"));
}

#[test]
fn appends_desktop_log_entries_to_the_consolidated_log() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let log_path = append_desktop_log_for(tempdir.path(), "hub.start", "first line\nsecond line")
        .expect("append desktop log");
    let content = std::fs::read_to_string(log_path).expect("read log");

    assert!(content.contains("hub.start: first line"));
    assert!(content.contains("    second line"));
}

#[test]
fn view_logs_opens_the_logs_folder_even_when_desktop_log_exists() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let logs_dir = tempdir.path().join("logs");
    std::fs::create_dir_all(&logs_dir).expect("create logs dir");

    assert_eq!(logs_open_target_for(tempdir.path()), logs_dir);

    let desktop_log = desktop_log_path_for(tempdir.path());
    std::fs::write(&desktop_log, "ready").expect("write desktop log");

    assert_eq!(logs_open_target_for(tempdir.path()), logs_dir);
}

#[test]
fn tray_stop_targets_running_app_containers_by_ci_hub_labels() {
    assert_eq!(
        managed_app_container_ps_args(),
        [
            "ps",
            "-q",
            "--filter",
            "label=ci-hub.managed=true",
            "--filter",
            "label=ci-hub.appurn",
        ]
    );
    assert_eq!(
        legacy_managed_app_container_ps_args(),
        [
            "ps",
            "-q",
            "--filter",
            "label=ci-os-hub.managed=true",
            "--filter",
            "label=ci-os-hub.appurn",
        ]
    );
}

#[cfg(unix)]
#[test]
fn host_container_uid_gid_matches_current_process_on_unix() {
    let (uid, gid) = host_container_uid_gid();
    assert_eq!(uid, unsafe { libc::getuid() });
    assert_eq!(gid, unsafe { libc::getgid() });
}

#[test]
fn private_vpn_requires_auth_key_or_state_and_ignores_legacy_enabled_false() {
    use super::private_vpn_should_run;
    // Legacy PRIVATE_VPN_ENABLED=false must not force the sidecar on without credentials.
    assert!(!private_vpn_should_run(false, false, false));
    assert!(private_vpn_should_run(false, true, false));
    assert!(private_vpn_should_run(false, false, true));
    assert!(!private_vpn_should_run(true, true, true));
}

#[test]
fn private_vpn_disabled_only_when_user_disabled_sentinel_set() {
    let mut env = std::collections::HashMap::new();
    env.insert("PRIVATE_VPN_USER_DISABLED".into(), "true".into());
    env.insert("TAILSCALE_AUTHKEY".into(), "tskey-auth-test".into());
    assert!(!private_vpn_enabled_from_map(&env));
}

#[test]
fn private_vpn_enabled_when_auth_key_present() {
    let mut env = std::collections::HashMap::new();
    env.insert("TAILSCALE_AUTHKEY".into(), "tskey-auth-test".into());
    assert!(super::has_tailscale_auth_key(&env));
    assert!(super::private_vpn_should_run(
        false,
        super::has_tailscale_auth_key(&env),
        false
    ));
}

#[test]
fn merge_compose_profiles_adds_private_vpn_by_default() {
    let env = std::collections::HashMap::new();
    assert_eq!(merge_compose_profiles(&env, true), "private-vpn");
}

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

#[test]
fn optional_missing_sidecar_reports_unavailable_not_pending() {
    assert!(matches!(
        derive_optional_service_state("", "none"),
        ServiceState::Unavailable
    ));
}

#[test]
fn optional_sidecar_never_reports_starting_or_failed() {
    assert!(matches!(
        derive_optional_service_state("", "none"),
        ServiceState::Unavailable
    ));
    assert!(matches!(
        derive_optional_service_state("created", "none"),
        ServiceState::Unavailable
    ));
    assert!(matches!(
        derive_optional_service_state("restarting", "starting"),
        ServiceState::Unavailable
    ));
    assert!(matches!(
        derive_optional_service_state("running", "starting"),
        ServiceState::Unavailable
    ));
    assert!(matches!(
        derive_optional_service_state("exited", "none"),
        ServiceState::Unavailable
    ));
    assert!(matches!(
        derive_optional_service_state("running", "healthy"),
        ServiceState::Ready
    ));
    assert!(matches!(
        derive_optional_service_state("running", "none"),
        ServiceState::Ready
    ));
}

#[test]
fn parses_running_app_container_ids_from_docker_ps_output() {
    assert_eq!(
        parse_container_ids("abc123\n\n def456 \n"),
        vec!["abc123".to_string(), "def456".to_string()]
    );
}

#[test]
fn prepares_fresh_traefik_runtime_state_for_desktop_runtime() {
    let tempdir = tempfile::tempdir().expect("tempdir");

    let result = prepare_traefik_runtime_state(tempdir.path()).expect("prepare traefik");

    let config_path = tempdir.path().join(TRAEFIK_CONFIG_FILE);
    let dynamic_path = tempdir.path().join(TRAEFIK_DYNAMIC_FILE);
    let acme_path = tempdir.path().join(TRAEFIK_ACME_FILE);
    let tls_dir = tempdir.path().join(TRAEFIK_TLS_DIR);

    assert!(result.changed);
    assert!(!result.repaired_conflicting_paths);
    assert!(config_path.is_file());
    assert!(dynamic_path.is_file());
    assert!(acme_path.is_file());
    assert!(tls_dir.is_dir());
    assert_eq!(
        std::fs::read_to_string(&config_path).expect("read traefik config"),
        seeded_traefik_config_contents()
    );
    assert_eq!(
        std::fs::read_to_string(&dynamic_path).expect("read dynamic config"),
        TRAEFIK_DYNAMIC_CONFIG_SEED
    );
    assert_eq!(
        std::fs::read_to_string(&acme_path).expect("read acme file"),
        "{}"
    );
    assert!(!is_traefik_recreate_required(tempdir.path()));

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mode = std::fs::metadata(&acme_path)
            .expect("acme metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}

#[test]
fn heals_poisoned_traefik_mount_paths_back_to_files() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let config_path = tempdir.path().join(TRAEFIK_CONFIG_FILE);
    let dynamic_path = tempdir.path().join(TRAEFIK_DYNAMIC_FILE);
    let acme_path = tempdir.path().join(TRAEFIK_ACME_FILE);

    std::fs::create_dir_all(&config_path).expect("create poisoned config directory");
    std::fs::create_dir_all(&dynamic_path).expect("create poisoned dynamic directory");
    std::fs::create_dir_all(&acme_path).expect("create poisoned acme directory");

    let result = prepare_traefik_runtime_state(tempdir.path()).expect("prepare traefik");

    assert!(result.changed);
    assert!(result.repaired_conflicting_paths);
    assert!(config_path.is_file());
    assert!(dynamic_path.is_file());
    assert!(acme_path.is_file());
    assert_eq!(
        std::fs::read_to_string(&config_path).expect("read healed traefik config"),
        seeded_traefik_config_contents()
    );
    assert_eq!(
        std::fs::read_to_string(&dynamic_path).expect("read healed dynamic config"),
        TRAEFIK_DYNAMIC_CONFIG_SEED
    );
    assert_eq!(
        std::fs::read_to_string(&acme_path).expect("read healed acme file"),
        "{}"
    );
}

#[test]
fn detects_docker_missing_resource_messages() {
    assert!(super::is_docker_missing_resource_message(
        "Error response from daemon: No such container: traefik"
    ));
    assert!(super::is_docker_missing_resource_message(
        "Error response from daemon: No such object: traefik"
    ));
    assert!(!super::is_docker_missing_resource_message(
        "permission denied while trying to connect"
    ));
}

#[test]
fn traefik_recreate_marker_can_be_set_and_cleared() {
    let tempdir = tempfile::tempdir().expect("tempdir");

    assert!(!is_traefik_recreate_required(tempdir.path()));

    mark_traefik_recreate_required(tempdir.path()).expect("mark recreate required");
    assert!(is_traefik_recreate_required(tempdir.path()));

    clear_traefik_recreate_required(tempdir.path()).expect("clear recreate required");
    assert!(!is_traefik_recreate_required(tempdir.path()));
}

#[test]
fn windows_docker_desktop_download_url_matches_build_architecture() {
    let url = docker_desktop_windows_download_url();

    if cfg!(target_arch = "aarch64") {
        assert_eq!(
            url,
            "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe"
        );
    } else {
        assert_eq!(
            url,
            "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
        );
    }
}

#[test]
fn windows_installer_script_uses_unique_temp_download_and_validates_signature() {
    let script = docker_desktop_windows_install_script(
        "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
    );

    assert!(script.contains("GetTempFileName()"));
    assert!(script.contains("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"));
    assert!(script.contains("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature"));
    assert!(script.contains("Get-CompanionHubAuthenticodeSignature $installer"));
    assert!(script.contains("net.exe localgroup docker-users \"$AppUser\" /add"));
    assert!(!script.contains("CompanionHub-DockerDesktopInstaller.exe"));
    assert!(!script.contains("cmd /c"));
}

#[test]
fn macos_installer_script_verifies_downloaded_app_signature() {
    let script = docker_desktop_macos_install_script(
        "https://desktop.docker.com/mac/main/arm64/Docker.dmg",
        "hex",
    );

    assert!(script.contains("spctl --assess --type open --verbose=2"));
    assert!(script.contains("codesign --verify --deep --strict --verbose=2"));
    assert!(script.contains("spctl --assess --type execute --verbose=2"));
    assert!(script.contains("--user=\"hex\""));
}

#[test]
fn ollama_windows_installer_script_validates_signature_and_runs_silently() {
    let script = ollama_windows_install_script("https://ollama.com/download/OllamaSetup.exe");

    assert!(script.contains("GetTempFileName()"));
    assert!(script.contains("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"));
    assert!(script.contains("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature"));
    assert!(script.contains("Get-CompanionHubAuthenticodeSignature $installer"));
    assert!(script.contains("-notmatch 'Ollama'"));
    assert!(script.contains("'/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES'"));
    // Per-user Inno Setup installer — must never request elevation.
    assert!(!script.contains("RunAs"));
    assert!(!script.contains("-Verb"));
}

#[test]
fn ollama_macos_installer_script_verifies_app_signature_and_installs_cli() {
    let script = ollama_macos_install_script("https://ollama.com/download/Ollama-darwin.zip");

    assert!(script.contains("codesign --verify --deep --strict --verbose=2"));
    assert!(script.contains("spctl --assess --type execute --verbose=2"));
    assert!(script.contains("ditto"));
    assert!(script.contains("/Applications/Ollama.app"));
    assert!(script.contains(
        "ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama"
    ));
}

#[test]
fn colima_binary_install_script_verifies_checksums_and_layout() {
    let script = colima_macos_binary_install_script();

    // colima sha256 + lima SHA256SUMS verification are non-negotiable.
    assert!(script.contains("shasum -a 256 -c"));
    assert!(script.contains("colima.sha256sum"));
    assert!(script.contains("SHA256SUMS"));
    // The lima tarball must be extracted whole — limactl resolves
    // ../share/lima relative to its own binary.
    assert!(script.contains("tar -xzf lima.tar.gz -C /usr/local"));
    assert!(script.contains("releases/latest/download/colima-Darwin-"));
    assert!(script.contains("download.docker.com/mac/static/stable"));
}

#[test]
fn colima_start_script_never_runs_brew_as_root_and_waits_for_engine() {
    let script = colima_macos_start_script();

    // brew refuses root; this script must not contain any elevation.
    assert!(!script.contains("sudo"));
    assert!(!script.contains("osascript"));
    assert!(script.contains(r#""$BREW" install colima docker"#));
    assert!(script.contains(r#""$BREW" services start colima"#));
    assert!(script.contains("LaunchAgents/com.companionhub.colima.plist"));
    // Success must mean a working engine, not just installed binaries.
    assert!(script.contains("docker info"));
}

#[test]
fn wsl2_engine_elevated_script_only_does_admin_work() {
    let script = wsl2_engine_elevated_script();

    // Exit-code contract shared with the Docker Desktop installer: enable WSL
    // then ask for a reboot.
    assert!(script.contains("exit 100"));
    assert!(script.contains("--no-distribution"));
    // UTF-16 output guard for wsl --status parsing.
    assert!(script.contains("WSL_UTF8"));
    // Architecture-aware docker CLI download into Program Files (the only
    // admin-requiring filesystem write).
    assert!(script.contains("PROCESSOR_ARCHITECTURE"));
    assert!(script.contains("aarch64"));
    assert!(script.contains("docker.exe"));
    assert!(script.contains("Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"));
    assert!(script.contains("Get-CompanionHubAuthenticodeSignature $extractedExe"));

    // Per-user state must NOT be created in the elevated phase — that is the
    // core fix (it would otherwise land in the wrong profile under
    // over-the-shoulder UAC).
    assert!(!script.contains("context create wsl-engine"));
    assert!(!script.contains("GetFolderPath('Startup')"));
    assert!(!script.contains("--install -d Ubuntu"));
}

#[cfg(any(test, target_os = "windows"))]
#[test]
fn wsl2_engine_user_script_owns_per_user_state_and_avoids_daemon_json_hosts() {
    let script = wsl2_engine_user_script();

    // Distro registration happens in the user phase so the distro is owned by
    // the logged-in user.
    assert!(script.contains("--install -d Ubuntu --no-launch"));
    // Dynamic Ubuntu variant selection: handles Ubuntu-22.04, Ubuntu-24.04, etc.
    assert!(script.contains("-match '^Ubuntu-'"));
    // UTF-16 output guard for wsl -l parsing.
    assert!(script.contains("WSL_UTF8"));
    // TCP exposure must be a systemd drop-in, not daemon.json "hosts"
    // (which conflicts with Ubuntu's -H fd:// unit).
    assert!(script.contains("docker.service.d"));
    assert!(script.contains("-H fd:// -H tcp://127.0.0.1:2375"));
    assert!(!script.contains("\"hosts\""));
    // Per-user context routing (no env vars) + logon keepalive — generated in
    // the non-elevated phase so they land in the real user's profile.
    assert!(script.contains("context create wsl-engine"));
    assert!(script.contains("GetFolderPath('Startup')"));
    assert!(script.contains("sleep infinity"));
    // Must restart only the target distro, not every running WSL distro.
    assert!(script.contains("--terminate $distro"));
    assert!(!script.contains("--shutdown"));
    // Systemd boot check before the docker-info poll loop.
    assert!(script.contains("is-system-running"));
}

#[test]
fn docker_desktop_outer_launch_has_stop_on_error_preference() {
    let cmd = docker_desktop_windows_outer_launch_command(
        "C:\\Users\\test\\AppData\\Local\\Temp\\install.ps1",
        "testuser",
    );
    assert!(cmd.starts_with("$ErrorActionPreference = 'Stop';"));
    assert!(cmd.contains("-Verb RunAs"));
    assert!(cmd.contains("exit $process.ExitCode"));
    // Username must appear in the -AppUser argument.
    assert!(cmd.contains("testuser"));
}

#[test]
fn ollama_linux_installer_script_uses_official_installer_and_handles_deps() {
    let script = ollama_linux_install_script();

    assert!(script.contains("https://ollama.com/install.sh"));
    // The official installer hard-requires curl and zstd.
    assert!(script.contains("command -v curl"));
    assert!(script.contains("command -v zstd"));
    // apt's --no-install-recommends curl can't do HTTPS without this.
    assert!(script.contains("curl ca-certificates"));
    // Dep install must cover the major package-manager families.
    for pm in ["apt-get", "dnf", "yum", "pacman", "zypper", "apk"] {
        assert!(script.contains(pm), "missing package manager: {}", pm);
    }
    // Group add is best-effort and gated on group existence (no-systemd hosts).
    assert!(script.contains("getent group ollama"));
    assert!(script.contains(r#"usermod -aG ollama "$USERNAME""#));
    // Linux desktop installs should repair the default localhost-only bind.
    assert!(script.contains("ollama.service.d/override.conf"));
    assert!(script.contains(r#"Environment="OLLAMA_HOST=0.0.0.0:11434""#));
    assert!(script.contains("systemctl daemon-reload"));
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

#[test]
fn rotates_desktop_log_when_it_exceeds_max_size() {
    use super::{rotate_log_if_needed, DESKTOP_LOG_FILENAME, MAX_LOG_ROTATIONS};

    // Use a tiny threshold so the test doesn't write multi-MB files.
    const TEST_MAX_SIZE: u64 = 64;

    let tempdir = tempfile::tempdir().expect("tempdir");
    let logs_dir = tempdir.path();
    let log_path = logs_dir.join(DESKTOP_LOG_FILENAME);

    // Create a log file that exceeds the size limit.
    let payload_len = (TEST_MAX_SIZE + 1) as usize;
    let payload = "x".repeat(payload_len);
    std::fs::write(&log_path, &payload).expect("write oversized log");

    rotate_log_if_needed(&log_path, logs_dir, TEST_MAX_SIZE);

    // Original should no longer exist (it was rotated to .1).
    assert!(!log_path.exists(), "original log should have been renamed");
    let rotated = logs_dir.join(format!("{}.1", DESKTOP_LOG_FILENAME));
    assert!(rotated.exists(), "desktop.log.1 should exist");
    let content = std::fs::read_to_string(&rotated).expect("read rotated");
    assert_eq!(content, payload);

    // Rotate again: .1 → .2, new data → .1
    let new_payload = "y".repeat(payload_len);
    std::fs::write(&log_path, &new_payload).expect("write new oversized log");
    rotate_log_if_needed(&log_path, logs_dir, TEST_MAX_SIZE);

    assert!(!log_path.exists());
    let r1 = logs_dir.join(format!("{}.1", DESKTOP_LOG_FILENAME));
    let r2 = logs_dir.join(format!("{}.2", DESKTOP_LOG_FILENAME));
    assert!(r1.exists());
    assert!(r2.exists());
    assert_eq!(std::fs::read_to_string(&r1).expect("read r1"), new_payload);
    assert_eq!(std::fs::read_to_string(&r2).expect("read r2"), payload);

    // Repeated rotations should keep updating .1..=MAX_LOG_ROTATIONS even when
    // those targets already exist, and the oldest entry should be evicted.
    let mut expected_rotations = vec![new_payload.clone(), payload.clone()];
    for i in 0..MAX_LOG_ROTATIONS {
        // Use a short unique prefix + single-byte fill to keep total size
        // just over the limit without allocating unnecessarily large strings.
        let prefix = format!("z{}-", i);
        let p = prefix.clone() + &"z".repeat(payload_len - prefix.len());
        std::fs::write(&log_path, &p).expect("write");
        rotate_log_if_needed(&log_path, logs_dir, TEST_MAX_SIZE);

        expected_rotations.insert(0, p);
        expected_rotations.truncate(MAX_LOG_ROTATIONS);
    }

    for rotation in 1..=MAX_LOG_ROTATIONS {
        let rotated_path = logs_dir.join(format!("{}.{}", DESKTOP_LOG_FILENAME, rotation));
        assert!(
            rotated_path.exists(),
            "expected rotated log {} to exist",
            rotated_path.display()
        );
        assert_eq!(
            std::fs::read_to_string(&rotated_path).expect("read rotated log"),
            expected_rotations[rotation - 1],
            "unexpected contents for rotated log {}",
            rotated_path.display()
        );
    }

    let beyond = logs_dir.join(format!(
        "{}.{}",
        DESKTOP_LOG_FILENAME,
        MAX_LOG_ROTATIONS + 1
    ));
    assert!(
        !beyond.exists(),
        "should not keep more than MAX_LOG_ROTATIONS history files"
    );

    // After rotation, a fresh active desktop.log should still be creatable
    // and appendable.
    std::fs::write(&log_path, "active-1").expect("write active log");
    {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&log_path)
            .expect("open active log for append");
        use std::io::Write;
        file.write_all(b"active-2").expect("append active log");
    }
    assert_eq!(
        std::fs::read_to_string(&log_path).expect("read active log"),
        "active-1active-2"
    );
}

/// Write a `~/.docker/config.json` fixture into a temp directory and
/// return the `.docker` path for use as `host_docker_dir`.
fn write_docker_config_fixture(fixture: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp_home = tempfile::tempdir().expect("create temp home");
    let docker_dir = tmp_home.path().join(".docker");
    std::fs::create_dir_all(&docker_dir).expect("create .docker dir");
    std::fs::write(docker_dir.join("config.json"), fixture).expect("write fixture");
    (tmp_home, docker_dir)
}

#[test]
fn generates_container_docker_config_stripping_host_fields() {
    let fixture = r#"{
            "auths": {
                "https://index.docker.io/v1/": { "auth": "dXNlcjpwYXNz" }
            },
            "credsStore": "desktop",
            "credHelpers": { "ghcr.io": "desktop" },
            "currentContext": "desktop-linux",
            "plugins": { "debug": { "enabled": true } }
        }"#;

    let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
    let tmp = tempfile::tempdir().expect("create temp dir");
    let data_dir = tmp.path().to_path_buf();
    generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

    let config_path = data_dir.join(".docker").join("config.json");
    assert!(config_path.is_file(), "config should be a file");

    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();

    assert_eq!(
        parsed.get("auths"),
        Some(&serde_json::json!({ "https://index.docker.io/v1/": { "auth": "dXNlcjpwYXNz" } })),
        "inline auths should be preserved"
    );
    assert!(
        parsed.get("credsStore").is_none(),
        "host-only credsStore stripped"
    );
    assert!(
        parsed.get("credHelpers").is_none(),
        "host-only credHelpers stripped"
    );
    assert!(
        parsed.get("currentContext").is_none(),
        "currentContext stripped"
    );
    assert!(parsed.get("plugins").is_none(), "plugins stripped");

    // Verify file permissions are restricted on Unix
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let mode = config_path.metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "config.json should be 0600");
    }
}

#[test]
fn replaces_stale_directory_with_config_file() {
    let fixture = r#"{ "credsStore": "desktop" }"#;

    let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
    let tmp = tempfile::tempdir().expect("create temp dir");
    let data_dir = tmp.path().to_path_buf();
    let config_path = data_dir.join(".docker").join("config.json");

    // Simulate the stale directory Docker creates
    std::fs::create_dir_all(&config_path).unwrap();
    assert!(config_path.is_dir(), "precondition: should be a directory");

    generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

    assert!(
        config_path.is_file(),
        "stale dir should be replaced with a file"
    );
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
    assert!(parsed.is_object());
    assert!(parsed.get("credsStore").is_none());
}

#[test]
fn matches_paths_by_components() {
    assert!(paths_match_by_components(
        Path::new("/usr/local/bin/"),
        Path::new("/usr/local/bin")
    ));
    assert!(!paths_match_by_components(
        Path::new("/usr/local/bin"),
        Path::new("/usr/local/share")
    ));
}

#[test]
fn matches_files_by_contents() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let source = tempdir.path().join("source.bin");
    let installed = tempdir.path().join("installed.bin");
    std::fs::write(&source, b"same-bytes").expect("write source");
    std::fs::write(&installed, b"same-bytes").expect("write installed");

    assert!(files_match(&source, &installed).expect("compare files"));
}

#[test]
fn detects_when_installed_file_differs() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let source = tempdir.path().join("source.bin");
    let installed = tempdir.path().join("installed.bin");
    std::fs::write(&source, b"same-size").expect("write source");
    std::fs::write(&installed, b"diffsize!").expect("write installed");

    assert!(!files_match(&source, &installed).expect("compare files"));
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn replaces_broken_symlink_at_cli_install_path() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let install_dir = tempdir.path().join("bin");
    std::fs::create_dir_all(&install_dir).expect("create install dir");
    let source = tempdir.path().join("bundled-cihub");
    std::fs::write(&source, b"cli-bytes").expect("write source");

    // Symlink into a checkout that no longer exists — fs::copy onto this
    // path fails with ENOENT.
    let installed = install_dir.join("cihub");
    std::os::unix::fs::symlink(tempdir.path().join("gone/checkout/cihub"), &installed)
        .expect("create broken symlink");

    super::replace_installed_cli(&source, &install_dir, &installed).expect("install CLI");

    let metadata = installed.symlink_metadata().expect("installed metadata");
    assert!(metadata.file_type().is_file());
    assert_eq!(
        std::fs::read(&installed).expect("read installed"),
        b"cli-bytes"
    );
    let leftovers: Vec<_> = std::fs::read_dir(&install_dir)
        .expect("list install dir")
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().contains("staging"))
        .collect();
    assert!(leftovers.is_empty(), "staging file left behind");
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn replaces_symlink_without_writing_through_to_its_target() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let install_dir = tempdir.path().join("bin");
    std::fs::create_dir_all(&install_dir).expect("create install dir");
    let source = tempdir.path().join("bundled-cihub");
    std::fs::write(&source, b"cli-bytes").expect("write source");

    // Symlink to a live file elsewhere (e.g. a dev checkout binary) — the
    // install must replace the link, not overwrite what it points at.
    let checkout_binary = tempdir.path().join("checkout-cihub");
    std::fs::write(&checkout_binary, b"checkout-bytes").expect("write checkout binary");
    let installed = install_dir.join("cihub");
    std::os::unix::fs::symlink(&checkout_binary, &installed).expect("create symlink");

    super::replace_installed_cli(&source, &install_dir, &installed).expect("install CLI");

    assert!(installed
        .symlink_metadata()
        .expect("installed metadata")
        .file_type()
        .is_file());
    assert_eq!(
        std::fs::read(&installed).expect("read installed"),
        b"cli-bytes"
    );
    assert_eq!(
        std::fs::read(&checkout_binary).expect("read checkout binary"),
        b"checkout-bytes"
    );
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn prefers_user_bin_dir_even_when_system_bin_is_on_path() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let home = tempdir.path();
    let original_path = std::env::var_os("PATH");

    unsafe {
        std::env::set_var("PATH", "/usr/local/bin");
    }

    let selected = preferred_unix_cli_install_dir(home);

    match original_path {
        Some(value) => unsafe { std::env::set_var("PATH", value) },
        None => unsafe { std::env::remove_var("PATH") },
    }

    assert_eq!(selected, home.join(".local/bin"));
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn chooses_platform_correct_bash_profile() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let selected = unix_profile_for_shell(tempdir.path(), "/bin/bash");

    #[cfg(target_os = "macos")]
    assert_eq!(selected, tempdir.path().join(".bash_profile"));

    #[cfg(target_os = "linux")]
    assert_eq!(selected, tempdir.path().join(".bashrc"));
}

#[test]
fn preserves_non_host_only_cred_helpers() {
    let fixture = r#"{
            "credsStore": "ecr-login",
            "credHelpers": {
                "ghcr.io": "desktop",
                "123456789.dkr.ecr.us-east-1.amazonaws.com": "ecr-login"
            }
        }"#;

    let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
    let tmp = tempfile::tempdir().expect("create temp dir");
    let data_dir = tmp.path().to_path_buf();
    generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

    let config_path = data_dir.join(".docker").join("config.json");
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();

    assert_eq!(
        parsed.get("credsStore"),
        Some(&serde_json::json!("ecr-login")),
        "non-host-only credsStore should be preserved"
    );
    let helpers = parsed.get("credHelpers").expect("credHelpers should exist");
    assert!(
        helpers.get("ghcr.io").is_none(),
        "host-only credHelper should be stripped"
    );
    assert_eq!(
        helpers.get("123456789.dkr.ecr.us-east-1.amazonaws.com"),
        Some(&serde_json::json!("ecr-login")),
        "non-host-only credHelper should be preserved"
    );
}

#[test]
fn clear_tunnel_token_is_noop_when_absent() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    // Nested hub folder so sibling ../tunnel resolves inside the tempdir.
    let data_dir = tempdir.path().join("hub");
    std::fs::create_dir_all(&data_dir).expect("mkdir hub");
    let summary = clear_tunnel_token(&data_dir).expect("clear_tunnel_token succeeds");
    assert!(
        summary.contains("already absent"),
        "missing token should report no-op, got: {summary}",
    );
    assert!(!tunnel_token_path_for(&data_dir).exists());
    assert!(
        tunnel_user_cleared_marker_path_for(&data_dir).exists(),
        "user-cleared marker should be written even when token was absent",
    );
}

#[test]
fn clear_tunnel_token_removes_token_and_writes_marker() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    std::fs::create_dir_all(&data_dir).expect("mkdir hub");
    let token_path = tunnel_token_path_for(&data_dir);
    std::fs::create_dir_all(token_path.parent().expect("parent")).expect("mkdir tunnel/");
    std::fs::write(&token_path, b"FAKE_TOKEN").expect("write token");

    let summary = clear_tunnel_token(&data_dir).expect("clear_tunnel_token succeeds");

    assert!(!token_path.exists(), "token file should be removed");
    assert!(
        tunnel_user_cleared_marker_path_for(&data_dir).exists(),
        "user-cleared marker should be written",
    );
    assert!(
        summary.contains("cleared") && summary.contains(&token_path.display().to_string()),
        "summary should report clearance of the token path, got: {summary}",
    );
}

#[test]
fn clear_tunnel_token_removes_legacy_nested_token() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    let legacy_dir = data_dir.join("tunnel");
    std::fs::create_dir_all(&legacy_dir).expect("mkdir legacy tunnel");
    let legacy_token = legacy_dir.join("token");
    std::fs::write(&legacy_token, b"LEGACY").expect("write legacy token");

    clear_tunnel_token(&data_dir).expect("clear_tunnel_token succeeds");

    assert!(
        !legacy_token.exists(),
        "legacy nested token should be removed"
    );
    assert!(
        tunnel_user_cleared_marker_path_for(&data_dir).exists(),
        "marker written to canonical sibling tunnel dir",
    );
}

#[test]
fn clear_tunnel_token_keeps_dir_with_siblings() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    std::fs::create_dir_all(&data_dir).expect("mkdir hub");
    let token_path = tunnel_token_path_for(&data_dir);
    std::fs::create_dir_all(token_path.parent().expect("parent")).expect("mkdir tunnel/");
    std::fs::write(&token_path, b"FAKE_TOKEN").expect("write token");
    // A sibling file (e.g. certs/) keeps the tunnel/ directory alive after token removal.
    std::fs::write(tunnel_dir_for(&data_dir).join("certs.pem"), b"PEM").expect("write sibling");

    clear_tunnel_token(&data_dir).expect("clear_tunnel_token succeeds");

    assert!(!token_path.exists(), "token file should be removed");
    assert!(
        tunnel_dir_for(&data_dir).exists(),
        "tunnel dir with sibling files should be preserved",
    );
}

#[test]
fn merge_compose_profiles_adds_cloudflare_for_sibling_tunnel_token() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    std::fs::create_dir_all(&data_dir).expect("mkdir hub");
    let token_path = tunnel_token_path_for(&data_dir);
    std::fs::create_dir_all(token_path.parent().expect("parent")).expect("mkdir tunnel/");
    std::fs::write(&token_path, b"test-token").expect("write token");

    let mut env = std::collections::HashMap::new();
    env.insert(
        "ROOT_FOLDER_HOST".to_string(),
        data_dir.to_string_lossy().to_string(),
    );

    let profiles = merge_compose_profiles(&env, false);
    assert!(
        profiles.split(',').any(|p| p == "cloudflare"),
        "expected cloudflare profile for sibling token, got {profiles}"
    );
}

#[test]
fn merge_compose_profiles_adds_cloudflare_for_legacy_nested_tunnel_token() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    let legacy_dir = data_dir.join("tunnel");
    std::fs::create_dir_all(&legacy_dir).expect("mkdir legacy tunnel");
    std::fs::write(legacy_dir.join("token"), b"legacy-token").expect("write token");

    let mut env = std::collections::HashMap::new();
    env.insert(
        "ROOT_FOLDER_HOST".to_string(),
        data_dir.to_string_lossy().to_string(),
    );

    let profiles = merge_compose_profiles(&env, false);
    assert!(
        profiles.split(',').any(|p| p == "cloudflare"),
        "expected cloudflare profile for legacy nested token, got {profiles}"
    );
}

#[test]
fn invalidate_config_hash_removes_saved_hash() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let hash_path = tempdir.path().join(".config-hash");
    std::fs::write(&hash_path, b"abc123").expect("write hash");

    super::invalidate_config_hash(tempdir.path());

    assert!(!hash_path.exists(), ".config-hash should be removed");
}

#[test]
fn persist_config_hash_writes_compose_env_fingerprint() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let compose = tempdir.path().join("docker-compose.prod.yml");
    let env = tempdir.path().join(".env");
    std::fs::write(&compose, b"services: {}\n").expect("write compose");
    std::fs::write(&env, b"ROOT_FOLDER_HOST=/data\n").expect("write env");

    super::persist_config_hash(tempdir.path(), &compose, &env);

    let hash_path = tempdir.path().join(".config-hash");
    let saved = std::fs::read_to_string(&hash_path).expect("hash file");
    let expected = super::compute_config_hash(&compose, &env);
    assert_eq!(saved, expected);
}

#[test]
fn normalizes_windows_docker_bind_mount_paths_for_both_backends() {
    use super::WindowsDockerHostStyle::{Drive, WslMnt};
    // One input list, both backends: every accepted form collapses to the
    // Docker Desktop `/c/...` form or the WSL2-engine `/mnt/c/...` form.
    // A single list (not one per style) so a new input form cannot be added
    // to one backend's coverage and forgotten in the other's.
    let inputs = [
        r"C:\Users\hegem\AppData\Roaming\companion-hub\media",
        "C:/Users/hegem/AppData/Roaming/companion-hub/media",
        "/c/Users/hegem/AppData/Roaming/companion-hub/media",
        "/mnt/c/Users/hegem/AppData/Roaming/companion-hub/media",
        r"\\?\C:\Users\hegem\AppData\Roaming\companion-hub\media",
    ];
    let expectations = [
        (Drive, "/c/Users/hegem/AppData/Roaming/companion-hub/media"),
        (
            WslMnt,
            "/mnt/c/Users/hegem/AppData/Roaming/companion-hub/media",
        ),
    ];
    for (style, expected) in expectations {
        for input in inputs {
            assert_eq!(
                super::normalize_windows_docker_host_path(input, style),
                expected,
                "input {input:?} should normalize to the {style:?} form"
            );
        }
    }
}

#[test]
fn normalize_is_idempotent_and_passes_through_non_drive_paths() {
    use super::WindowsDockerHostStyle::{Drive, WslMnt};
    // Idempotent: re-normalizing an already-correct value is a no-op.
    assert_eq!(
        super::normalize_windows_docker_host_path("/c/Users/x", Drive),
        "/c/Users/x"
    );
    assert_eq!(
        super::normalize_windows_docker_host_path("/mnt/c/Users/x", WslMnt),
        "/mnt/c/Users/x"
    );
    // Bare drive root.
    assert_eq!(
        super::normalize_windows_docker_host_path(r"C:\", Drive),
        "/c"
    );
    assert_eq!(
        super::normalize_windows_docker_host_path(r"C:\", WslMnt),
        "/mnt/c"
    );
    // Non-drive paths (unix socket, named pipe) are never rewritten.
    for style in [Drive, WslMnt] {
        assert_eq!(
            super::normalize_windows_docker_host_path("/var/run/docker.sock", style),
            "/var/run/docker.sock"
        );
        assert_eq!(
            super::normalize_windows_docker_host_path(r"\\.\pipe\docker_engine", style),
            "//./pipe/docker_engine"
        );
    }
}

#[test]
fn extract_ioreg_platform_uuid_parses_macos_output() {
    let sample = r#""IOPlatformUUID" = "06151E8B-A400-470C-B48C-67AE51D297A9""#;
    assert_eq!(
        super::extract_ioreg_platform_uuid(sample),
        Some("06151E8B-A400-470C-B48C-67AE51D297A9".to_string())
    );
}

#[test]
fn extract_system_profiler_serial_parses_hardware_output() {
    let sample = "      Serial Number (system): C02XYZ123456";
    assert_eq!(
        super::extract_system_profiler_serial(sample),
        Some("C02XYZ123456".to_string())
    );
}

#[test]
fn rejects_placeholder_host_device_ids() {
    assert!(!super::is_usable_host_device_id("Not Specified"));
    assert!(!super::is_usable_host_device_id(
        "00000000-0000-0000-0000-000000000000"
    ));
    assert!(super::is_usable_host_device_id(
        "06151E8B-A400-470C-B48C-67AE51D297A9"
    ));
}

#[cfg(windows)]
#[test]
fn renders_windows_runtime_env_with_docker_safe_mount_paths() {
    let data_dir = PathBuf::from(r"C:\Users\hegem\AppData\Roaming\companion-hub");
    let mut existing = std::collections::HashMap::new();
    existing.insert(
        "ROOT_FOLDER_HOST".to_string(),
        r"C:\Users\hegem\AppData\Roaming\companion-hub".to_string(),
    );
    existing.insert("JWT_SECRET".to_string(), "jwt".to_string());
    existing.insert("POSTGRES_PASSWORD".to_string(), "postgres".to_string());

    let env = super::render_runtime_env_content(&data_dir, &existing);

    // The drive prefix depends on the backend detected at runtime (`/c/...` for
    // Docker Desktop, `/mnt/c/...` for a native WSL2 engine), but every path in
    // one render must use the SAME style — a mixed-style .env breaks half the
    // mounts. Derive the single expected prefix from the same detection the
    // renderer uses and assert both keys exactly.
    let prefix = match super::windows_docker_host_style() {
        super::WindowsDockerHostStyle::Drive => "/c",
        super::WindowsDockerHostStyle::WslMnt => "/mnt/c",
    };
    assert!(
        env.contains(&format!(
            "ROOT_FOLDER_HOST={prefix}/Users/hegem/AppData/Roaming/companion-hub\n"
        )),
        "env should normalize ROOT_FOLDER_HOST to the detected backend style ({prefix}): {env}"
    );
    assert!(
            env.contains(&format!(
                "COMPOSE_FILE_HOST={prefix}/Users/hegem/AppData/Roaming/companion-hub/docker-compose.prod.yml\n"
            )),
            "env should expose the compose file mount in the same backend style ({prefix}): {env}"
        );
    assert!(
        !env.contains(r"ROOT_FOLDER_HOST=C:\") && !env.contains(r"COMPOSE_FILE_HOST=C:\"),
        "env must not leak a raw Windows path: {env}"
    );
}

// Windows-only by design: the reverse mapping (host_path_from_docker_path) has a
// passthrough impl on other hosts, so the assertions only mean something where
// the real parser is compiled. Gating the #[test] itself (not an inner block)
// keeps non-Windows CI from reporting an empty always-green test.
#[cfg(windows)]
#[test]
fn detect_style_round_trips_through_host_path() {
    use super::WindowsDockerHostStyle::{Drive, WslMnt};
    // A value normalized for either backend must map back to the same native
    // Windows path via host_path_from_docker_path (the reverse used for
    // desktop-side filesystem access) — including bare drive roots, whose
    // normalized forms have no trailing slash (`/c`, `/mnt/c`).
    for native in [r"C:\Users\hegem\AppData\Roaming\companion-hub", r"C:\"] {
        for style in [Drive, WslMnt] {
            let mount = super::normalize_windows_docker_host_path(native, style);
            assert_eq!(
                super::host_path_from_docker_path(&mount),
                std::path::PathBuf::from(native),
                "round-trip failed for {style:?} via {mount}"
            );
        }
    }
}
