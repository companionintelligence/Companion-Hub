//! Tests for the `runtime_state` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

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

#[cfg(not(target_os = "windows"))]
#[test]
fn parses_docker_socket_stat_output() {
    assert_eq!(parse_docker_socket_uid_gid("0:0"), Some((0, 0)));
    assert_eq!(parse_docker_socket_uid_gid("0:998\n"), Some((0, 998)));
    assert_eq!(parse_docker_socket_uid_gid("bad"), None);
}

#[cfg(unix)]
#[test]
fn host_container_uid_gid_matches_current_process_on_unix() {
    let (uid, gid) = host_container_uid_gid();
    assert_eq!(uid, unsafe { libc::getuid() });
    assert_eq!(gid, unsafe { libc::getgid() });
}

#[test]
fn detects_docker_missing_resource_messages() {
    assert!(crate::hub_manager::is_docker_missing_resource_message(
        "Error response from daemon: No such container: traefik"
    ));
    assert!(crate::hub_manager::is_docker_missing_resource_message(
        "Error response from daemon: No such object: traefik"
    ));
    assert!(!crate::hub_manager::is_docker_missing_resource_message(
        "permission denied while trying to connect"
    ));
}
