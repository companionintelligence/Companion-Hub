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

#[cfg(unix)]
fn mode_of(path: &std::path::Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777
}

#[cfg(unix)]
fn state_file_with_mode(dir: &std::path::Path, name: &str, mode: u32) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, b"{}").expect("write");
    // set_permissions, not a create mode: that one is masked by the umask, and 0o666 is the point.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).expect("chmod");
    path
}

#[cfg(unix)]
#[test]
fn seeds_settings_json_owner_only() {
    let dir = tempfile::tempdir().expect("tempdir");
    let settings = dir.path().join("settings.json");

    seed_settings_json(&settings).expect("seed");

    assert_eq!(std::fs::read_to_string(&settings).unwrap(), "{}");
    assert_eq!(mode_of(&settings), 0o600);
}

#[cfg(unix)]
#[test]
fn restricts_world_writable_credential_file_to_owner_only() {
    // core-2's settings.json was 0666 while holding the device keys.
    let dir = tempfile::tempdir().expect("tempdir");
    let settings = state_file_with_mode(dir.path(), "settings.json", 0o666);

    assert_eq!(restrict_private_state_file(&settings), Some(0o666));
    assert_eq!(mode_of(&settings), 0o600);
    // Already private: nothing to do, nothing reported.
    assert_eq!(restrict_private_state_file(&settings), None);
}

#[cfg(unix)]
#[test]
fn restricting_never_adds_a_bit() {
    let dir = tempfile::tempdir().expect("tempdir");
    let read_only = state_file_with_mode(dir.path(), "seed", 0o400);
    let owner_read_world_write = state_file_with_mode(dir.path(), "settings.json", 0o422);

    assert_eq!(restrict_private_state_file(&read_only), None);
    assert_eq!(mode_of(&read_only), 0o400);
    // 0o422 & 0o600 = 0o400: the owner does not gain the write bit it lacked.
    assert_eq!(
        restrict_private_state_file(&owner_read_world_write),
        Some(0o422)
    );
    assert_eq!(mode_of(&owner_read_world_write), 0o400);
}

#[cfg(unix)]
#[test]
fn restricting_a_missing_file_is_a_no_op() {
    let dir = tempfile::tempdir().expect("tempdir");
    assert_eq!(restrict_private_state_file(&dir.path().join("seed")), None);
}
