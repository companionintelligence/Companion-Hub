//! Tests for the `runtime_env` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn private_vpn_requires_auth_key_or_state_and_ignores_legacy_enabled_false() {
    use crate::hub_manager::private_vpn_should_run;
    // Legacy PRIVATE_VPN_ENABLED=false must not force the sidecar on without credentials.
    assert!(!private_vpn_should_run(false, false));
    assert!(private_vpn_should_run(true, false));
    assert!(private_vpn_should_run(false, true));
    assert!(private_vpn_should_run(true, true));
}

#[test]
fn private_vpn_ignores_a_user_disabled_sentinel_an_earlier_render_wrote() {
    // Every desktop install carried this line, written by the render itself whenever the
    // sidecar had no credentials, so it never meant that anyone switched Private VPN off.
    let mut env = std::collections::HashMap::new();
    env.insert("PRIVATE_VPN_USER_DISABLED".into(), "true".into());
    env.insert("TAILSCALE_AUTHKEY".into(), "tskey-auth-test".into());
    assert!(private_vpn_enabled_from_map(&env));
}

#[test]
fn private_vpn_enabled_when_auth_key_present() {
    let mut env = std::collections::HashMap::new();
    env.insert("TAILSCALE_AUTHKEY".into(), "tskey-auth-test".into());
    assert!(crate::hub_manager::has_tailscale_auth_key(&env));
    assert!(private_vpn_enabled_from_map(&env));

    let mut legacy = std::collections::HashMap::new();
    legacy.insert("HEADSCALE_PREAUTH_KEY".into(), "tskey-auth-legacy".into());
    assert!(private_vpn_enabled_from_map(&legacy));
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
    // What CIM reports for a board whose firmware never set a UUID.
    assert!(!crate::hub_manager::is_usable_host_device_id(
        "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"
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
    "JWT_SECRET=jwt-test\nPOSTGRES_PASSWORD=postgres-test\nRABBITMQ_PASSWORD=rabbit-test\n"
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

/// Render with the compiled Portal, never the override file on the developer's own machine.
fn render_with_domain(data_dir: &std::path::Path, domain: Option<&str>) -> String {
    let mut existing = portal_test_env_map();
    if let Some(domain) = domain {
        existing.insert("DOMAIN".into(), domain.into());
    }
    render_runtime_env_content_for_portal(data_dir, &existing, &resolve_portal_url_at(None))
}

#[test]
fn runtime_env_keeps_the_domain_the_hub_learned_from_its_portal() {
    // The zone a Hub belongs to is decided by the Portal it paired with, not by this
    // build: `PairDevice` returns it and `setDomain` writes it into this same file.
    // Re-rendering must carry it forward, or the next app start silently moves the
    // Hub's own public origin back to a zone its Portal never provisioned.
    let (_tempdir, data_dir) = portal_test_data_dir();

    // Deliberately unlike every compiled default, so a pass cannot come from the build's own zone.
    let env = render_with_domain(&data_dir, Some("zone.example.test"));

    assert!(
        env.lines().any(|line| line == "DOMAIN=zone.example.test"),
        "expected the learned zone to survive a re-render: {env}"
    );
    assert!(
        read_desktop_log(&data_dir).contains("DOMAIN=zone.example.test"),
        "a stored zone winning over the build default must be visible in desktop.log"
    );
}

#[test]
fn runtime_env_strips_quotes_from_a_learned_domain() {
    // `parse_env_file` only trims, so a hand-edited or third-party-written entry can arrive
    // quoted. Carrying the quotes forward would bake them into every hostname the Hub composes.
    let (_tempdir, data_dir) = portal_test_data_dir();

    let env = render_with_domain(&data_dir, Some("\"zone.example.test\""));

    assert!(
        env.lines().any(|line| line == "DOMAIN=zone.example.test"),
        "expected the quotes to be stripped: {env}"
    );
}

#[test]
fn runtime_env_falls_back_to_the_build_domain_before_the_hub_has_paired() {
    // Before pairing there is nothing to preserve, so the build-time value is the right answer.
    let (_tempdir, data_dir) = portal_test_data_dir();

    let fresh = render_with_domain(&data_dir, None);

    assert!(
        fresh
            .lines()
            .any(|line| line == format!("DOMAIN={}", compiled_public_domain())),
        "expected the build default on a first render: {fresh}"
    );
    assert!(
        read_desktop_log(&data_dir).is_empty(),
        "rendering the build default is the unremarkable case and must not log"
    );
}

#[test]
fn runtime_env_refuses_to_carry_forward_a_value_that_is_not_a_zone() {
    // A blank entry is "nothing"; `example.com` and `ci.localhost` are the backend's
    // unprovisioned and local-dev sentinels. Preserving any of the three would pin the install
    // to "no public origin" with nothing left able to clear it.
    let (_tempdir, data_dir) = portal_test_data_dir();
    let expected = format!("DOMAIN={}", compiled_public_domain());

    for value in ["   ", "example.com", "EXAMPLE.COM", "ci.localhost"] {
        let env = render_with_domain(&data_dir, Some(value));
        assert!(
            env.lines().any(|line| line == expected),
            "{value:?} must not be carried forward as a zone: {env}"
        );
    }
}

// --- Private VPN lines of the runtime env (CI-Hub#1757) ---

/// Launch twice over an env file holding `extra_lines`, the way two app starts would, and return
/// the primary env file after each launch. Both env files must agree after every launch.
fn launch_twice_with(extra_lines: &str) -> (tempfile::TempDir, String, String) {
    let (tempdir, data_dir) = portal_test_data_dir();
    let [env_path, compat_path] = both_env_paths(&data_dir);
    std::fs::write(
        &env_path,
        format!("{}{extra_lines}", portal_test_env_lines()),
    )
    .expect("write env");

    let mut contents = Vec::new();
    for launch in ["first launch", "relaunch"] {
        ensure_runtime_env_state_for_portal(&data_dir, &env_path, &resolve_portal_url_at(None))
            .expect(launch);
        let content = std::fs::read_to_string(&env_path).expect("read env");
        assert_eq!(
            std::fs::read_to_string(&compat_path).expect("read compat env"),
            content,
            "{launch}: both env files must carry the same lines"
        );
        contents.push(content);
    }
    let relaunched = contents.pop().expect("relaunch");
    let first = contents.pop().expect("first launch");
    (tempdir, first, relaunched)
}

#[test]
fn runtime_env_without_a_tailscale_key_writes_no_private_vpn_opt_out() {
    // A fresh install has no key and no saved login. The render used to answer that with
    // PRIVATE_VPN_USER_DISABLED=true, which the backend then read as "leave Tailscale Serve
    // alone" and so never published a Private VPN app.
    let (_tempdir, data_dir) = portal_test_data_dir();

    let env = render_runtime_env_content_for_portal(
        &data_dir,
        &portal_test_env_map(),
        &resolve_portal_url_at(None),
    );

    assert!(!env.contains("PRIVATE_VPN_USER_DISABLED"), "{env}");
    assert!(!env.contains("TAILSCALE_AUTHKEY"), "{env}");
    // The profile alone keeps a sidecar without credentials from starting.
    assert!(!env.contains("private-vpn"), "{env}");
}

#[test]
fn runtime_env_drops_the_private_vpn_opt_out_an_earlier_launch_wrote() {
    let (_tempdir, first, relaunched) = launch_twice_with("PRIVATE_VPN_USER_DISABLED=true\n");

    for content in [&first, &relaunched] {
        assert!(!content.contains("PRIVATE_VPN_USER_DISABLED"), "{content}");
    }
}

#[test]
fn runtime_env_keeps_the_tailscale_auth_key_and_starts_the_sidecar_with_it() {
    // What a desktop install looks like once someone adds the documented key by hand: the opt-out
    // an earlier launch wrote is still there. The key used to be dropped by the next start.
    let (_tempdir, first, relaunched) =
        launch_twice_with("PRIVATE_VPN_USER_DISABLED=true\nTAILSCALE_AUTHKEY=tskey-auth-test\n");

    for content in [&first, &relaunched] {
        assert!(
            content
                .lines()
                .any(|line| line == "TAILSCALE_AUTHKEY=tskey-auth-test"),
            "{content}"
        );
        assert!(
            content.lines().any(|line| line
                .strip_prefix("COMPOSE_PROFILES=")
                .is_some_and(|profiles| profiles.split(',').any(|p| p == "private-vpn"))),
            "the key must turn the sidecar profile on: {content}"
        );
        assert!(!content.contains("PRIVATE_VPN_USER_DISABLED"), "{content}");
    }
}

#[test]
fn runtime_env_keeps_the_legacy_headscale_preauth_key() {
    let (_tempdir, _first, relaunched) =
        launch_twice_with("HEADSCALE_PREAUTH_KEY=tskey-auth-legacy\n");

    assert!(
        relaunched
            .lines()
            .any(|line| line == "HEADSCALE_PREAUTH_KEY=tskey-auth-legacy"),
        "{relaunched}"
    );
    assert!(
        relaunched
            .lines()
            .any(|line| line == "COMPOSE_PROFILES=private-vpn"),
        "{relaunched}"
    );
}

#[test]
fn runtime_env_keeps_an_operators_tailscale_serve_opt_out() {
    // The backend's only switch for "never write Tailscale Serve config". The render never writes
    // it, but must not drop one an operator set either.
    for value in ["true", "\"true\""] {
        let (_tempdir, _first, relaunched) =
            launch_twice_with(&format!("TAILSCALE_SERVE_USER_DISABLED={value}\n"));
        assert!(
            relaunched
                .lines()
                .any(|line| line == "TAILSCALE_SERVE_USER_DISABLED=true"),
            "{value}: {relaunched}"
        );
    }

    let (_tempdir, _first, relaunched) = launch_twice_with("TAILSCALE_SERVE_USER_DISABLED=false\n");
    assert!(
        !relaunched.contains("TAILSCALE_SERVE_USER_DISABLED"),
        "{relaunched}"
    );
}

// --- DEVICE_ID (Companion-Hub#1953) ---

/// The ID a Windows Hub paired with while `wmic` was still installed: its SMBIOS UUID.
const PAIRED_DEVICE_ID: &str = "0E7A1C42-5D3B-4F6A-9C21-7B3E8D4F1A60";
/// The registry `MachineGuid` an older launch wrote over it once `wmic` was gone.
const MACHINE_GUID: &str = "9b2f6e31-48c7-4d0a-b5e2-3c1f7a9d8e24";

fn rendered_device_id(rendered: &str) -> Option<&str> {
    rendered
        .lines()
        .find_map(|line| line.strip_prefix("DEVICE_ID="))
}

fn render_with_device_id(data_dir: &std::path::Path, device_id: Option<&str>) -> String {
    let mut existing = portal_test_env_map();
    if let Some(device_id) = device_id {
        existing.insert("DEVICE_ID".into(), device_id.into());
    }
    render_runtime_env_content_for_portal(data_dir, &existing, &resolve_portal_url_at(None))
}

/// Written by the backend when the Hub pairs (`registeredDeviceIdPath`).
fn write_registered_device_id(data_dir: &std::path::Path, device_id: &str) {
    std::fs::write(
        data_dir.join("state").join("registered-device-id"),
        format!("{device_id}\n"),
    )
    .expect("write registered-device-id");
}

/// Portal knows a Hub by the device ID it paired with, and the Hub's device key only works with
/// that ID. Every launch derived the ID again and wrote it over the one in the env file, so when
/// Windows removed `wmic` the ID became the MachineGuid and Portal refused the Hub.
#[test]
fn a_launch_keeps_the_device_id_in_the_env_file() {
    let (_tempdir, data_dir) = portal_test_data_dir();

    let rendered = render_with_device_id(&data_dir, Some(PAIRED_DEVICE_ID));

    assert_eq!(rendered_device_id(&rendered), Some(PAIRED_DEVICE_ID));
}

/// What the Hub registered as wins over the env file, so a launch also puts back an ID that an
/// older build already wrote over it, and the Hub's next start checks in as the paired device.
#[test]
fn a_launch_puts_the_registered_device_id_back_into_a_rewritten_env_file() {
    let (_tempdir, data_dir) = portal_test_data_dir();
    write_registered_device_id(&data_dir, PAIRED_DEVICE_ID);
    let env_path = crate::hub_manager::hub_env_path_for(&data_dir);
    std::fs::write(
        &env_path,
        format!("{}DEVICE_ID={MACHINE_GUID}\n", portal_test_env_lines()),
    )
    .expect("write env");

    let changed =
        ensure_runtime_env_state_for_portal(&data_dir, &env_path, &resolve_portal_url_at(None))
            .expect("launch");

    assert!(changed);
    let env = std::fs::read_to_string(&env_path).expect("read env");
    assert_eq!(rendered_device_id(&env), Some(PAIRED_DEVICE_ID), "{env}");
}

#[test]
fn a_hub_with_no_device_id_yet_derives_one_from_the_host() {
    let (_tempdir, data_dir) = portal_test_data_dir();

    let rendered = render_with_device_id(&data_dir, None);

    assert_eq!(
        rendered_device_id(&rendered),
        Some(crate::hub_manager::TEST_HOST_DEVICE_ID)
    );
}

#[test]
fn a_placeholder_device_id_is_derived_again() {
    let (_tempdir, data_dir) = portal_test_data_dir();

    for placeholder in ["FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF", "Not Specified", "0"] {
        let rendered = render_with_device_id(&data_dir, Some(placeholder));
        assert_eq!(
            rendered_device_id(&rendered),
            Some(crate::hub_manager::TEST_HOST_DEVICE_ID),
            "{placeholder}"
        );
    }
}

/// `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`, as Windows prints it.
fn machine_guid_output() -> String {
    format!(
        "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    {MACHINE_GUID}\r\n\r\n"
    )
}

/// Current Windows 11 builds no longer ship `wmic`. CIM still reports the SMBIOS UUID that
/// `wmic csproduct get uuid` printed, so a Hub set up on such a PC gets the ID that PC had before,
/// and Restore existing device still finds it.
#[test]
fn a_windows_pc_without_wmic_still_gives_its_smbios_uuid() {
    let pc_without_wmic = |program: &str, _args: &[&str]| match program {
        "powershell.exe" => Some(format!("{PAIRED_DEVICE_ID}\r\n")),
        "reg" => Some(machine_guid_output()),
        _ => None,
    };

    assert_eq!(
        crate::hub_manager::windows_host_device_id(pc_without_wmic),
        Some(PAIRED_DEVICE_ID.to_string())
    );
}

#[test]
fn a_windows_pc_without_a_firmware_uuid_falls_back_to_its_machine_guid() {
    for cim in [
        None,
        Some("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF\r\n".to_string()),
        Some("\r\n".to_string()),
    ] {
        let pc = |program: &str, _args: &[&str]| match program {
            "powershell.exe" => cim.clone(),
            "reg" => Some(machine_guid_output()),
            _ => None,
        };

        assert_eq!(
            crate::hub_manager::windows_host_device_id(pc),
            Some(MACHINE_GUID.to_string()),
            "{cim:?}"
        );
    }
}
