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

#[test]
fn keeps_proxy_settings_for_the_containers_the_hub_starts() {
    // Docker Compose sets HTTPS_PROXY, NO_PROXY and the rest from `proxies` in every container it
    // creates. The Hub's own compose calls (its self-update, every app install and start) read this
    // copy, so dropping it left them without the proxy the desktop's containers get (#1765).
    let fixture = r#"{
            "auths": {
                "https://index.docker.io/v1/": { "auth": "dXNlcjpwYXNz" }
            },
            "proxies": {
                "default": {
                    "httpProxy": "http://proxy.example:3128",
                    "httpsProxy": "http://proxy.example:3128",
                    "noProxy": "localhost,127.0.0.1,.example.internal"
                },
                "tcp://docker.example:2376": { "httpsProxy": "http://other-proxy.example:3128" }
            },
            "credsStore": "desktop",
            "credHelpers": { "ghcr.io": "desktop" },
            "currentContext": "desktop-linux",
            "plugins": { "debug": { "enabled": true } },
            "features": { "hooks": "true" },
            "hooks": { "x": {} },
            "aliases": { "builder": "buildx" },
            "experimental": "enabled"
        }"#;

    let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
    let tmp = tempfile::tempdir().expect("create temp dir");
    let data_dir = tmp.path().to_path_buf();
    generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

    let config_path = data_dir.join(".docker").join("config.json");
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();

    assert_eq!(
        parsed.get("proxies"),
        Some(&serde_json::json!({
            "default": {
                "httpProxy": "http://proxy.example:3128",
                "httpsProxy": "http://proxy.example:3128",
                "noProxy": "localhost,127.0.0.1,.example.internal"
            },
            "tcp://docker.example:2376": { "httpsProxy": "http://other-proxy.example:3128" }
        })),
        "proxies should be copied as they are"
    );
    let mut kept: Vec<&str> = parsed
        .as_object()
        .expect("config is an object")
        .keys()
        .map(String::as_str)
        .collect();
    kept.sort_unstable();
    assert_eq!(
        kept,
        ["auths", "proxies"],
        "host-only keys are still dropped"
    );
}

#[test]
fn drops_a_proxies_entry_the_docker_cli_cannot_read() {
    // The Docker CLI ignores a whole config file it cannot parse ("Error parsing config file"), so a
    // `proxies` that is not an object would also cost the Hub the registry logins kept beside it.
    let fixture = r#"{
            "auths": { "registry.example": { "auth": "dXNlcjpwYXNz" } },
            "proxies": "http://proxy.example:3128"
        }"#;

    let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
    let tmp = tempfile::tempdir().expect("create temp dir");
    let data_dir = tmp.path().to_path_buf();
    generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

    let parsed: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(data_dir.join(".docker").join("config.json")).unwrap(),
    )
    .unwrap();
    assert!(parsed.get("proxies").is_none());
    assert_eq!(
        parsed.get("auths"),
        Some(&serde_json::json!({ "registry.example": { "auth": "dXNlcjpwYXNz" } }))
    );
}

/// What a launch writes to the env file before it decides whether to start the Hub, shaped like the
/// output of `render_runtime_env_content` with its two commented sections and the blank line.
const RENDERED_ENV: &str = "# Preserved (kept once set, survive upgrades)\n\
                            ROOT_FOLDER_HOST=/mnt/c/Users/user/AppData/Roaming/companion-hub\n\
                            DOMAIN=ci0.pw\n\
                            \n\
                            # Derived (recomputed every launch from the current binary)\n\
                            CI_HUB_VERSION=0.3.4\n\
                            CI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:0.3.4\n";

/// The start saves the configuration hash after the port manager has added the ports to the env
/// file. A launch that dropped them again hashed a different file, so every launch saw a changed
/// configuration and recreated a healthy stack (Companion-Hub#1931).
#[test]
fn a_launch_that_changes_nothing_hashes_the_configuration_the_last_start_saved() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path();
    let compose = data_dir.join(HUB_COMPOSE_FILENAME);
    let env = data_dir.join(".env");
    std::fs::write(&compose, "services: {}\n").expect("write compose");

    // A launch writes the env file. Its start adds the ports, and saves the hash after compose up.
    std::fs::write(&env, launch_env_file_content(RENDERED_ENV, "")).expect("write env");
    let ports = crate::port_manager::PortResolution {
        env_vars: [
            ("HTTP_PORT", 80),
            ("HTTPS_PORT", 443),
            ("API_PORT", 5002),
            ("POSTGRES_PORT", 6543),
            ("RABBITMQ_PORT", 5001),
            ("TRAEFIK_DASHBOARD_PORT", 8080),
        ]
        .into_iter()
        .map(|(var, port)| (var.to_string(), port))
        .collect(),
        warnings: Vec::new(),
        info: Vec::new(),
    };
    crate::port_manager::write_ports_to_env(&env, &ports).expect("write ports");
    persist_config_hash(data_dir, &compose, &env);

    // The next launch renders the same env file again.
    let previous = std::fs::read_to_string(&env).expect("read env");
    std::fs::write(&env, launch_env_file_content(RENDERED_ENV, &previous)).expect("write env");

    assert_eq!(
        std::fs::read_to_string(data_dir.join(".config-hash")).expect("saved hash"),
        compute_config_hash(&compose, &env)
    );
}

/// The desktop finds the Hub on the `API_PORT` in the env file, and every compose call against the
/// stack reads the other ports from it. A launch that leaves the running Hub alone has to leave
/// them as the last start chose them, fallbacks included.
#[test]
fn a_launch_keeps_the_ports_the_last_start_chose() {
    let previous =
        "ROOT_FOLDER_HOST=/mnt/c/hub\nCI_HUB_VERSION=0.3.3\nAPI_PORT=5003\nHTTP_PORT=8880\n";

    let content = launch_env_file_content(
        "ROOT_FOLDER_HOST=/mnt/c/hub\nCI_HUB_VERSION=0.3.4\n",
        previous,
    );

    assert_eq!(
        content,
        "ROOT_FOLDER_HOST=/mnt/c/hub\nCI_HUB_VERSION=0.3.4\nAPI_PORT=5003\nHTTP_PORT=8880\n"
    );
}
