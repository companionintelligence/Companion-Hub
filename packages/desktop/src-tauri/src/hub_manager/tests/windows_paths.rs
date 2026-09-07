//! Tests for the `windows_paths` module.

#[allow(unused_imports)]
use super::*;
#[allow(unused_imports)]
use crate::hub_manager::*;

#[test]
fn normalizes_windows_docker_bind_mount_paths_for_both_backends() {
    use crate::hub_manager::WindowsDockerHostStyle::{Drive, WslMnt};
    // One input list, both backends: every accepted form collapses to the
    // Docker Desktop `/c/...` form or the WSL2-engine `/mnt/c/...` form.
    // A single list (not one per style) so a new input form cannot be added
    // to one backend's coverage and forgotten in the other's.
    let inputs = [
        r"C:\Users\hegem\AppData\Roaming\companion-hub\media",
        "C:/Users/hegem/AppData/Roaming/companion-hub/media",
        "/c/Users/hegem/AppData/Roaming/companion-hub/media",
        "/mnt/c/Users/hegem/AppData/Roaming/companion-hub/media",
        r"\\?\C:\Users\hegem\AppData\Roaming\companion-hub\media",
    ];
    let expectations = [
        (Drive, "/c/Users/hegem/AppData/Roaming/companion-hub/media"),
        (
            WslMnt,
            "/mnt/c/Users/hegem/AppData/Roaming/companion-hub/media",
        ),
    ];
    for (style, expected) in expectations {
        for input in inputs {
            assert_eq!(
                crate::hub_manager::normalize_windows_docker_host_path(input, style),
                expected,
                "input {input:?} should normalize to the {style:?} form"
            );
        }
    }
}

#[test]
fn normalize_is_idempotent_and_passes_through_non_drive_paths() {
    use crate::hub_manager::WindowsDockerHostStyle::{Drive, WslMnt};
    // Idempotent: re-normalizing an already-correct value is a no-op.
    assert_eq!(
        crate::hub_manager::normalize_windows_docker_host_path("/c/Users/x", Drive),
        "/c/Users/x"
    );
    assert_eq!(
        crate::hub_manager::normalize_windows_docker_host_path("/mnt/c/Users/x", WslMnt),
        "/mnt/c/Users/x"
    );
    // Bare drive root.
    assert_eq!(
        crate::hub_manager::normalize_windows_docker_host_path(r"C:\", Drive),
        "/c"
    );
    assert_eq!(
        crate::hub_manager::normalize_windows_docker_host_path(r"C:\", WslMnt),
        "/mnt/c"
    );
    // Non-drive paths (unix socket, named pipe) are never rewritten.
    for style in [Drive, WslMnt] {
        assert_eq!(
            crate::hub_manager::normalize_windows_docker_host_path("/var/run/docker.sock", style),
            "/var/run/docker.sock"
        );
        assert_eq!(
            crate::hub_manager::normalize_windows_docker_host_path(
                r"\\.\pipe\docker_engine",
                style
            ),
            "//./pipe/docker_engine"
        );
    }
}

#[cfg(windows)]
#[test]
fn renders_windows_runtime_env_with_docker_safe_mount_paths() {
    let data_dir = PathBuf::from(r"C:\Users\hegem\AppData\Roaming\companion-hub");
    let mut existing = std::collections::HashMap::new();
    existing.insert(
        "ROOT_FOLDER_HOST".to_string(),
        r"C:\Users\hegem\AppData\Roaming\companion-hub".to_string(),
    );
    existing.insert("JWT_SECRET".to_string(), "jwt".to_string());
    existing.insert("POSTGRES_PASSWORD".to_string(), "postgres".to_string());

    let env = crate::hub_manager::render_runtime_env_content(&data_dir, &existing);

    // The drive prefix depends on the backend detected at runtime (`/c/...` for
    // Docker Desktop, `/mnt/c/...` for a native WSL2 engine), but every path in
    // one render must use the SAME style — a mixed-style .env breaks half the
    // mounts. Derive the single expected prefix from the same detection the
    // renderer uses and assert both keys exactly.
    let prefix = match crate::hub_manager::windows_docker_host_style() {
        crate::hub_manager::WindowsDockerHostStyle::Drive => "/c",
        crate::hub_manager::WindowsDockerHostStyle::WslMnt => "/mnt/c",
    };
    assert!(
        env.contains(&format!(
            "ROOT_FOLDER_HOST={prefix}/Users/hegem/AppData/Roaming/companion-hub\n"
        )),
        "env should normalize ROOT_FOLDER_HOST to the detected backend style ({prefix}): {env}"
    );
    assert!(
            env.contains(&format!(
                "COMPOSE_FILE_HOST={prefix}/Users/hegem/AppData/Roaming/companion-hub/docker-compose.prod.yml\n"
            )),
            "env should expose the compose file mount in the same backend style ({prefix}): {env}"
        );
    assert!(
        !env.contains(r"ROOT_FOLDER_HOST=C:\") && !env.contains(r"COMPOSE_FILE_HOST=C:\"),
        "env must not leak a raw Windows path: {env}"
    );
}

// Windows-only by design: the reverse mapping (host_path_from_docker_path) has a
// passthrough impl on other hosts, so the assertions only mean something where
// the real parser is compiled. Gating the #[test] itself (not an inner block)
// keeps non-Windows CI from reporting an empty always-green test.
#[cfg(windows)]
#[test]
fn detect_style_round_trips_through_host_path() {
    use crate::hub_manager::WindowsDockerHostStyle::{Drive, WslMnt};
    // A value normalized for either backend must map back to the same native
    // Windows path via host_path_from_docker_path (the reverse used for
    // desktop-side filesystem access) — including bare drive roots, whose
    // normalized forms have no trailing slash (`/c`, `/mnt/c`).
    for native in [r"C:\Users\hegem\AppData\Roaming\companion-hub", r"C:\"] {
        for style in [Drive, WslMnt] {
            let mount = crate::hub_manager::normalize_windows_docker_host_path(native, style);
            assert_eq!(
                crate::hub_manager::host_path_from_docker_path(&mount),
                std::path::PathBuf::from(native),
                "round-trip failed for {style:?} via {mount}"
            );
        }
    }
}
