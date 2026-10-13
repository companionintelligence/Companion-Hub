//! Unit tests for the hub_manager modules, grouped by module under test.
//! Shared fixtures stay here so every group can reach them via `use super::*`.

use super::*;

mod cli_install;
mod compose;
mod containers;
mod core;
mod docker_access;
mod docker_versions;
mod installers;
mod lifecycle;
mod logging;
mod markers;
mod misc;
mod runtime_env;
mod runtime_state;
mod status;
mod windows_paths;
mod wsl;

#[cfg(target_os = "linux")]
use super::current_docker_context_name;
#[cfg(any(test, target_os = "macos"))]
use super::docker_desktop_macos_install_script;
#[cfg(any(test, target_os = "windows"))]
use super::docker_desktop_windows_download_url;
#[cfg(any(test, target_os = "windows"))]
use super::docker_desktop_windows_install_script;
#[cfg(any(test, target_os = "windows"))]
use super::docker_desktop_windows_outer_launch_command;
#[cfg(unix)]
use super::host_container_uid_gid;
#[cfg(any(test, target_os = "linux"))]
use super::ollama_linux_install_script;
#[cfg(any(test, target_os = "macos"))]
use super::ollama_macos_install_script;
#[cfg(any(test, target_os = "windows"))]
use super::ollama_windows_install_script;
#[cfg(not(target_os = "windows"))]
use super::parse_docker_socket_uid_gid;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::preferred_unix_cli_install_dir;
#[cfg(any(test, target_os = "linux"))]
use super::rocm_linux_install_script;
#[cfg(any(target_os = "linux", target_os = "macos"))]
use super::unix_profile_for_shell;
#[cfg(any(test, target_os = "windows"))]
use super::wsl2_engine_elevated_script;
#[cfg(any(test, target_os = "windows"))]
use super::wsl2_engine_user_script;
use super::{
    append_desktop_log_for, classify_docker_access_result, clear_traefik_recreate_required,
    clear_tunnel_token, derive_optional_service_state, desktop_log_path_for, files_match,
    format_command_output, generate_container_docker_config, host_docker_socket_path,
    is_container_name_conflict, is_host_port_bind_conflict, is_oci_runtime_error,
    is_traefik_recreate_required, legacy_managed_app_container_ps_args, logs_open_target_for,
    managed_app_container_ps_args, mark_traefik_recreate_required, merge_compose_profiles,
    parse_container_ids, paths_match_by_components, prepare_traefik_runtime_state,
    private_vpn_enabled_from_map, seeded_traefik_config_contents,
    should_defer_docker_bind_mount_probe, startup_service_definitions, truncate_command_output,
    tunnel_dir_for, tunnel_token_path_for, tunnel_user_cleared_marker_path_for, DockerAccessState,
    ServiceState, MAX_COMMAND_OUTPUT_CHARS, TRAEFIK_ACME_FILE, TRAEFIK_CONFIG_FILE,
    TRAEFIK_DYNAMIC_CONFIG_SEED, TRAEFIK_DYNAMIC_FILE, TRAEFIK_TLS_DIR,
};
#[cfg(any(test, target_os = "macos"))]
use super::{colima_macos_binary_install_script, colima_macos_start_script};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// Write a `~/.docker/config.json` fixture into a temp directory and
/// return the `.docker` path for use as `host_docker_dir`.
fn write_docker_config_fixture(fixture: &str) -> (tempfile::TempDir, PathBuf) {
    let tmp_home = tempfile::tempdir().expect("create temp home");
    let docker_dir = tmp_home.path().join(".docker");
    std::fs::create_dir_all(&docker_dir).expect("create .docker dir");
    std::fs::write(docker_dir.join("config.json"), fixture).expect("write fixture");
    (tmp_home, docker_dir)
}
