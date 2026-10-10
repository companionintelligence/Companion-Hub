//! Tests for the `runtime_state` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

/// Through the path, not the process: the Docker host `host_docker_socket_path` reads is process-wide
/// (the engine pin, then the environment), and a test that set `DOCKER_HOST` and cleared the pin lost
/// to any test pinning the machine's own engine in between (Companion-Hub#1833). The environment
/// lookup has its own test in `docker_engine`.
#[test]
fn prefers_docker_host_unix_socket_path() {
    assert_eq!(
        host_docker_socket_path_for(Some("unix:///tmp/ci-hub-docker.sock")),
        PathBuf::from("/tmp/ci-hub-docker.sock")
    );
}

#[test]
fn falls_back_to_a_local_socket_for_a_docker_host_that_is_not_one() {
    for docker_host in [None, Some("tcp://10.0.0.5:2376"), Some("unix://")] {
        let path = host_docker_socket_path_for(docker_host);
        assert!(
            path.to_string_lossy().ends_with("docker.sock"),
            "{docker_host:?} gave {}",
            path.display()
        );
    }
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

// The exact strings, which `bindMountHealScript`'s tests in
// scripts/__tests__/heal-hub-bind-mounts.test.ts pin too: the two heals must stay the same script.
#[cfg(not(target_os = "windows"))]
#[test]
fn docker_permission_repair_leaves_the_update_listener_token_alone() {
    let script = bind_mount_heal_script(1000, 1000, &["update-listener.token"]);

    let walk = "find /mnt ! -path '/mnt/update-listener.token'";
    assert_eq!(
        script,
        format!(
            "{walk} -exec chown -h 1000:1000 {{}} + 2>/dev/null || true; \
             if [ \"$(stat -c %u /mnt 2>/dev/null)\" = \"1000\" ]; then {walk} ! -type l -exec chmod u+rwX,g+rwX,o-w {{}} + 2>/dev/null || true; \
             else {walk} ! -type l -exec chmod u+rwX,g+rwX,o+rwX {{}} + 2>/dev/null || {walk} ! -type l -exec chmod a+rwX {{}} + 2>/dev/null || true; fi"
        )
    );
    // Nothing recursive that would reach the token.
    assert!(!script.contains(" -R "));
}

#[cfg(not(target_os = "windows"))]
#[test]
fn docker_permission_repair_with_nothing_to_keep_is_the_recursive_one() {
    assert_eq!(
        bind_mount_heal_script(1000, 1000, &[]),
        "chown -R 1000:1000 /mnt 2>/dev/null || true; \
         if [ \"$(stat -c %u /mnt 2>/dev/null)\" = \"1000\" ]; then chmod -R u+rwX,g+rwX,o-w /mnt 2>/dev/null || true; \
         else chmod -R u+rwX,g+rwX,o+rwX /mnt 2>/dev/null || chmod -R a+rwX /mnt 2>/dev/null || true; fi"
    );
}

/// The Hub rewrites both Traefik files on every boot (`AppService.copyAssets`) with LF line endings,
/// and its write adds a newline to a file that already ends with one. A Windows build embeds the
/// seeds with the CRLF line endings of the checkout it was built from. Neither changes what Traefik
/// reads, and counting either as a change recreated Traefik and the whole Hub on every launch
/// (Companion-Hub#1931).
#[test]
fn a_launch_leaves_traefik_files_alone_that_differ_only_in_line_endings() {
    fn with_lf(text: &str) -> String {
        text.replace("\r\n", "\n")
    }
    fn as_the_hub_writes_it(seed: &str) -> String {
        format!("{}\n", with_lf(seed))
    }
    fn as_a_windows_build_writes_it(seed: &str) -> String {
        with_lf(seed).replace('\n', "\r\n")
    }

    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path();
    prepare_traefik_runtime_state(data_dir).expect("first launch");
    let seeds = [
        (TRAEFIK_CONFIG_FILE, seeded_traefik_config_contents()),
        (
            TRAEFIK_DYNAMIC_FILE,
            TRAEFIK_DYNAMIC_CONFIG_SEED.to_string(),
        ),
    ];

    for rewrite in [as_the_hub_writes_it, as_a_windows_build_writes_it] {
        for (file, seed) in &seeds {
            std::fs::write(data_dir.join(file), rewrite(seed)).expect("rewrite");
        }

        let result = prepare_traefik_runtime_state(data_dir).expect("next launch");

        assert!(!result.changed, "no change, so nothing to recreate");
        for (file, seed) in &seeds {
            assert_eq!(
                std::fs::read_to_string(data_dir.join(file)).expect("read"),
                rewrite(seed),
                "{file} is left as it was"
            );
        }
    }
}

#[test]
fn a_launch_still_replaces_a_traefik_file_whose_content_differs() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path();
    prepare_traefik_runtime_state(data_dir).expect("first launch");
    let dynamic = data_dir.join(TRAEFIK_DYNAMIC_FILE);
    std::fs::write(&dynamic, "http: {}\n").expect("write an older dynamic.yml");

    let result = prepare_traefik_runtime_state(data_dir).expect("next launch");

    assert!(result.changed);
    assert_eq!(
        std::fs::read_to_string(&dynamic).expect("read"),
        TRAEFIK_DYNAMIC_CONFIG_SEED
    );
}
