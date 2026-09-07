//! Tests for the `logging` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

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

#[test]
fn parses_running_app_container_ids_from_docker_ps_output() {
    assert_eq!(
        parse_container_ids("abc123\n\n def456 \n"),
        vec!["abc123".to_string(), "def456".to_string()]
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
