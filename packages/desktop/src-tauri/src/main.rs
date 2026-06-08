// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discovery;
mod error_reporting;
pub mod hub_manager;
pub mod port_manager;
mod tray;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{Emitter, Listener, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_store::StoreExt;

const DETACHED_FLAG: &str = "--detached";

struct PendingPairingCode(Mutex<Option<String>>);

/// Check if the Hub backend is reachable at the given URL.
#[tauri::command]
async fn check_hub_status(url: String) -> Result<bool, String> {
    match reqwest::get(format!("{}/api/health", url)).await {
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

/// Get the current Hub status (Docker availability, container state, health).
#[tauri::command]
async fn get_hub_status_command() -> hub_manager::HubStatus {
    hub_manager::get_hub_status()
}

/// Get per-service startup progress for the frontend loading screen.
#[tauri::command]
async fn get_startup_progress_command() -> hub_manager::StartupProgress {
    hub_manager::get_startup_progress()
}

/// Read recent desktop log lines for in-app diagnostics (last 200 lines).
#[tauri::command]
async fn read_desktop_logs_command() -> String {
    hub_manager::read_desktop_logs(200)
}

/// Open the logs directory in the system file manager.
#[tauri::command]
async fn open_logs_dir_command(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let logs_dir = hub_manager::logs_open_target();
    let _ = std::fs::create_dir_all(&logs_dir);
    app.opener()
        .open_path(logs_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .manage(PendingPairingCode(Mutex::new(None)))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
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
            check_docker_available,
            check_docker_access_command,
            get_hub_status_command,
            get_startup_progress_command,
            read_desktop_logs_command,
            open_logs_dir_command,
            is_user_stopped_command,
            install_docker_command,
            consume_pending_pairing_code,
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
                // Geometry is persisted on window close (see tray.rs). Its absence
                // means this is the first launch on this machine — open maximized so
                // the onboarding wizard has the full screen to work with. Every later
                // launch restores the saved size and position instead.
                let has_saved_geometry = store.get("window_width").is_some();

                if has_saved_geometry {
                    if let Some(x) = store
                        .get("window_x")
                        .and_then(|v: serde_json::Value| v.as_f64())
                    {
                        if let Some(y) = store
                            .get("window_y")
                            .and_then(|v: serde_json::Value| v.as_f64())
                        {
                            let _ = window
                                .set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
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
                } else {
                    // First-time startup — maximize to fill the screen.
                    let _ = window.maximize();
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
            let compose_path = initialization.compose_path.clone();
            let env_path = initialization.env_path.clone();
            error_reporting::init_from_env(
                &env_path,
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

            // Hash-based reconciliation: start/restart when containers are missing,
            // configuration changed, or the Traefik runtime preflight changed mounted
            // state and needs a recreate. Respects user intent as much as possible
            // while still healing poisoned bind mounts on upgrade/relaunch.
            if hub_manager::is_docker_available() {
                let config_hash = compute_config_hash(&compose_path, &env_path);
                let hash_path = data_dir.join(".config-hash");
                let saved_hash = std::fs::read_to_string(&hash_path).ok();
                let containers_exist = hub_manager::hub_containers_exist();
                let traefik_recreate_required = traefik_preflight.changed
                    || hub_manager::is_traefik_recreate_required(&data_dir);
                // Respect the user's explicit decision to stop the Hub: if they clicked
                // "Stop Hub" last time, don't auto-restart on the next launch until they
                // explicitly click "Start Hub" again.
                let user_stopped = hub_manager::is_user_stopped(&data_dir);

                let should_start = if user_stopped {
                    false // User explicitly stopped — honour the decision across relaunches
                } else if !containers_exist {
                    true // First launch or containers were removed
                } else if traefik_recreate_required {
                    true // Runtime state changed and Traefik must be recreated before reuse
                } else if saved_hash.as_deref() != Some(&config_hash) {
                    true // Config changed (upgrade, env fix, etc.)
                } else {
                    false // Containers exist, config unchanged, no runtime repair pending — do nothing
                };

                let reason = if user_stopped {
                    "user intentionally stopped the Hub — respecting decision across relaunch"
                        .to_string()
                } else if !containers_exist {
                    "containers are missing".to_string()
                } else if traefik_recreate_required {
                    "Traefik runtime preflight changed mounted state and requires container recreation"
                        .to_string()
                } else if saved_hash.as_deref() != Some(&config_hash) {
                    "configuration hash changed".to_string()
                } else {
                    "containers exist, configuration is unchanged, and no runtime repair is pending"
                        .to_string()
                };
                let _ = hub_manager::append_desktop_log_for(
                    &data_dir,
                    "setup",
                    &format!(
                        "Auto-start decision: should_start={} ({})",
                        should_start, reason
                    ),
                );

                if should_start {
                    // Pre-cleanup: remove stale containers from a previous install
                    // before attempting compose up.  This prevents "container name
                    // already in use" errors after an uninstall/reinstall cycle.
                    if let Err(err) = hub_manager::cleanup_stale_project_containers(
                        &compose_path,
                        &env_path,
                        &data_dir,
                    ) {
                        let _ = hub_manager::append_desktop_log_for(
                            &data_dir,
                            "setup",
                            &format!("Pre-start cleanup failed (non-fatal): {}", err),
                        );
                    }

                    let compose = compose_path;
                    let env = env_path;
                    let data = data_dir;
                    let hash = config_hash;
                    let hp = hash_path;
                    let data_for_log = data.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = tokio::task::spawn_blocking(move || {
                            hub_manager::start_hub(&compose, &env, &data)
                        })
                        .await;
                        match result {
                            Ok(Ok(message)) => {
                                let _ = hub_manager::append_desktop_log_for(
                                    &data_for_log,
                                    "setup",
                                    &message,
                                );
                            }
                            Ok(Err(error)) => {
                                let _ = hub_manager::append_desktop_log_for(
                                    &data_for_log,
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
                                    &data_for_log,
                                    "setup",
                                    &msg,
                                );
                            }
                        }
                        // Save hash regardless of compose exit status — partial starts
                        // (e.g. Traefik port conflict) are still a valid state. Without
                        // this, every relaunch re-runs compose because the hash is never saved.
                        if let Err(error) = std::fs::write(&hp, &hash) {
                            let _ = hub_manager::append_desktop_log_for(
                                &data_for_log,
                                "setup",
                                &format!("Failed to persist configuration hash: {}", error),
                            );
                        }
                    });
                }
            } else {
                let _ = hub_manager::append_desktop_log_for(
                    &data_dir,
                    "setup",
                    "Skipping auto-start because Docker is not currently available.",
                );
            }

            let app_handle = app.handle().clone();

            // Linux .desktop handlers pass the URL as a CLI arg (%u). Parse cold-start
            // argv before the UI mounts so pairing codes are not lost.
            for arg in std::env::args().skip(1) {
                handle_deep_link_url(&app_handle, &arg);
            }

            #[cfg(target_os = "linux")]
            {
                if let Err(err) = app.deep_link().register("cihub") {
                    log::warn!("Failed to register cihub:// deep-link handler: {err}");
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

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .run(tauri::generate_context!())
        .expect("error while running Companion Hub Desktop");
}

use sha2::{Digest, Sha256};

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
    let compose_path = initialization.compose_path.clone();
    let env_path = initialization.env_path.clone();
    // Headless mode skips run(), so initialize crash reporting here too —
    // otherwise Linux/SSH deployments would report nothing.
    error_reporting::init_from_env(
        &env_path,
        option_env!("CI_HUB_BUILD_VERSION").unwrap_or("0.0.0"),
    );
    let hash_path = data_dir.join(".config-hash");
    let config_hash = compute_config_hash(&compose_path, &env_path);

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
    if let Err(error) = std::fs::write(&hash_path, &config_hash) {
        let _ = hub_manager::append_desktop_log_for(
            &data_dir,
            "headless.start",
            &format!(
                "Hub started, but failed to persist configuration hash at {}: {}",
                hash_path.display(),
                error
            ),
        );
    }

    Ok(format!("{message} (detached headless mode)"))
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.unminimize();
    }
}

fn queue_pairing_code(app: &tauri::AppHandle, code: &str) {
    if let Some(state) = app.try_state::<PendingPairingCode>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(code.to_string());
        }
    }
    let _ = app.emit("deep-link-pair", code);
}

fn handle_deep_link_url(app: &tauri::AppHandle, url: &str) {
    if let Some(code) = extract_pairing_code(url) {
        focus_main_window(app);
        queue_pairing_code(app, &code);
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

#[cfg(test)]
mod tests {
    use super::{
        deep_link_urls_from_payload, extract_pairing_code, launch_mode_from_args, LaunchMode,
    };

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
}

/// Compute a SHA256 hash of the .env and compose file contents.
/// Used for hash-based reconciliation — only restart containers when config changes.
fn compute_config_hash(compose_path: &std::path::Path, env_path: &std::path::Path) -> String {
    let mut hasher = Sha256::new();
    if let Ok(content) = std::fs::read(compose_path) {
        hasher.update(&content);
    }
    if let Ok(content) = std::fs::read(env_path) {
        hasher.update(&content);
    }
    format!("{:x}", hasher.finalize())
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
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

    run();
}
