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

/// Env map pointing `ROOT_FOLDER_HOST` at `data_dir`, optionally carrying `COMPOSE_PROFILES`.
fn tunnel_profile_env(
    data_dir: &std::path::Path,
    compose_profiles: Option<&str>,
) -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    env.insert(
        "ROOT_FOLDER_HOST".to_string(),
        data_dir.to_string_lossy().to_string(),
    );
    if let Some(profiles) = compose_profiles {
        env.insert("COMPOSE_PROFILES".to_string(), profiles.to_string());
    }
    env
}

fn write_tunnel_file(dir: &std::path::Path, name: &str, contents: &[u8]) {
    std::fs::create_dir_all(dir).expect("mkdir tunnel dir");
    std::fs::write(dir.join(name), contents).expect("write tunnel file");
}

const REGISTRATION_MARKER_JSON: &[u8] =
    br#"{"tunnelId":"tunnel-1","writtenAt":"2026-09-17T00:00:00.000Z"}"#;

fn has_cloudflare_profile(profiles: &str) -> bool {
    profiles.split(',').any(|p| p == "cloudflare")
}

#[test]
fn merge_compose_profiles_skips_cloudflare_for_token_without_registration_marker() {
    // A token left behind by an uninstalled or reset Hub must not connect this install to
    // the previous Hub's tunnel before it pairs.
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    write_tunnel_file(&tunnel_dir_for(&data_dir), "token", b"leftover-token");

    let profiles = merge_compose_profiles(&tunnel_profile_env(&data_dir, None), false);
    assert!(
        !has_cloudflare_profile(&profiles),
        "token alone must not enable cloudflare, got {profiles}"
    );
}

#[test]
fn merge_compose_profiles_drops_persisted_cloudflare_when_registration_marker_is_gone() {
    // The previous launch wrote COMPOSE_PROFILES with cloudflare; a reset since then removed
    // the marker but not the token.
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    write_tunnel_file(&tunnel_dir_for(&data_dir), "token", b"leftover-token");

    let profiles = merge_compose_profiles(
        &tunnel_profile_env(&data_dir, Some("gpu,cloudflare")),
        false,
    );
    assert_eq!(profiles, "gpu");
}

#[test]
fn merge_compose_profiles_skips_cloudflare_for_registration_marker_without_token() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    write_tunnel_file(
        &tunnel_dir_for(&data_dir),
        "registration.json",
        REGISTRATION_MARKER_JSON,
    );

    let profiles = merge_compose_profiles(&tunnel_profile_env(&data_dir, None), false);
    assert!(
        !has_cloudflare_profile(&profiles),
        "marker alone must not enable cloudflare, got {profiles}"
    );
}

#[test]
fn merge_compose_profiles_skips_cloudflare_for_empty_token_with_registration_marker() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    let tunnel_dir = tunnel_dir_for(&data_dir);
    write_tunnel_file(&tunnel_dir, "token", b"");
    write_tunnel_file(&tunnel_dir, "registration.json", REGISTRATION_MARKER_JSON);

    let profiles = merge_compose_profiles(&tunnel_profile_env(&data_dir, None), false);
    assert!(
        !has_cloudflare_profile(&profiles),
        "empty token must not enable cloudflare, got {profiles}"
    );
}

#[test]
fn merge_compose_profiles_adds_cloudflare_for_token_and_registration_marker() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    let tunnel_dir = tunnel_dir_for(&data_dir);
    write_tunnel_file(&tunnel_dir, "token", b"registered-token");
    write_tunnel_file(&tunnel_dir, "registration.json", REGISTRATION_MARKER_JSON);

    let profiles = merge_compose_profiles(&tunnel_profile_env(&data_dir, None), true);
    assert_eq!(profiles, "private-vpn,cloudflare");
}

#[test]
fn merge_compose_profiles_adds_cloudflare_for_registered_legacy_nested_tunnel() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    let legacy_dir = data_dir.join("tunnel");
    write_tunnel_file(&legacy_dir, "token", b"legacy-token");
    write_tunnel_file(&legacy_dir, "registration.json", REGISTRATION_MARKER_JSON);

    let profiles = merge_compose_profiles(&tunnel_profile_env(&data_dir, None), false);
    assert!(
        has_cloudflare_profile(&profiles),
        "expected cloudflare profile for registered legacy nested tunnel, got {profiles}"
    );
}

#[test]
fn merge_compose_profiles_skips_cloudflare_for_legacy_nested_token_without_marker() {
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    write_tunnel_file(&data_dir.join("tunnel"), "token", b"legacy-token");

    let profiles = merge_compose_profiles(&tunnel_profile_env(&data_dir, None), false);
    assert!(
        !has_cloudflare_profile(&profiles),
        "legacy token alone must not enable cloudflare, got {profiles}"
    );
}

#[test]
fn merge_compose_profiles_requires_token_and_marker_in_the_same_tunnel_dir() {
    // Token in the canonical sibling dir, marker only in the legacy nested dir (and the
    // reverse): neither dir describes a registered Hub on its own.
    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    write_tunnel_file(&tunnel_dir_for(&data_dir), "token", b"sibling-token");
    write_tunnel_file(
        &data_dir.join("tunnel"),
        "registration.json",
        REGISTRATION_MARKER_JSON,
    );
    let profiles = merge_compose_profiles(&tunnel_profile_env(&data_dir, None), false);
    assert!(
        !has_cloudflare_profile(&profiles),
        "split token/marker must not enable cloudflare, got {profiles}"
    );

    let tempdir = tempfile::tempdir().expect("tempdir");
    let data_dir = tempdir.path().join("hub");
    write_tunnel_file(&data_dir.join("tunnel"), "token", b"legacy-token");
    write_tunnel_file(
        &tunnel_dir_for(&data_dir),
        "registration.json",
        REGISTRATION_MARKER_JSON,
    );
    let profiles = merge_compose_profiles(&tunnel_profile_env(&data_dir, None), false);
    assert!(
        !has_cloudflare_profile(&profiles),
        "split marker/token must not enable cloudflare, got {profiles}"
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

// --- Portal URL override (desktop config file) ---

use crate::portal_url::{compiled_ci_cloud_url, resolve_portal_url_at, PortalUrlResolution};

/// Differs from every compiled default, so a pass cannot come from the build's own Portal.
const OTHER_PORTAL: &str = "https://portal.example.test";

/// An env file key that must never choose the Portal: the backend can write the primary env file.
const ENV_FILE_OVERRIDE_KEY: &str = "CI_HUB_CLOUD_URL_OVERRIDE";

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

/// An override file beside the data dir, standing in for the one in the desktop config dir.
fn override_path_beside(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir
        .parent()
        .expect("temp parent")
        .join("portal-url-override")
}

/// Write `content` to the override file and resolve it the way a launch resolves the real one.
fn portal_from_override_file(
    data_dir: &std::path::Path,
    content: &str,
) -> (std::path::PathBuf, PortalUrlResolution) {
    let path = override_path_beside(data_dir);
    std::fs::write(&path, content).expect("write override");
    let portal = resolve_portal_url_at(Some(&path));
    (path, portal)
}

/// Env content without the lines derived from `DOCKER_HOST`. Another test sets that variable for
/// the whole process while it runs, so a byte comparison of two renders would race it.
fn without_docker_host_lines(content: &str) -> String {
    content
        .lines()
        .filter(|line| !line.starts_with("DOCKER_SOCKET_PATH=") && !line.starts_with("DOCKER_GID="))
        .map(|line| format!("{line}\n"))
        .collect()
}

#[test]
fn runtime_env_without_portal_override_uses_the_compiled_portal() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let env = render_runtime_env_content(&data_dir, &portal_test_env_map());
    assert!(
        env.contains(&format!("CI_CLOUD_URL={}\n", compiled_ci_cloud_url())),
        "expected the compiled Portal: {env}"
    );

    // A missing override file renders exactly what a launch without the lookup renders.
    let with_missing_file = render_runtime_env_content_for_portal(
        &data_dir,
        &portal_test_env_map(),
        &resolve_portal_url_at(Some(&override_path_beside(&data_dir))),
    );
    assert_eq!(
        without_docker_host_lines(&with_missing_file),
        without_docker_host_lines(&env)
    );
    assert!(read_desktop_log(&data_dir).is_empty());
}

#[test]
fn portal_override_changes_only_the_cloud_url_line_of_the_runtime_env() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let without = render_runtime_env_content_for_portal(
        &data_dir,
        &portal_test_env_map(),
        &resolve_portal_url_at(None),
    );
    let (_path, portal) = portal_from_override_file(&data_dir, &format!("{OTHER_PORTAL}/\n"));
    let rendered =
        render_runtime_env_content_for_portal(&data_dir, &portal_test_env_map(), &portal);

    let cloud_line = format!("CI_CLOUD_URL={OTHER_PORTAL}\n");
    assert!(rendered.contains(&cloud_line), "{rendered}");
    assert!(
        !rendered.contains(ENV_FILE_OVERRIDE_KEY) && !rendered.contains("portal-url-override"),
        "only the resolved CI_CLOUD_URL may reach the env file: {rendered}"
    );

    // Put the compiled Portal back, and the file must match a render without the override.
    let reverted = rendered.replace(
        &cloud_line,
        &format!("CI_CLOUD_URL={}\n", compiled_ci_cloud_url()),
    );
    assert_eq!(
        without_docker_host_lines(&reverted),
        without_docker_host_lines(&without)
    );
}

#[test]
fn an_override_planted_in_the_env_files_does_not_choose_the_portal() {
    // The primary env file is mounted into ci-hub as /data/.env and the backend writes to it,
    // so neither an override key nor a CI_CLOUD_URL written there may survive a launch.
    let (_tempdir, data_dir) = portal_test_data_dir();
    let [env_path, compat_path] = both_env_paths(&data_dir);
    for path in [&env_path, &compat_path] {
        std::fs::write(
            path,
            format!(
                "{}CI_CLOUD_URL={OTHER_PORTAL}\n{ENV_FILE_OVERRIDE_KEY}={OTHER_PORTAL}\n",
                portal_test_env_lines()
            ),
        )
        .expect("write env");
    }

    ensure_runtime_env_state(&data_dir, &env_path).expect("launch");

    for path in [&env_path, &compat_path] {
        let content = std::fs::read_to_string(path).expect("read env");
        assert!(
            content.contains(&format!("CI_CLOUD_URL={}\n", compiled_ci_cloud_url())),
            "{}: {content}",
            path.display()
        );
        assert!(
            !content.contains(ENV_FILE_OVERRIDE_KEY) && !content.contains(OTHER_PORTAL),
            "{}: {content}",
            path.display()
        );
    }
    assert!(read_desktop_log(&data_dir).is_empty());
}

#[test]
fn portal_override_is_written_to_both_env_files_and_survives_relaunch() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let [env_path, compat_path] = both_env_paths(&data_dir);
    std::fs::write(
        &env_path,
        format!(
            "{}CI_CLOUD_URL={}\n",
            portal_test_env_lines(),
            compiled_ci_cloud_url()
        ),
    )
    .expect("write env");
    let (path, portal) = portal_from_override_file(&data_dir, &format!("{OTHER_PORTAL}\n"));

    assert!(
        ensure_runtime_env_state_for_portal(&data_dir, &env_path, &portal).expect("first launch")
    );
    let after_first_launch = std::fs::read_to_string(&env_path).expect("read env");
    // The second launch is the one that used to put the compiled Portal back.
    ensure_runtime_env_state_for_portal(&data_dir, &env_path, &resolve_portal_url_at(Some(&path)))
        .expect("relaunch");

    for env_file in [&env_path, &compat_path] {
        let content = std::fs::read_to_string(env_file).expect("read env");
        assert!(
            content.contains(&format!("CI_CLOUD_URL={OTHER_PORTAL}\n")),
            "{}: {content}",
            env_file.display()
        );
        assert!(!content.contains(ENV_FILE_OVERRIDE_KEY), "{content}");
    }
    assert_eq!(
        without_docker_host_lines(&std::fs::read_to_string(&env_path).expect("read env")),
        without_docker_host_lines(&after_first_launch),
        "a relaunch with the same override must not change the env file"
    );
    let log = read_desktop_log(&data_dir);
    let active = format!(
        "Portal URL override active: CI_CLOUD_URL={OTHER_PORTAL} from {}",
        path.display()
    );
    assert_eq!(log.matches(&active).count(), 2, "{log}");
}

#[test]
fn removing_the_portal_override_file_restores_the_compiled_portal() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let [env_path, compat_path] = both_env_paths(&data_dir);
    std::fs::write(&env_path, portal_test_env_lines()).expect("write env");
    let (path, portal) = portal_from_override_file(&data_dir, OTHER_PORTAL);
    ensure_runtime_env_state_for_portal(&data_dir, &env_path, &portal)
        .expect("launch with override");
    assert!(std::fs::read_to_string(&env_path)
        .expect("read env")
        .contains(&format!("CI_CLOUD_URL={OTHER_PORTAL}\n")));

    std::fs::remove_file(&path).expect("remove override");
    ensure_runtime_env_state_for_portal(&data_dir, &env_path, &resolve_portal_url_at(Some(&path)))
        .expect("launch without override");

    for env_file in [&env_path, &compat_path] {
        let content = std::fs::read_to_string(env_file).expect("read env");
        assert!(
            content.contains(&format!("CI_CLOUD_URL={}\n", compiled_ci_cloud_url())),
            "{}: {content}",
            env_file.display()
        );
        assert!(!content.contains(OTHER_PORTAL), "{content}");
    }
}

#[test]
fn an_invalid_portal_override_keeps_the_compiled_portal_and_logs_why() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let [env_path, compat_path] = both_env_paths(&data_dir);
    std::fs::write(&env_path, portal_test_env_lines()).expect("write env");
    let (path, portal) = portal_from_override_file(&data_dir, "http://portal.example.test\n");

    ensure_runtime_env_state_for_portal(&data_dir, &env_path, &portal).expect("launch");

    for env_file in [&env_path, &compat_path] {
        let content = std::fs::read_to_string(env_file).expect("read env");
        assert!(
            content.contains(&format!("CI_CLOUD_URL={}\n", compiled_ci_cloud_url())),
            "{content}"
        );
        assert!(!content.contains("portal.example.test"), "{content}");
    }
    assert_eq!(
        std::fs::read_to_string(&path).expect("read override"),
        "http://portal.example.test\n",
        "the refused value stays in the file so it can be corrected"
    );
    let log = read_desktop_log(&data_dir);
    assert!(
        log.contains(&format!(
            "Ignoring the Portal URL override in {}",
            path.display()
        )) && log.contains("must use https"),
        "{log}"
    );
    assert!(!log.contains("override active"), "{log}");
}

#[test]
fn the_tray_opens_the_cloud_url_the_stack_was_started_with() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    let env_path = crate::hub_manager::hub_env_path_for(&data_dir);
    assert_eq!(
        portal_url_from_env_file(&env_path),
        compiled_ci_cloud_url(),
        "before any launch there is no env file"
    );

    std::fs::write(&env_path, format!("CI_CLOUD_URL=\"{OTHER_PORTAL}\"\n")).expect("write env");
    assert_eq!(portal_url_from_env_file(&env_path), OTHER_PORTAL);

    std::fs::write(&env_path, "CI_CLOUD_URL=file:///etc/passwd\n").expect("write env");
    assert_eq!(
        portal_url_from_env_file(&env_path),
        compiled_ci_cloud_url(),
        "only http(s) URLs reach the system opener"
    );
}
