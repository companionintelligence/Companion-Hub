//! Tests for the `compose` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

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
