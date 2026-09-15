//! Tests for the `runtime_env` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn private_vpn_requires_auth_key_or_state_and_ignores_legacy_enabled_false() {
    use crate::hub_manager::private_vpn_should_run;
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
    assert!(crate::hub_manager::has_tailscale_auth_key(&env));
    assert!(crate::hub_manager::private_vpn_should_run(
        false,
        crate::hub_manager::has_tailscale_auth_key(&env),
        false
    ));
}

#[test]
fn merge_compose_profiles_adds_private_vpn_by_default() {
    let env = std::collections::HashMap::new();
    assert_eq!(merge_compose_profiles(&env, true), "private-vpn");
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
fn extract_ioreg_platform_uuid_parses_macos_output() {
    let sample = r#""IOPlatformUUID" = "06151E8B-A400-470C-B48C-67AE51D297A9""#;
    assert_eq!(
        crate::hub_manager::extract_ioreg_platform_uuid(sample),
        Some("06151E8B-A400-470C-B48C-67AE51D297A9".to_string())
    );
}

#[test]
fn extract_system_profiler_serial_parses_hardware_output() {
    let sample = "      Serial Number (system): C02XYZ123456";
    assert_eq!(
        crate::hub_manager::extract_system_profiler_serial(sample),
        Some("C02XYZ123456".to_string())
    );
}

#[test]
fn rejects_placeholder_host_device_ids() {
    assert!(!crate::hub_manager::is_usable_host_device_id(
        "Not Specified"
    ));
    assert!(!crate::hub_manager::is_usable_host_device_id(
        "00000000-0000-0000-0000-000000000000"
    ));
    assert!(crate::hub_manager::is_usable_host_device_id(
        "06151E8B-A400-470C-B48C-67AE51D297A9"
    ));
}

// --- Portal URL override (CI_HUB_CLOUD_URL_OVERRIDE) ---

use crate::portal_url::{compiled_ci_cloud_url, PORTAL_URL_OVERRIDE_KEY};

/// Differs from every compiled default, so a pass cannot come from the build's own Portal.
const OTHER_PORTAL: &str = "https://portal.example.test";

/// Stable secrets, so two renders of the same data dir differ only where the Portal decision does.
fn portal_test_env_lines() -> String {
    "JWT_SECRET=jwt-test\nPOSTGRES_PASSWORD=postgres-test\nRABBITMQ_PASSWORD=rabbit-test\nPRIVATE_VPN_USER_DISABLED=true\n"
        .to_string()
}

fn portal_test_env_map() -> std::collections::HashMap<String, String> {
    portal_test_env_lines()
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn portal_test_data_dir() -> (tempfile::TempDir, std::path::PathBuf) {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("companion-hub");
    std::fs::create_dir_all(data_dir.join("state")).expect("mkdir state");
    (tempdir, data_dir)
}

fn read_desktop_log(data_dir: &std::path::Path) -> String {
    std::fs::read_to_string(crate::hub_manager::desktop_log_path_for(data_dir)).unwrap_or_default()
}

fn both_env_paths(data_dir: &std::path::Path) -> [std::path::PathBuf; 2] {
    [
        crate::hub_manager::hub_env_path_for(data_dir),
        crate::hub_manager::compat_hub_env_path_for(data_dir),
    ]
}

#[test]
fn runtime_env_without_portal_override_uses_the_compiled_portal() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let env = render_runtime_env_content(&data_dir, &portal_test_env_map());

    assert!(
        env.contains(&format!("CI_CLOUD_URL={}\n", compiled_ci_cloud_url())),
        "expected the compiled Portal: {env}"
    );
    assert!(
        !env.contains(PORTAL_URL_OVERRIDE_KEY),
        "no override key may appear when none was set: {env}"
    );
    assert!(read_desktop_log(&data_dir).is_empty());
}

#[test]
fn portal_override_changes_only_the_portal_lines_of_the_runtime_env() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let base = portal_test_env_map();
    let without = render_runtime_env_content(&data_dir, &base);

    let mut with_override = base.clone();
    with_override.insert(
        PORTAL_URL_OVERRIDE_KEY.to_string(),
        format!("{OTHER_PORTAL}/"),
    );
    let rendered = render_runtime_env_content(&data_dir, &with_override);

    let override_line = format!("{PORTAL_URL_OVERRIDE_KEY}={OTHER_PORTAL}/\n");
    let cloud_line = format!("CI_CLOUD_URL={OTHER_PORTAL}\n");
    assert!(rendered.contains(&cloud_line), "{rendered}");
    assert!(rendered.contains(&override_line), "{rendered}");

    // Undo exactly those two lines and the file must be byte-identical to a render without
    // the override: nothing else may depend on it.
    let reverted = rendered.replace(&override_line, "").replace(
        &cloud_line,
        &format!("CI_CLOUD_URL={}\n", compiled_ci_cloud_url()),
    );
    assert_eq!(reverted, without);
}

#[test]
fn portal_override_is_written_to_both_env_files_and_survives_relaunch() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let [env_path, compat_path] = both_env_paths(&data_dir);
    std::fs::write(
        &env_path,
        format!(
            "{}CI_CLOUD_URL={}\n{PORTAL_URL_OVERRIDE_KEY}={OTHER_PORTAL}\n",
            portal_test_env_lines(),
            compiled_ci_cloud_url()
        ),
    )
    .expect("write env");

    assert!(ensure_runtime_env_state(&data_dir, &env_path).expect("first launch"));
    // The second launch is the one that used to put the compiled Portal back.
    assert!(!ensure_runtime_env_state(&data_dir, &env_path).expect("relaunch"));

    for path in [&env_path, &compat_path] {
        let content = std::fs::read_to_string(path).expect("read env");
        assert!(
            content.contains(&format!("CI_CLOUD_URL={OTHER_PORTAL}\n")),
            "{}: {content}",
            path.display()
        );
        assert!(
            content.contains(&format!("{PORTAL_URL_OVERRIDE_KEY}={OTHER_PORTAL}\n")),
            "{}: {content}",
            path.display()
        );
    }
    assert!(read_desktop_log(&data_dir).contains(&format!(
        "Portal URL override active: CI_CLOUD_URL={OTHER_PORTAL}"
    )));
}

#[test]
fn removing_the_portal_override_restores_the_compiled_portal() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let [env_path, compat_path] = both_env_paths(&data_dir);
    std::fs::write(
        &env_path,
        format!(
            "{}{PORTAL_URL_OVERRIDE_KEY}={OTHER_PORTAL}\n",
            portal_test_env_lines()
        ),
    )
    .expect("write env");
    ensure_runtime_env_state(&data_dir, &env_path).expect("launch with override");

    // The launch copied the key into the compat file too, so switching back removes it from both.
    for path in [&env_path, &compat_path] {
        let content = std::fs::read_to_string(path).expect("read env");
        let stripped: String = content
            .lines()
            .filter(|line| !line.starts_with(PORTAL_URL_OVERRIDE_KEY))
            .map(|line| format!("{line}\n"))
            .collect();
        std::fs::write(path, stripped).expect("strip override");
    }
    ensure_runtime_env_state(&data_dir, &env_path).expect("launch without override");

    for path in [&env_path, &compat_path] {
        let content = std::fs::read_to_string(path).expect("read env");
        assert!(
            content.contains(&format!("CI_CLOUD_URL={}\n", compiled_ci_cloud_url())),
            "{}: {content}",
            path.display()
        );
        assert!(!content.contains(PORTAL_URL_OVERRIDE_KEY), "{content}");
    }
}

#[test]
fn an_invalid_portal_override_keeps_the_compiled_portal_and_logs_why() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let [env_path, compat_path] = both_env_paths(&data_dir);
    std::fs::write(
        &env_path,
        format!(
            "{}{PORTAL_URL_OVERRIDE_KEY}=http://portal.example.test\n",
            portal_test_env_lines()
        ),
    )
    .expect("write env");

    ensure_runtime_env_state(&data_dir, &env_path).expect("launch");

    for path in [&env_path, &compat_path] {
        let content = std::fs::read_to_string(path).expect("read env");
        assert!(
            content.contains(&format!("CI_CLOUD_URL={}\n", compiled_ci_cloud_url())),
            "{content}"
        );
        assert!(
            content.contains(&format!(
                "{PORTAL_URL_OVERRIDE_KEY}=http://portal.example.test\n"
            )),
            "the refused value stays in the file so it can be corrected: {content}"
        );
    }
    let log = read_desktop_log(&data_dir);
    assert!(
        log.contains(&format!("Ignoring {PORTAL_URL_OVERRIDE_KEY}"))
            && log.contains("must use https"),
        "{log}"
    );
    assert!(!log.contains("override active"), "{log}");
}

#[test]
fn switching_portal_under_a_registered_hub_logs_a_warning_once() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    std::fs::write(
        data_dir.join("state").join("settings.json"),
        r#"{"ciHubApiKey":"device-key-from-previous-portal"}"#,
    )
    .expect("write settings");
    let env_path = crate::hub_manager::hub_env_path_for(&data_dir);
    std::fs::write(
        &env_path,
        format!(
            "{}CI_CLOUD_URL={}\n{PORTAL_URL_OVERRIDE_KEY}={OTHER_PORTAL}\n",
            portal_test_env_lines(),
            compiled_ci_cloud_url()
        ),
    )
    .expect("write env");

    ensure_runtime_env_state(&data_dir, &env_path).expect("switching launch");
    ensure_runtime_env_state(&data_dir, &env_path).expect("next launch");

    let log = read_desktop_log(&data_dir);
    let warning = format!(
        "WARNING: Portal changed from {} to {OTHER_PORTAL}",
        compiled_ci_cloud_url()
    );
    assert_eq!(log.matches(&warning).count(), 1, "{log}");
    assert!(
        !log.contains("device-key-from-previous-portal"),
        "the device key must never be logged: {log}"
    );
}

#[test]
fn portal_switch_warning_needs_a_registration_and_a_real_change() {
    // Unregistered Hub: switching is harmless, nothing to warn about.
    let (_unregistered_dir, data_dir) = portal_test_data_dir();
    let env_path = crate::hub_manager::hub_env_path_for(&data_dir);
    std::fs::write(
        &env_path,
        format!(
            "{}CI_CLOUD_URL={}\n{PORTAL_URL_OVERRIDE_KEY}={OTHER_PORTAL}\n",
            portal_test_env_lines(),
            compiled_ci_cloud_url()
        ),
    )
    .expect("write env");
    ensure_runtime_env_state(&data_dir, &env_path).expect("launch");
    assert!(!read_desktop_log(&data_dir).contains("WARNING"));

    // Registered Hub whose previous value only differs by a trailing slash: same Portal.
    let (_registered_dir, data_dir) = portal_test_data_dir();
    std::fs::write(
        data_dir.join("state").join("settings.json"),
        r#"{"ciHubApiKey":"device-key"}"#,
    )
    .expect("write settings");
    let env_path = crate::hub_manager::hub_env_path_for(&data_dir);
    std::fs::write(
        &env_path,
        format!(
            "{}CI_CLOUD_URL={OTHER_PORTAL}/\n{PORTAL_URL_OVERRIDE_KEY}={OTHER_PORTAL}\n",
            portal_test_env_lines()
        ),
    )
    .expect("write env");
    ensure_runtime_env_state(&data_dir, &env_path).expect("launch");
    assert!(!read_desktop_log(&data_dir).contains("WARNING"));
}

#[test]
fn hub_registration_is_detected_from_device_key_or_tunnel_token() {
    let env = std::collections::HashMap::new();

    let (_empty, data_dir) = portal_test_data_dir();
    assert!(!hub_holds_portal_registration(&data_dir, &env));

    for unusable in [
        r#"{"ciHubApiKey":"   "}"#,
        r#"{"ciHubApiKey":null}"#,
        "not json",
    ] {
        std::fs::write(data_dir.join("state").join("settings.json"), unusable)
            .expect("write settings");
        assert!(
            !hub_holds_portal_registration(&data_dir, &env),
            "{unusable} is not a registration"
        );
    }

    std::fs::write(
        data_dir.join("state").join("settings.json"),
        r#"{"ciHubApiKey":"device-key"}"#,
    )
    .expect("write settings");
    assert!(hub_holds_portal_registration(&data_dir, &env));

    let (_tunnel, data_dir) = portal_test_data_dir();
    let token_path = crate::hub_manager::tunnel_token_path_for(&data_dir);
    std::fs::create_dir_all(token_path.parent().expect("tunnel dir")).expect("mkdir tunnel");
    std::fs::write(&token_path, b"tunnel-token").expect("write token");
    assert!(hub_holds_portal_registration(&data_dir, &env));
}
