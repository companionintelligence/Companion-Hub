//! Tests for the `core` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn webview_cache_clear_needed_decision() {
    // Fresh install / first run with this logic → clear.
    assert!(crate::hub_manager::webview_cache_clear_needed(
        None, "0.2.27"
    ));
    // Version changed (post-update first boot) → clear.
    assert!(crate::hub_manager::webview_cache_clear_needed(
        Some("0.2.26"),
        "0.2.27"
    ));
    // Same version (normal relaunch) → keep cache, no cleanup.
    assert!(!crate::hub_manager::webview_cache_clear_needed(
        Some("0.2.27"),
        "0.2.27"
    ));
    // Tolerate trailing whitespace/newline from the marker file.
    assert!(!crate::hub_manager::webview_cache_clear_needed(
        Some("0.2.27\n"),
        "0.2.27"
    ));
}

#[test]
fn docker_access_cache_ttl_is_five_seconds() {
    use std::time::{Duration, Instant};
    let start = Instant::now();
    assert!(crate::hub_manager::docker_access_cache_is_fresh(
        start,
        start,
        Duration::from_secs(5)
    ));
    assert!(crate::hub_manager::docker_access_cache_is_fresh(
        start,
        start + Duration::from_secs(4),
        Duration::from_secs(5)
    ));
    assert!(!crate::hub_manager::docker_access_cache_is_fresh(
        start,
        start + Duration::from_secs(5),
        Duration::from_secs(5)
    ));
}

#[test]
fn ensure_hub_compose_file_writes_embedded_seed_when_missing() {
    let dir = tempfile::tempdir().expect("tempdir");
    let compose_path = dir.path().join(crate::hub_manager::HUB_COMPOSE_FILENAME);
    assert!(!compose_path.exists());

    crate::hub_manager::ensure_hub_compose_file(&compose_path, dir.path()).expect("write seed");

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
    let compose_path = dir.path().join(crate::hub_manager::HUB_COMPOSE_FILENAME);
    std::fs::write(&compose_path, "services: {}\n").expect("seed existing");

    crate::hub_manager::ensure_hub_compose_file(&compose_path, dir.path()).expect("noop");

    let written = std::fs::read_to_string(&compose_path).expect("read compose");
    assert_eq!(written, "services: {}\n");
}

#[test]
fn classifies_daemon_unavailable_before_permission_denied() {
    let result = classify_docker_access_result(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
            Some(1),
        );

    assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
}

#[test]
fn classifies_docker_29_missing_socket_as_daemon_unavailable() {
    let result = classify_docker_access_result(
        "failed to connect to the docker API at unix:///Users/me/.docker/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/me/.docker/run/docker.sock: connect: no such file or directory\nClient:\n Version:    29.6.0",
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

/// What `docker info` prints when the daemon answered: the client part, then the server's.
const DOCKER_INFO_ANSWERED: &str = "Client: Docker Engine - Community\n Version:    29.9.3\n Context:    default\n\nServer:\n Containers: 5\n  Running: 5\n Server Version: 29.9.3";

#[test]
fn an_unreadable_docker_config_file_does_not_read_as_refused_access() {
    // `sudo docker login` leaves the config file owned by root. The CLI warns and carries on.
    let result = docker_access_from_info_output(
        true,
        Some(0),
        DOCKER_INFO_ANSWERED,
        "WARNING: Error loading config file: open /home/me/.docker/config.json: permission denied",
    );

    assert!(matches!(result.state, DockerAccessState::Available));
}

#[test]
fn an_unreadable_docker_config_file_on_windows_does_not_read_as_refused_access() {
    let result = docker_access_from_info_output(
        true,
        Some(0),
        DOCKER_INFO_ANSWERED,
        "WARNING: Error loading config file: open C:\\Users\\me\\.docker\\config.json: Access is denied.",
    );

    assert!(matches!(result.state, DockerAccessState::Available));
}

#[test]
fn a_refused_user_with_an_unreadable_config_file_gets_docker_error_first() {
    let result = docker_access_from_info_output(
        false,
        Some(1),
        "",
        "WARNING: Error loading config file: open /home/me/.docker/config.json: permission denied\n\
         permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
    );

    assert!(matches!(result.state, DockerAccessState::PermissionDenied));
    assert_eq!(
        result.detail.as_deref().and_then(|detail| detail.lines().next()),
        Some("permission denied while trying to connect to the docker API at unix:///var/run/docker.sock")
    );
}

#[test]
fn a_stopped_daemon_with_an_unreadable_config_file_reads_as_not_running() {
    let result = docker_access_from_info_output(
        false,
        Some(1),
        "",
        "WARNING: Error loading config file: open /home/me/.docker/config.json: permission denied\n\
         Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );

    assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
    assert_eq!(
        result.detail.as_deref().and_then(|detail| detail.lines().next()),
        Some("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")
    );
}

#[test]
fn a_failed_check_after_an_unreadable_config_file_says_the_settings_were_skipped() {
    // An unreadable config file also loses the registry logins and, with no engine pinned, the
    // current context.
    let result = docker_access_from_info_output(
        false,
        Some(1),
        "",
        "WARNING: Error loading config file: open C:\\Users\\me\\.docker\\config.json: Access is denied.\n\
         failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running",
    );

    assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
    let detail = result.detail.unwrap_or_default();
    assert!(detail.ends_with(CONFIG_FILE_UNREADABLE_NOTE));
    assert!(!detail.to_lowercase().contains("access is denied"));
}

#[test]
fn the_skipped_config_note_comes_before_the_client_section_of_docker_info() {
    // The screens show only the first lines of the detail, and `docker info` prints the client's
    // version and plugins to stdout after the error.
    let result = docker_access_from_info_output(
        false,
        Some(1),
        "Client: Docker Engine - Community\n Version:    29.9.3\n Context:    default\n\nServer:",
        "WARNING: Error loading config file: open /home/me/.docker/config.json: permission denied\n\
         failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running",
    );

    assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
    let detail = result.detail.unwrap_or_default();
    let lines: Vec<&str> = detail.lines().collect();
    assert_eq!(
        lines.first().copied(),
        Some("failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running")
    );
    assert_eq!(lines.get(1).copied(), Some(CONFIG_FILE_UNREADABLE_NOTE));
    assert_eq!(
        lines.get(2).copied(),
        Some("Client: Docker Engine - Community")
    );
}

#[test]
fn a_broken_docker_config_file_is_not_the_first_line_of_the_error() {
    let result = docker_access_from_info_output(
        false,
        Some(1),
        "",
        "WARNING: Error parsing config file (/home/me/.docker/config.json): invalid character 'b' looking for beginning of object key string\n\
         Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    );

    assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
    assert_eq!(
        result.detail.as_deref().and_then(|detail| detail.lines().next()),
        Some("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")
    );
}

#[test]
fn a_cli_plugin_that_cannot_run_does_not_read_as_refused_access() {
    // A plugin left owned by root, or without its execute bit, makes the CLI warn and carry on.
    let result = docker_access_from_info_output(
        true,
        Some(0),
        DOCKER_INFO_ANSWERED,
        "WARNING: Plugin \"/home/me/.docker/cli-plugins/docker-buildx\" is not valid: failed to fetch metadata: fork/exec /home/me/.docker/cli-plugins/docker-buildx: permission denied",
    );

    assert!(matches!(result.state, DockerAccessState::Available));
}

#[test]
fn a_docker_context_the_cli_cannot_read_does_not_read_as_refused_access() {
    // `sudo docker context create` leaves `~/.docker/contexts` owned by root. The CLI then stops
    // before it asks any engine, so this user was never refused.
    let result = docker_access_from_info_output(
        false,
        Some(1),
        "",
        "Failed to initialize: unable to resolve docker endpoint: context \"remote\": open /home/me/.docker/contexts/meta/0123abcd/meta.json: permission denied",
    );

    assert!(matches!(result.state, DockerAccessState::Error));
    assert_eq!(
        result.detail.as_deref(),
        Some("Failed to initialize: unable to resolve docker endpoint: context \"remote\": open /home/me/.docker/contexts/meta/0123abcd/meta.json: permission denied")
    );
}

#[test]
fn a_docker_context_the_cli_cannot_read_on_windows_does_not_read_as_refused_access() {
    let result = docker_access_from_info_output(
        false,
        Some(1),
        "",
        "Failed to initialize: unable to resolve docker endpoint: context \"remote\": open C:\\Users\\me\\.docker\\contexts\\meta\\0123abcd\\meta.json: Access is denied.",
    );

    assert!(matches!(result.state, DockerAccessState::Error));
}

#[test]
fn a_docker_context_docker_20_cannot_read_does_not_read_as_refused_access() {
    // Docker 20.10 checks the current context before anything else and prints only its file and why.
    for stderr in [
        "open /home/me/.docker/contexts/meta/0123abcd/meta.json: permission denied",
        "open C:\\Users\\me\\.docker\\contexts\\meta\\0123abcd\\meta.json: Access is denied.",
    ] {
        let result = docker_access_from_info_output(false, Some(1), "", stderr);

        assert!(matches!(result.state, DockerAccessState::Error), "{stderr}");
    }
}

#[test]
fn a_daemon_refusing_access_still_reads_as_refused_when_docker_info_exits_zero() {
    let result = docker_access_from_info_output(
        true,
        Some(0),
        "Client: Docker Engine - Community\n Version:    29.9.3\n\nServer:",
        "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
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
fn truncates_long_command_output() {
    let output = format!(
        "{}Error: the cause",
        "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 25)
    );
    let truncated = truncate_command_output(&output);

    assert!(truncated.starts_with("[truncated 41 chars]"));
    assert!(truncated.ends_with("Error: the cause"));
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

/// Traefik reads the dynamic file as a Go template, so a `{{` anywhere in what this app writes made it
/// drop the whole file (forward auth, the tunnel apps' edge headers) until the Hub booted and filled
/// the placeholder in. And because the Hub's copy then differed from this one, every launch wrote the
/// placeholder back and had Traefik recreated (Companion-Hub#1832). The asset now ships the Hub's
/// default container name, which is the one this app's compose gives it, and the Hub leaves the file
/// as shipped on that name: the two copies are the same file.
#[test]
fn seeds_a_dynamic_config_traefik_can_read_and_the_hub_leaves_alone() {
    let hub = crate::hub_names::HUB_CONTAINER;

    assert!(
        !TRAEFIK_DYNAMIC_CONFIG_SEED.contains("{{"),
        "dynamic.yml must not hold a template placeholder"
    );
    assert!(TRAEFIK_DYNAMIC_CONFIG_SEED.contains(&format!(
        "\"http://{hub}:5002/api/auth/traefik\" # hub container"
    )));
    assert!(TRAEFIK_DYNAMIC_CONFIG_SEED.contains(&format!("\"http://{hub}:5002\" # hub container")));
    assert!(crate::hub_manager::HUB_COMPOSE_SEED.contains(&format!("HUB_CONTAINER_NAME: {hub}")));
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
fn rotates_desktop_log_when_it_exceeds_max_size() {
    use crate::hub_manager::{rotate_log_if_needed, DESKTOP_LOG_FILENAME, MAX_LOG_ROTATIONS};

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

#[test]
fn tests_get_a_hub_data_dir_of_their_own_in_the_temp_dir() {
    // The real one belongs to the Hub installed on a developer's machine, and code that tests
    // reach writes there without being handed a data dir: the Docker engine choice, for one.
    let data_dir = get_hub_data_dir();
    assert_eq!(
        data_dir.parent().and_then(Path::parent),
        Some(std::env::temp_dir().as_path()),
        "{}",
        data_dir.display()
    );
    assert!(
        data_dir.ends_with("companion-hub"),
        "{}",
        data_dir.display()
    );
    assert_eq!(
        get_hub_data_dir(),
        data_dir,
        "one folder for the whole test process"
    );
}

// The same cases as `XDG_DATA_HOME set by a snap` in `scripts/__tests__/paths.test.ts`.
#[cfg(target_os = "linux")]
fn linux_data_home_for(xdg_data_home: Option<&str>, snap_name: Option<&str>) -> PathBuf {
    crate::hub_manager::linux_data_home(
        xdg_data_home.map(Path::new),
        snap_name,
        Path::new("/home/tester"),
    )
}

#[cfg(target_os = "linux")]
#[test]
fn linux_data_home_is_local_share_when_xdg_data_home_is_unset_blank_or_relative() {
    let local_share = Path::new("/home/tester/.local/share");
    assert_eq!(linux_data_home_for(None, None), local_share);
    assert_eq!(linux_data_home_for(Some(""), None), local_share);
    assert_eq!(linux_data_home_for(Some("  "), None), local_share);
    // `dirs::data_dir()` ignores a relative XDG_DATA_HOME too.
    assert_eq!(linux_data_home_for(Some("xdg/data"), None), local_share);
}

#[cfg(target_os = "linux")]
#[test]
fn linux_data_home_ignores_xdg_data_home_whenever_another_snap_runs_the_app() {
    let local_share = Path::new("/home/tester/.local/share");
    let code_snap_data = "/home/tester/snap/code/264/.local/share";
    assert_eq!(
        linux_data_home_for(Some(code_snap_data), Some("code")),
        local_share
    );
    assert_eq!(
        linux_data_home_for(Some("/xdg/data"), Some("code")),
        local_share
    );
}

#[cfg(target_os = "linux")]
#[test]
fn linux_data_home_ignores_another_snaps_folder_by_its_path_alone() {
    // A process can inherit XDG_DATA_HOME from that snap's terminal without SNAP_NAME.
    let local_share = Path::new("/home/tester/.local/share");
    let code_snap_data = "/home/tester/snap/code/264/.local/share";
    assert_eq!(linux_data_home_for(Some(code_snap_data), None), local_share);
    assert_eq!(
        linux_data_home_for(Some(code_snap_data), Some("")),
        local_share
    );
    assert_eq!(
        linux_data_home_for(Some(code_snap_data), Some("companion-hub")),
        local_share
    );
}

#[cfg(target_os = "linux")]
#[test]
fn linux_data_home_keeps_the_folder_our_own_snap_sets() {
    let own_snap_data = "/home/tester/snap/companion-hub/12/.local/share";
    assert_eq!(
        linux_data_home_for(Some(own_snap_data), Some("companion-hub")),
        Path::new(own_snap_data)
    );
    // A parallel install lives in `~/snap/<name>_<key>/`.
    let instance_data = "/home/tester/snap/companion-hub_beta/3/.local/share";
    assert_eq!(
        linux_data_home_for(Some(instance_data), Some("companion-hub")),
        Path::new(instance_data)
    );
}

#[cfg(target_os = "linux")]
#[test]
fn linux_data_home_keeps_xdg_data_home_outside_any_snap_folder() {
    assert_eq!(
        linux_data_home_for(Some("/xdg/data"), None),
        Path::new("/xdg/data")
    );
    assert_eq!(
        linux_data_home_for(Some("/home/tester/snapshots/share"), None),
        Path::new("/home/tester/snapshots/share")
    );
    assert_eq!(
        linux_data_home_for(Some("/xdg/data"), Some("companion-hub")),
        Path::new("/xdg/data")
    );
    assert_eq!(
        linux_data_home_for(Some("/xdg/data"), Some("  ")),
        Path::new("/xdg/data")
    );
}
