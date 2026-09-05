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
