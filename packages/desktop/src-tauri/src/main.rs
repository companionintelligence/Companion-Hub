// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod discovery;
pub mod docker_engine;
mod error_reporting;
pub mod hub_env;
pub mod hub_manager;
pub mod port_manager;
mod sentry_scrubber;
mod tray;
mod updater;

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_store::StoreExt;

const DETACHED_FLAG: &str = "--detached";
const STACK_DEV_ENV: &str = "CI_HUB_STACK_DEV";
const STACK_DEV_COMPOSE_PATH_ENV: &str = "CI_HUB_STACK_DEV_COMPOSE_PATH";
const STACK_DEV_ENV_PATH_ENV: &str = "CI_HUB_STACK_DEV_ENV_PATH";
const HUB_STATUS_CHECK_TIMEOUT: Duration = Duration::from_millis(2500);

struct PendingPairingCode(Mutex<Option<String>>);
struct PendingPortalAuth(Mutex<Option<DesktopPortalAuthPayload>>);
struct PendingInstallIntent(Mutex<Option<DesktopInstallIntentPayload>>);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopPortalAuthPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DesktopInstallIntentPayload {
    app_slug: String,
    #[serde(default = "default_install_store_id")]
    store_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    device_id: Option<String>,
}

fn default_install_store_id() -> String {
    "ci-marketplace".to_string()
}

fn stack_dev_mode_enabled() -> bool {
    std::env::var(STACK_DEV_ENV)
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn non_empty_path_env(var_name: &str) -> Option<PathBuf> {
    std::env::var(var_name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn stack_dev_override_paths() -> Result<Option<(PathBuf, PathBuf)>, String> {
    if !stack_dev_mode_enabled() {
        return Ok(None);
    }

    let compose_path = non_empty_path_env(STACK_DEV_COMPOSE_PATH_ENV)
        .ok_or_else(|| format!("{} is not set.", STACK_DEV_COMPOSE_PATH_ENV))?;
    let env_path = non_empty_path_env(STACK_DEV_ENV_PATH_ENV)
        .ok_or_else(|| format!("{} is not set.", STACK_DEV_ENV_PATH_ENV))?;

    if !compose_path.exists() {
        return Err(format!(
            "stack-dev compose file does not exist: {}",
            compose_path.display()
        ));
    }
    if !env_path.exists() {
        return Err(format!(
            "stack-dev env file does not exist: {}",
            env_path.display()
        ));
    }

    Ok(Some((compose_path, env_path)))
}

/// Check if the Hub backend is reachable at the given URL.
#[tauri::command]
async fn check_hub_status(url: String) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(HUB_STATUS_CHECK_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;

    match client.get(format!("{}/api/health/live", url)).send().await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

/// Discover Hub instances on the local network via mDNS.
#[tauri::command]
async fn discover_hubs() -> Result<Vec<String>, String> {
    discovery::find_hubs().await.map_err(|e| e.to_string())
}

/// Start the Hub via docker compose.
#[tauri::command]
async fn start_hub_command(
    state: tauri::State<'_, hub_manager::HubPaths>,
) -> Result<String, String> {
    let compose = state.compose_path.clone();
    let env = state.env_path.clone();
    let data = state.data_dir.clone();
    tokio::task::spawn_blocking(move || hub_manager::start_hub(&compose, &env, &data))
        .await
        .map_err(|e| {
            if e.is_panic() {
                format!("start_hub task panicked: {}", e)
            } else {
                format!("start_hub task was cancelled: {}", e)
            }
        })?
}

#[tauri::command]
fn is_stack_dev_mode_command() -> bool {
    stack_dev_mode_enabled()
}

/// Check if Docker is available on this machine.
#[tauri::command]
async fn check_docker_available() -> Result<bool, String> {
    Ok(hub_manager::is_docker_available())
}

/// Return richer Docker access diagnostics for post-install handling.
#[tauri::command]
async fn check_docker_access_command() -> Result<hub_manager::DockerAccessCheck, String> {
    Ok(hub_manager::check_docker_access())
}

/// Install Docker using the platform-native bootstrap flow.
#[tauri::command]
async fn install_docker_command() -> Result<hub_manager::DockerInstallResult, String> {
    hub_manager::install_docker()
}

/// Install Ollama using the platform-native bootstrap flow.
#[tauri::command]
async fn install_ollama_command() -> Result<hub_manager::OllamaInstallResult, String> {
    // Run on the blocking pool: on a WSL2 engine this shells out to an unbounded
    // in-distro `apt`/Ollama install, which must not pin an async-runtime worker.
    tokio::task::spawn_blocking(hub_manager::install_ollama)
        .await
        .map_err(|e| format!("Ollama install task failed: {e}"))?
}

/// Install ROCm on Ubuntu via pkexec-elevated AMDGPU installer.
#[tauri::command]
async fn install_rocm_command() -> Result<hub_manager::RocmInstallResult, String> {
    tokio::task::spawn_blocking(hub_manager::install_rocm)
        .await
        .map_err(|e| format!("ROCm install task failed: {e}"))?
}

/// Re-probe host ROCm after reboot and refresh probe caches.
#[tauri::command]
async fn verify_rocm_command() -> Result<hub_manager::RocmInstallResult, String> {
    tokio::task::spawn_blocking(hub_manager::verify_rocm_probe)
        .await
        .map_err(|e| format!("ROCm verify task failed: {e}"))?
}

/// Install a licensing-free Docker engine (Colima on macOS, Engine-in-WSL2 on
/// Windows, the standard Engine on Linux).
#[tauri::command]
async fn install_docker_engine_alternative_command(
) -> Result<hub_manager::DockerInstallResult, String> {
    // The install can run for several minutes (first run downloads a VM image),
    // so keep it off the async runtime to avoid starving status polling.
    tokio::task::spawn_blocking(hub_manager::install_docker_engine_alternative)
        .await
        .map_err(|e| {
            if e.is_panic() {
                format!("Docker engine install task panicked: {e}")
            } else {
                format!("Docker engine install task was cancelled: {e}")
            }
        })?
}

/// Local Hub UI/API origin for the desktop bootstrap (respects API_PORT in .env).
#[tauri::command]
fn get_hub_api_url_command(state: tauri::State<'_, hub_manager::HubPaths>) -> String {
    let port = port_manager::read_api_port(&state.env_path);
    format!("http://127.0.0.1:{port}")
}

/// Get the current Hub status (Docker availability, container state, health).
#[tauri::command]
async fn get_hub_status_command() -> hub_manager::HubStatus {
    tokio::task::spawn_blocking(hub_manager::get_hub_status)
        .await
        .unwrap_or_else(|err| panic!("hub status task failed: {err}"))
}

/// Get per-service startup progress for the frontend loading screen.
#[tauri::command]
async fn get_startup_progress_command() -> hub_manager::StartupProgress {
    tokio::task::spawn_blocking(hub_manager::get_startup_progress)
        .await
        .unwrap_or_else(|err| panic!("startup progress task failed: {err}"))
}

/// Read recent desktop log lines for in-app diagnostics (last 200 lines).
#[tauri::command]
async fn read_desktop_logs_command() -> String {
    hub_manager::read_desktop_logs(200)
}

/// Validate that `path` is an absolute, existing directory we can open in the
/// OS file explorer. Returns a human-readable error string (surfaced to the user
/// as a toast) otherwise. Pure and side-effect free so it can be unit tested.
fn validate_open_path(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty() {
        return Err("Path is empty".to_string());
    }
    if !path.is_absolute() {
        return Err(format!("Path is not absolute: {}", path.display()));
    }
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(format!("Path is not a directory: {}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("Path does not exist: {}", path.display()))
        }
        // Other errors (permission denied, invalid path, ...) — report accurately
        // rather than claiming the path is missing.
        Err(err) => Err(format!("Cannot access path: {} ({err})", path.display())),
    }
}

/// Shared logic behind every "open folder" button: optionally create the
/// directory, validate it, log the attempt to desktop.log, then reveal it in the
/// OS default file explorer. The single open/log/validate code path so the logs,
/// per-app data, and root app-data buttons all behave identically.
///
/// `create_if_missing` is `true` for the logs folder (preserving its prior
/// behavior) and `false` for data folders, so a wrong or remote path surfaces as
/// an error instead of silently creating a stray directory.
fn open_directory(
    app: &tauri::AppHandle,
    path: &Path,
    create_if_missing: bool,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    if create_if_missing {
        let _ = std::fs::create_dir_all(path);
    }

    let data_dir = hub_manager::get_hub_data_dir();
    if let Err(err) = validate_open_path(path) {
        let _ = hub_manager::append_desktop_log_for(
            &data_dir,
            "open_folder",
            &format!("refused to open {}: {err}", path.display()),
        );
        return Err(err);
    }

    let _ = hub_manager::append_desktop_log_for(
        &data_dir,
        "open_folder",
        &format!("opening {}", path.display()),
    );

    // Reveal in the OS file manager (Finder / Explorer / Nautilus). `open_path`
    // goes through xdg-open / `open`, which on Linux often fails for directories
    // even when they exist — that produced the "folder may not exist" toast.
    if let Err(reveal_err) = app.opener().reveal_item_in_dir(path) {
        let _ = hub_manager::append_desktop_log_for(
            &data_dir,
            "open_folder",
            &format!(
                "reveal_item_in_dir failed for {}: {reveal_err}; falling back to open_path",
                path.display()
            ),
        );
        app.opener()
            .open_path(path.to_string_lossy().to_string(), None::<&str>)
            .map_err(|err| {
                let message = err.to_string();
                let _ = hub_manager::append_desktop_log_for(
                    &data_dir,
                    "open_folder",
                    &format!("failed to open {}: {message}", path.display()),
                );
                message
            })
    } else {
        Ok(())
    }
}

/// Open the desktop logs directory in the system file manager.
#[tauri::command]
async fn open_logs_dir_command(app: tauri::AppHandle) -> Result<(), String> {
    let logs_dir = hub_manager::logs_open_target();
    open_directory(&app, &logs_dir, true)
}

/// Open an absolute host directory in the OS default file explorer. The path is
/// resolved by the backend (an app's data folder or the root app-data folder)
/// and passed through here. The desktop app and the data must be on the same
/// machine; a missing path returns an error so the UI can show a toast.
#[tauri::command]
async fn open_path_command(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // The backend resolves host paths from ROOT_FOLDER_HOST, which on Windows is
    // stored in Docker bind-mount format (e.g. `/c/Users/...`). Convert it back
    // to a native host path (`C:\Users\...`) so the OS file explorer can open it;
    // otherwise `validate_open_path` rejects it as non-absolute. No-op on POSIX hosts.
    let native = hub_manager::host_path_from_docker_path(&path);
    open_directory(&app, &native, false)
}

#[tauri::command]
async fn save_download_command(filename: String, contents: Vec<u8>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let target = unique_download_path(&filename)?;
        std::fs::write(&target, contents)
            .map_err(|error| format!("Failed to write download {}: {error}", target.display()))?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|error| format!("Save download task failed: {error}"))?
}

/// Returns `true` if the user intentionally stopped the Hub on last use.
#[tauri::command]
async fn is_user_stopped_command() -> bool {
    hub_manager::is_user_stopped(&hub_manager::get_hub_data_dir())
}

/// Returns a pairing code from a deep link that arrived before the UI was ready.
#[tauri::command]
fn consume_pending_pairing_code(state: tauri::State<'_, PendingPairingCode>) -> Option<String> {
    state.0.lock().ok()?.take()
}

#[tauri::command]
fn consume_pending_portal_auth(
    state: tauri::State<'_, PendingPortalAuth>,
) -> Option<DesktopPortalAuthPayload> {
    state.0.lock().ok()?.take()
}

/// Returns a store install intent from a deep link that arrived before the UI was ready.
#[tauri::command]
fn consume_pending_install_intent(
    state: tauri::State<'_, PendingInstallIntent>,
) -> Option<DesktopInstallIntentPayload> {
    state.0.lock().ok()?.take()
}

#[tauri::command]
async fn check_desktop_update_command() -> Result<updater::DesktopUpdateInfo, String> {
    let current = option_env!("CI_HUB_BUILD_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .trim_start_matches('v')
        .to_string();
    tokio::task::spawn_blocking(move || updater::check_desktop_update(&current))
        .await
        .map_err(|e| format!("Update check task failed: {}", e))?
}

#[tauri::command]
fn get_desktop_release_version_command() -> String {
    option_env!("CI_HUB_BUILD_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .trim_start_matches('v')
        .to_string()
}

#[tauri::command]
async fn perform_desktop_update_command(download_url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let current = option_env!("CI_HUB_BUILD_VERSION")
            .unwrap_or(env!("CARGO_PKG_VERSION"))
            .trim_start_matches('v')
            .to_string();
        let info = updater::check_desktop_update(&current)?;
        let url = if download_url.trim().is_empty() {
            info.download_url.clone()
        } else {
            download_url
        };
        if url.is_empty() {
            return Err("No download URL available for this platform".to_string());
        }
        if !updater::is_trusted_download_url(&url) {
            return Err("Untrusted download URL".to_string());
        }
        let (expected_size, expected_sha256) =
            updater::artifact_expectations_for_url(&info.latest_version, &info, &url)?;
        updater::perform_host_update(&url, expected_size, expected_sha256.as_deref())
    })
    .await
    .map_err(|e| format!("Update task failed: {}", e))?
}

#[tauri::command]
async fn get_update_progress_command() -> Option<updater::UpdateProgress> {
    updater::get_update_progress()
}

#[tauri::command]
async fn trigger_host_update_command() -> Result<String, String> {
    tokio::task::spawn_blocking(updater::trigger_host_update_via_listener)
        .await
        .map_err(|e| format!("Update trigger failed: {}", e))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before WebView2 is created, drop a disk cache left corrupt by the previous
    // version's update-time force-kill (surfaces as ERR_CACHE_READ_FAILURE / blank
    // window on Windows). Runs at most once per version; no-op off Windows.
    hub_manager::clear_stale_webview_cache_on_version_change(
        option_env!("CI_HUB_BUILD_VERSION")
            .unwrap_or(env!("CARGO_PKG_VERSION"))
            .trim_start_matches('v'),
    );

    let builder = tauri::Builder::default()
        .manage(PendingPairingCode(Mutex::new(None)))
        .manage(PendingPortalAuth(Mutex::new(None)))
        .manage(PendingInstallIntent(Mutex::new(None)))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A freshly-updated instance signals us (the old binary, still running)
            // to restart so the new binary on disk takes over.
            if args.iter().any(|a| a == updater::RELAUNCH_AFTER_UPDATE_FLAG)
                && updater::prepare_self_restart_for_update().is_ok()
            {
                app.exit(0);
                return;
            }
            focus_main_window(app);
            for arg in &args {
                handle_deep_link_url(app, arg);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            check_hub_status,
            discover_hubs,
            start_hub_command,
            is_stack_dev_mode_command,
            check_docker_available,
            check_docker_access_command,
            get_hub_api_url_command,
            get_hub_status_command,
            get_startup_progress_command,
            read_desktop_logs_command,
            open_logs_dir_command,
            open_path_command,
            save_download_command,
            is_user_stopped_command,
            install_docker_command,
            install_ollama_command,
            install_rocm_command,
            verify_rocm_command,
            install_docker_engine_alternative_command,
            consume_pending_pairing_code,
            consume_pending_portal_auth,
            consume_pending_install_intent,
            check_desktop_update_command,
            get_desktop_release_version_command,
            perform_desktop_update_command,
            get_update_progress_command,
            trigger_host_update_command,
            commands::dns::flush_dns_cache,
        ])
        .setup(|app| {
            // Restore saved window geometry
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| {
                    let message = "main window not found".to_string();
                    error_reporting::capture_setup_failure(&message);
                    message
                })?;

            // macOS: config has decorations:true + titleBarStyle:Overlay which gives
            // native traffic lights over the WebView content. Perfect.
            //
            // Windows/Linux: titleBarStyle:Overlay is macOS-only, and native decorations
            // look wrong with our custom titlebar. Turn decorations off at runtime so
            // the custom HTML titlebar takes over.
            #[cfg(not(target_os = "macos"))]
            {
                let _ = window.set_decorations(false);
            }

            // Devtools available via right-click → Inspect Element in debug builds
            // but don't auto-open (blocks app interaction on macOS)
            // #[cfg(debug_assertions)]
            // window.open_devtools();

            if let Ok(store) = app.store("settings.json") {
                // Geometry is persisted on window close and on tray Quit (see
                // tray.rs). When nothing is saved yet the window keeps the
                // configured default (1280x800, centered) — never maximized.
                if let Some(x) = store
                    .get("window_x")
                    .and_then(|v: serde_json::Value| v.as_f64())
                {
                    if let Some(y) = store
                        .get("window_y")
                        .and_then(|v: serde_json::Value| v.as_f64())
                    {
                        let _ =
                            window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                    }
                }
                if let Some(w) = store
                    .get("window_width")
                    .and_then(|v: serde_json::Value| v.as_f64())
                {
                    if let Some(h) = store
                        .get("window_height")
                        .and_then(|v: serde_json::Value| v.as_f64())
                    {
                        let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                    }
                }
            }

            // Build system tray (also registers close-to-hide handler)
            tray::create_tray(app)?;

            // Initialize Hub data directory and compose file
            let resource_dir = app.path().resource_dir().map_err(|e| format!("{}", e))?;
            let initialization = hub_manager::initialize_hub(&resource_dir).map_err(|error| {
                error_reporting::capture_setup_failure(&error);
                error
            })?;
            let data_dir = initialization.data_dir.clone();
            hub_manager::persist_launch_mode(
                &data_dir,
                hub_manager::PersistedLaunchMode::Desktop,
            );
            let mut compose_path = initialization.compose_path.clone();
            let mut env_path = initialization.env_path.clone();
            if let Some((stack_dev_compose, stack_dev_env)) = stack_dev_override_paths()
                .map_err(|error| format!("Invalid stack-dev launch configuration: {}", error))?
            {
                compose_path = stack_dev_compose;
                env_path = stack_dev_env;
            }
            error_reporting::init_from_env(
                &env_path,
                &data_dir,
                option_env!("CI_HUB_BUILD_VERSION").unwrap_or("0.0.0"),
            );
            let traefik_preflight = initialization.traefik_preflight;
            let _ = hub_manager::append_desktop_log_for(
                &data_dir,
                "setup",
                &format!(
                    "Desktop setup completed. compose={} env={} traefik_changed={} traefik_repaired_conflicts={}",
                    compose_path.display(),
                    env_path.display(),
                    traefik_preflight.changed,
                    traefik_preflight.repaired_conflicting_paths,
                ),
            );

            // Store paths in app state for tray and commands to use
            app.manage(hub_manager::HubPaths {
                data_dir: data_dir.clone(),
                compose_path: compose_path.clone(),
                env_path: env_path.clone(),
            });

            if stack_dev_mode_enabled() {
                // Stack was started externally (e.g. `cihub up dev`); still refresh host
                // metrics so the dashboard shows physical disk/RAM, not the Docker VM.
                hub_manager::refresh_host_hardware_probe_cache(&data_dir);
                if let Some(stack_data_dir) = hub_manager::host_data_dir_from_env_path(&env_path) {
                    if stack_data_dir != data_dir {
                        hub_manager::refresh_host_hardware_probe_cache(&stack_data_dir);
                        let _ = hub_manager::append_desktop_log_for(
                            &data_dir,
                            "hw.probe",
                            &format!(
                                "stack-dev host hardware probes refreshed for mounted data root {}",
                                stack_data_dir.display()
                            ),
                        );
                    }
                }
                let _ = hub_manager::append_desktop_log_for(
                    &data_dir,
                    "setup",
                    &format!(
                        "stack-dev mode active: attaching to externally managed stack (compose={} env={}) and skipping reconciliation.",
                        compose_path.display(),
                        env_path.display()
                    ),
                );
                return Ok(());
            }

            // Start the host update listener (0.0.0.0:17400) in desktop mode too,
            // not just headless/detached. The Hub backend hands its token to
            // authenticated browser/in-container Settings UIs, which POST to this
            // listener to trigger a host update that controls the stack and repulls
            // container images (see docs/DESKTOP-AUTO-UPDATE.md). Without this, that
            // documented trigger path is dead whenever the Hub runs via the desktop
            // app, and the backend never sees a listener token to hand out. The
            // listener binds a fixed port, so a duplicate/leftover instance simply
            // fails to bind and exits — spawning here is idempotent.
            updater::spawn_update_listener_daemon();

            // Defer Docker probing and auto-start reconciliation until after setup returns
            // so the main window can appear quickly. These checks can take noticeable
            // time on cold desktop launches, especially while Docker Desktop or the
            // engine is still waking up.
            {
                let compose = compose_path.clone();
                let env = env_path.clone();
                let data = data_dir.clone();
                tauri::async_runtime::spawn(async move {
                    let compose_for_decision = compose.clone();
                    let env_for_decision = env.clone();
                    let data_for_decision = data.clone();

                    let decision = tokio::task::spawn_blocking(move || {
                        if !hub_manager::is_docker_available() {
                            return Ok::<_, String>(None);
                        }

                        let config_hash =
                            hub_manager::compute_config_hash(&compose_for_decision, &env_for_decision);
                        let hash_path = data_for_decision.join(".config-hash");
                        let saved_hash = std::fs::read_to_string(&hash_path).ok();
                        let containers_exist = hub_manager::hub_containers_exist();
                        let traefik_recreate_required = traefik_preflight.changed
                            || hub_manager::is_traefik_recreate_required(&data_for_decision);
                        // Respect the user's explicit decision to stop the Hub: if they clicked
                        // "Stop Hub" last time, don't auto-restart on the next launch until they
                        // explicitly click "Start Hub" again.
                        let user_stopped = hub_manager::is_user_stopped(&data_for_decision);
                        let start_failed = hub_manager::is_start_failed(&data_for_decision);
                        let needs_runtime_recovery = hub_manager::hub_needs_runtime_recovery();

                        let should_start = if user_stopped || start_failed {
                            false
                        } else if !containers_exist {
                            true
                        } else if needs_runtime_recovery {
                            true
                        } else if traefik_recreate_required {
                            true
                        } else if saved_hash.as_deref() != Some(&config_hash) {
                            true
                        } else {
                            false
                        };

                        let reason = if user_stopped {
                            "user intentionally stopped the Hub — respecting decision across relaunch"
                                .to_string()
                        } else if start_failed {
                            "previous start failed — waiting for explicit user retry"
                                .to_string()
                        } else if !containers_exist {
                            "containers are missing".to_string()
                        } else if needs_runtime_recovery {
                            "containers exist but hub API is not healthy — attempting recovery"
                                .to_string()
                        } else if traefik_recreate_required {
                            "Traefik runtime preflight changed mounted state and requires container recreation"
                                .to_string()
                        } else if saved_hash.as_deref() != Some(&config_hash) {
                            "configuration hash changed".to_string()
                        } else {
                            "containers exist, configuration is unchanged, and no runtime repair is pending"
                                .to_string()
                        };

                        Ok(Some((should_start, reason)))
                    })
                    .await;

                    match decision {
                        Ok(Ok(Some((should_start, reason)))) => {
                            let _ = hub_manager::append_desktop_log_for(
                                &data,
                                "setup",
                                &format!(
                                    "Auto-start decision: should_start={} ({})",
                                    should_start, reason
                                ),
                            );

                            if should_start {
                                // Pre-cleanup: remove stale containers from a previous install
                                // before attempting compose up. This prevents "container name
                                // already in use" errors after an uninstall/reinstall cycle.
                                if let Err(err) = hub_manager::cleanup_stale_project_containers(
                                    &compose,
                                    &env,
                                    &data,
                                ) {
                                    let _ = hub_manager::append_desktop_log_for(
                                        &data,
                                        "setup",
                                        &format!("Pre-start cleanup failed (non-fatal): {}", err),
                                    );
                                }

                                let compose_for_start = compose.clone();
                                let env_for_start = env.clone();
                                let data_for_start = data.clone();
                                let result = tokio::task::spawn_blocking(move || {
                                    hub_manager::start_hub(
                                        &compose_for_start,
                                        &env_for_start,
                                        &data_for_start,
                                    )
                                })
                                .await;

                                match result {
                                    Ok(Ok(message)) => {
                                        let _ = hub_manager::append_desktop_log_for(
                                            &data,
                                            "setup",
                                            &message,
                                        );
                                    }
                                    Ok(Err(error)) => {
                                        let _ = hub_manager::append_desktop_log_for(
                                            &data,
                                            "setup",
                                            &format!("Auto-start failed: {}", error),
                                        );
                                    }
                                    Err(join_err) => {
                                        let msg = if join_err.is_panic() {
                                            format!("start_hub task panicked: {}", join_err)
                                        } else {
                                            format!("start_hub task was cancelled: {}", join_err)
                                        };
                                        let _ = hub_manager::append_desktop_log_for(
                                            &data,
                                            "setup",
                                            &msg,
                                        );
                                    }
                                }
                            }
                        }
                        Ok(Ok(None)) => {
                            let _ = hub_manager::append_desktop_log_for(
                                &data,
                                "setup",
                                "Skipping auto-start because Docker is not currently available.",
                            );
                        }
                        Ok(Err(error)) => {
                            let _ = hub_manager::append_desktop_log_for(
                                &data,
                                "setup",
                                &format!("Auto-start decision failed: {}", error),
                            );
                        }
                        Err(join_err) => {
                            let msg = if join_err.is_panic() {
                                format!("auto-start decision task panicked: {}", join_err)
                            } else {
                                format!("auto-start decision task was cancelled: {}", join_err)
                            };
                            let _ = hub_manager::append_desktop_log_for(&data, "setup", &msg);
                        }
                    }
                });
            }

            let app_handle = app.handle().clone();

            // Linux .desktop handlers pass the URL as a CLI arg (%u). Parse cold-start
            // argv before the UI mounts so pairing codes are not lost.
            for arg in std::env::args().skip(1) {
                handle_deep_link_url(&app_handle, &arg);
            }

            #[cfg(any(target_os = "linux", target_os = "macos"))]
            {
                for scheme in ["cihub", "cihub-dev"] {
                    if let Err(err) = app.deep_link().register(scheme) {
                        log::warn!("Failed to register {scheme}:// deep-link handler: {err}");
                    }
                }
            }

            let app_handle_for_listener = app_handle.clone();
            app.listen("deep-link://new-url", move |event| {
                handle_deep_link_payload(&app_handle_for_listener, event.payload());
            });

            // The deep-link plugin may emit before our listener is registered (cold start).
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_deep_link_url(&app_handle, url.as_ref());
                }
            }

            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running Companion Hub Desktop");
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LaunchMode {
    Desktop,
    Detached,
}

fn launch_mode_from_args(args: &[String]) -> LaunchMode {
    if args.iter().any(|arg| arg == DETACHED_FLAG) {
        LaunchMode::Detached
    } else {
        LaunchMode::Desktop
    }
}

fn current_executable_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe()
        .map_err(|error| format!("Failed to resolve the companion-hub executable path: {error}"))?;
    Ok(exe
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(".")))
}

fn run_detached_mode() -> Result<String, String> {
    let resource_dir = current_executable_dir()?;
    let initialization = hub_manager::initialize_hub(&resource_dir).map_err(|error| {
        error_reporting::capture_setup_failure(&error);
        error
    })?;
    let data_dir = initialization.data_dir.clone();
    hub_manager::persist_launch_mode(&data_dir, hub_manager::PersistedLaunchMode::Detached);
    let compose_path = initialization.compose_path.clone();
    let env_path = initialization.env_path.clone();
    // Headless mode skips run(), so initialize crash reporting here too —
    // otherwise Linux/SSH deployments would report nothing.
    error_reporting::init_from_env(
        &env_path,
        &data_dir,
        option_env!("CI_HUB_BUILD_VERSION").unwrap_or("0.0.0"),
    );

    let _ = hub_manager::append_desktop_log_for(
        &data_dir,
        "headless.start",
        &format!(
            "Starting detached headless mode from {}\ncompose={}\nenv={}",
            resource_dir.display(),
            compose_path.display(),
            env_path.display()
        ),
    );

    if let Err(error) =
        hub_manager::cleanup_stale_project_containers(&compose_path, &env_path, &data_dir)
    {
        let _ = hub_manager::append_desktop_log_for(
            &data_dir,
            "headless.start",
            &format!("Pre-start cleanup failed (non-fatal): {}", error),
        );
    }

    let message = hub_manager::start_hub(&compose_path, &env_path, &data_dir).map_err(|error| {
        error_reporting::capture_setup_failure(&error);
        error
    })?;

    updater::spawn_update_listener_daemon();

    Ok(format!("{message} (detached headless mode)"))
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.unminimize();
    }
}

fn sanitize_download_filename(filename: &str) -> String {
    let trimmed = filename.trim();
    let mut sanitized = trimmed
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => ch,
        })
        .collect::<String>()
        .trim_matches('.')
        .trim()
        .to_string();

    if sanitized.is_empty() {
        sanitized = "download.bin".to_string();
    }

    sanitized
}

fn preferred_download_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::desktop_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir)
}

fn unique_download_path(filename: &str) -> Result<PathBuf, String> {
    let dir = preferred_download_dir();
    std::fs::create_dir_all(&dir).map_err(|error| {
        format!(
            "Failed to create download directory {}: {error}",
            dir.display()
        )
    })?;

    let sanitized = sanitize_download_filename(filename);
    let path = PathBuf::from(&sanitized);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("download");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for index in 0..10_000 {
        let candidate_name = if index == 0 {
            sanitized.clone()
        } else if extension.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{extension}")
        };

        let candidate = dir.join(candidate_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Failed to allocate a unique download filename".to_string())
}

fn queue_pairing_code(app: &tauri::AppHandle, code: &str) {
    if let Some(state) = app.try_state::<PendingPairingCode>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(code.to_string());
        }
    }
    let _ = app.emit("deep-link-pair", code);
}

fn queue_portal_auth(app: &tauri::AppHandle, payload: DesktopPortalAuthPayload) {
    if let Some(state) = app.try_state::<PendingPortalAuth>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(payload.clone());
        }
    }
    let _ = app.emit("deep-link-auth", payload);
}

fn queue_install_intent(app: &tauri::AppHandle, payload: DesktopInstallIntentPayload) {
    if let Some(state) = app.try_state::<PendingInstallIntent>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(payload.clone());
        }
    }
    let _ = app.emit("deep-link-install", payload);
}

fn handle_deep_link_url(app: &tauri::AppHandle, url: &str) {
    if let Some(code) = extract_pairing_code(url) {
        focus_main_window(app);
        queue_pairing_code(app, &code);
        return;
    }

    if let Some(payload) = extract_portal_auth(url) {
        focus_main_window(app);
        queue_portal_auth(app, payload);
        return;
    }

    if let Some(payload) = extract_install_intent(url) {
        focus_main_window(app);
        queue_install_intent(app, payload);
    }
}

fn deep_link_urls_from_payload(payload: &str) -> Vec<String> {
    if let Ok(urls) = serde_json::from_str::<Vec<String>>(payload) {
        return urls;
    }

    let trimmed = payload.trim();
    if trimmed.starts_with('"') {
        if let Ok(url) = serde_json::from_str::<String>(trimmed) {
            return vec![url];
        }
    }

    if !trimmed.is_empty() {
        return vec![trimmed.to_string()];
    }

    Vec::new()
}

fn handle_deep_link_payload(app: &tauri::AppHandle, payload: &str) {
    for url in deep_link_urls_from_payload(payload) {
        handle_deep_link_url(app, &url);
    }
}

fn extract_pairing_code(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("cihub://pair") {
        return None;
    }
    if let Some(query) = trimmed.split('?').nth(1) {
        for param in query.split('&') {
            if let Some(code) = param.strip_prefix("code=") {
                let code = code.trim().to_uppercase();
                if code.len() == 6 && code.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Some(code);
                }
            }
        }
    }
    if let Some(rest) = trimmed.strip_prefix("cihub://pair/") {
        let code = rest.split('?').next().unwrap_or("").trim().to_uppercase();
        if code.len() == 6 && code.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Some(code);
        }
    }
    None
}

fn extract_portal_auth(url: &str) -> Option<DesktopPortalAuthPayload> {
    let trimmed = url.trim();
    if !trimmed.starts_with("cihub://auth") && !trimmed.starts_with("cihub-dev://auth") {
        return None;
    }

    let query = trimmed.split('?').nth(1)?;
    let mut token = None;
    let mut error = None;

    for param in query.split('&') {
        if let Some(value) = param.strip_prefix("token=") {
            let value = value.trim();
            if !value.is_empty() {
                token = Some(value.to_string());
            }
        } else if let Some(value) = param.strip_prefix("error=") {
            let value = value.trim();
            if !value.is_empty() {
                error = Some(value.to_string());
            }
        }
    }

    if token.is_some() || error.is_some() {
        Some(DesktopPortalAuthPayload { token, error })
    } else {
        None
    }
}

fn is_install_deep_link_prefix(url: &str) -> bool {
    url.starts_with("cihub://install") || url.starts_with("cihub-dev://install")
}

fn parse_install_query_param(query: &str, key: &str) -> Option<String> {
    for param in query.split('&') {
        if let Some(value) = param.strip_prefix(&format!("{key}=")) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn extract_install_intent(url: &str) -> Option<DesktopInstallIntentPayload> {
    let trimmed = url.trim();
    if !is_install_deep_link_prefix(trimmed) {
        return None;
    }

    let without_scheme = trimmed
        .strip_prefix("cihub-dev://install/")
        .or_else(|| trimmed.strip_prefix("cihub://install/"))
        .or_else(|| trimmed.strip_prefix("cihub-dev://install?"))
        .or_else(|| trimmed.strip_prefix("cihub://install?"))?;

    let (path_part, query_part) = match without_scheme.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (without_scheme, trimmed.split('?').nth(1)),
    };

    let app_slug = path_part.split('/').next()?.trim().to_string();
    if app_slug.is_empty() {
        return None;
    }

    let store_id = query_part
        .and_then(|query| parse_install_query_param(query, "storeId"))
        .unwrap_or_else(default_install_store_id);
    let device_id = query_part.and_then(|query| parse_install_query_param(query, "deviceId"));

    Some(DesktopInstallIntentPayload {
        app_slug,
        store_id,
        device_id,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        deep_link_urls_from_payload, extract_install_intent, extract_pairing_code, extract_portal_auth,
        launch_mode_from_args, sanitize_download_filename, stack_dev_mode_enabled,
        stack_dev_override_paths, validate_open_path, LaunchMode, STACK_DEV_COMPOSE_PATH_ENV,
        STACK_DEV_ENV, STACK_DEV_ENV_PATH_ENV,
    };
    use std::path::{Path, PathBuf};

    #[test]
    fn validate_open_path_accepts_existing_dir() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        assert!(validate_open_path(tempdir.path()).is_ok());
    }

    #[test]
    fn validate_open_path_rejects_empty() {
        assert!(validate_open_path(Path::new("")).is_err());
    }

    #[test]
    fn validate_open_path_rejects_relative() {
        assert!(validate_open_path(Path::new("relative/dir")).is_err());
    }

    #[test]
    fn validate_open_path_rejects_missing() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let missing = tempdir.path().join("does-not-exist");
        assert!(validate_open_path(&missing).is_err());
    }

    #[test]
    fn validate_open_path_rejects_file() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let file = tempdir.path().join("a-file.txt");
        std::fs::write(&file, b"x").expect("write");
        assert!(validate_open_path(&file).is_err());
    }

    #[test]
    fn extract_pairing_code_from_query_param() {
        assert_eq!(
            extract_pairing_code("cihub://pair?code=abc123"),
            Some("ABC123".to_string())
        );
    }

    #[test]
    fn extract_pairing_code_from_path() {
        assert_eq!(
            extract_pairing_code("cihub://pair/abc123"),
            Some("ABC123".to_string())
        );
    }

    #[test]
    fn extract_portal_auth_token_from_query_param() {
        assert_eq!(
            extract_portal_auth("cihub://auth?token=desktop-token"),
            Some(super::DesktopPortalAuthPayload {
                token: Some("desktop-token".to_string()),
                error: None,
            })
        );
        assert_eq!(
            extract_portal_auth("cihub-dev://auth?token=desktop-token"),
            Some(super::DesktopPortalAuthPayload {
                token: Some("desktop-token".to_string()),
                error: None,
            })
        );
    }

    #[test]
    fn extract_portal_auth_error_from_query_param() {
        assert_eq!(
            extract_portal_auth("cihub://auth?error=callback_error"),
            Some(super::DesktopPortalAuthPayload {
                token: None,
                error: Some("callback_error".to_string()),
            })
        );
    }

    #[test]
    fn ignore_non_auth_deep_links_for_portal_auth() {
        assert_eq!(extract_portal_auth("cihub://pair?code=abc123"), None);
    }

    #[test]
    fn extract_install_intent_from_path() {
        assert_eq!(
            extract_install_intent("cihub://install/immich"),
            Some(super::DesktopInstallIntentPayload {
                app_slug: "immich".to_string(),
                store_id: "ci-marketplace".to_string(),
                device_id: None,
            })
        );
    }

    #[test]
    fn extract_install_intent_from_path_with_query() {
        assert_eq!(
            extract_install_intent("cihub://install/immich?storeId=ci-apps&deviceId=dev-1"),
            Some(super::DesktopInstallIntentPayload {
                app_slug: "immich".to_string(),
                store_id: "ci-apps".to_string(),
                device_id: Some("dev-1".to_string()),
            })
        );
    }

    #[test]
    fn extract_install_intent_dev_scheme() {
        assert_eq!(
            extract_install_intent("cihub-dev://install/plane"),
            Some(super::DesktopInstallIntentPayload {
                app_slug: "plane".to_string(),
                store_id: "ci-marketplace".to_string(),
                device_id: None,
            })
        );
    }

    #[test]
    fn ignore_pairing_for_install_intent() {
        assert_eq!(extract_install_intent("cihub://pair?code=abc123"), None);
    }

    #[test]
    fn sanitize_download_filename_removes_path_separators() {
        assert_eq!(
            sanitize_download_filename("../ci:hub\\logs?.log"),
            "_ci_hub_logs_.log".to_string()
        );
    }

    #[test]
    fn deep_link_urls_from_json_array_payload() {
        assert_eq!(
            deep_link_urls_from_payload(r#"["cihub://pair?code=abc123"]"#),
            vec!["cihub://pair?code=abc123".to_string()]
        );
    }

    #[test]
    fn deep_link_urls_from_plain_url_payload() {
        assert_eq!(
            deep_link_urls_from_payload("cihub://pair?code=abc123"),
            vec!["cihub://pair?code=abc123".to_string()]
        );
    }

    #[test]
    fn launch_mode_defaults_to_desktop() {
        assert_eq!(launch_mode_from_args(&[]), LaunchMode::Desktop);
    }

    #[test]
    fn launch_mode_switches_to_detached_with_flag() {
        assert_eq!(
            launch_mode_from_args(&["--detached".to_string()]),
            LaunchMode::Detached
        );
    }

    #[test]
    fn stack_dev_mode_disabled_by_default() {
        let original = std::env::var_os(STACK_DEV_ENV);
        unsafe {
            std::env::remove_var(STACK_DEV_ENV);
        }

        assert!(!stack_dev_mode_enabled());

        if let Some(value) = original {
            unsafe {
                std::env::set_var(STACK_DEV_ENV, value);
            }
        }
    }

    #[test]
    fn stack_dev_override_paths_require_existing_files() {
        let original_mode = std::env::var_os(STACK_DEV_ENV);
        let original_compose = std::env::var_os(STACK_DEV_COMPOSE_PATH_ENV);
        let original_env = std::env::var_os(STACK_DEV_ENV_PATH_ENV);
        let tempdir = tempfile::tempdir().expect("tempdir");
        let compose_path = tempdir.path().join("docker-compose.prod.yml");
        let env_path = tempdir.path().join(".env.dev");
        std::fs::write(&compose_path, "services: {}\n").expect("compose");
        std::fs::write(&env_path, "API_PORT=5002\n").expect("env");

        unsafe {
            std::env::set_var(STACK_DEV_ENV, "1");
            std::env::set_var(STACK_DEV_COMPOSE_PATH_ENV, &compose_path);
            std::env::set_var(STACK_DEV_ENV_PATH_ENV, &env_path);
        }

        assert_eq!(
            stack_dev_override_paths().expect("paths"),
            Some((PathBuf::from(&compose_path), PathBuf::from(&env_path)))
        );

        match original_mode {
            Some(value) => unsafe { std::env::set_var(STACK_DEV_ENV, value) },
            None => unsafe { std::env::remove_var(STACK_DEV_ENV) },
        }
        match original_compose {
            Some(value) => unsafe { std::env::set_var(STACK_DEV_COMPOSE_PATH_ENV, value) },
            None => unsafe { std::env::remove_var(STACK_DEV_COMPOSE_PATH_ENV) },
        }
        match original_env {
            Some(value) => unsafe { std::env::set_var(STACK_DEV_ENV_PATH_ENV, value) },
            None => unsafe { std::env::remove_var(STACK_DEV_ENV_PATH_ENV) },
        }
    }
}

fn build_version() -> &'static str {
    option_env!("CI_HUB_BUILD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

/// Plain-text usage, printed before any GTK/windowing initialization so it
/// works over SSH and in containers. This is the first thing users and coding
/// agents probe on a headless machine — it must never panic.
fn print_cli_help() {
    println!(
        "\
Companion Hub {version} — desktop app + headless launcher for the Companion Intelligence Hub

USAGE:
  companion-hub                   Launch the desktop app (requires a graphical session)
  companion-hub --detached        Start the Hub stack headless (no display needed) and exit
  companion-hub update [--check]  Install (or just check for) desktop + stack updates
  companion-hub --help | -h       Show this help
  companion-hub --version | -V    Show the version

NO GRAPHICAL SESSION? (SSH, servers, CI, agents)
  The Hub itself runs in Docker and does not need a display.
    companion-hub --detached      one-shot headless start of the Hub stack
    cihub --help                  full CLI: lifecycle, status, logs, pairing,
                                  models, and app management
  `cihub` ships with this package and is also available via `npm install -g ci-hub`.

ENVIRONMENT (developer stack override):
  {stack_dev}=1                  Attach to an externally managed compose stack
  {stack_dev_compose}=<path>     Compose file of that stack
  {stack_dev_env}=<path>         Env file of that stack

Docs: https://github.com/companionintelligence/CI-Hub/blob/main/docs/CLI.md",
        version = build_version(),
        stack_dev = STACK_DEV_ENV,
        stack_dev_compose = STACK_DEV_COMPOSE_PATH_ENV,
        stack_dev_env = STACK_DEV_ENV_PATH_ENV,
    );
}

/// Whether a display server is reachable. Launching the GTK/Tauri UI without
/// one panics deep inside tao ("Failed to initialize gtk backend!"), which
/// reads like a crash instead of a usage problem — so we check first and
/// print actionable guidance.
#[cfg(target_os = "linux")]
fn graphical_session_available() -> bool {
    let non_empty = |name: &str| {
        std::env::var_os(name)
            .map(|value| !value.is_empty())
            .unwrap_or(false)
    };
    non_empty("DISPLAY") || non_empty("WAYLAND_DISPLAY")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_cli_help();
        return;
    }

    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("companion-hub {}", build_version());
        return;
    }

    if args.iter().any(|a| a == "update") {
        let check_only = args.iter().any(|a| a == "--check");
        match updater::run_update_cli(check_only) {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{}", error);
                std::process::exit(1);
            }
        }
    }

    if args.iter().any(|a| a == "--update-listener") {
        updater::run_update_listener();
        return;
    }

    if launch_mode_from_args(&args) == LaunchMode::Detached {
        match run_detached_mode() {
            Ok(message) => {
                println!("{}", message);
                return;
            }
            Err(error) => {
                eprintln!("{}", error);
                std::process::exit(1);
            }
        }
    }

    #[cfg(target_os = "linux")]
    if !graphical_session_available() {
        eprintln!(
            "\
companion-hub: no graphical session detected (DISPLAY/WAYLAND_DISPLAY are unset).

The desktop UI needs a display, but the Hub itself does not:
  companion-hub --detached      start the Hub stack headless
  cihub --help                  manage the Hub from the terminal
  companion-hub --help          all options

To use the desktop UI, log into a desktop session on this machine."
        );
        std::process::exit(2);
    }

    run();
}
