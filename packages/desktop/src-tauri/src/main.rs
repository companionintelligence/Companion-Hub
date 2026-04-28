// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discovery;
pub mod hub_manager;
pub mod port_manager;
mod tray;

use tauri::{Emitter, Listener, Manager};
use tauri_plugin_store::StoreExt;

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
    hub_manager::start_hub(&state.compose_path, &state.env_path, &state.data_dir)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
            for arg in &args {
                if let Some(code) = extract_pairing_code(arg) {
                    let _ = app.emit("deep-link-pair", code);
                }
            }
        }))
        .plugin(tauri_plugin_shell::init())
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
            install_docker_command,
        ])
        .setup(|app| {
            // Restore saved window geometry
            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;

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
            let initialization = hub_manager::initialize_hub(&resource_dir)?;
            let data_dir = initialization.data_dir.clone();
            let compose_path = initialization.compose_path.clone();
            let env_path = initialization.env_path.clone();
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

                let should_start = if !containers_exist {
                    true // First launch or user stopped Hub
                } else if traefik_recreate_required {
                    true // Runtime state changed and Traefik must be recreated before reuse
                } else if saved_hash.as_deref() != Some(&config_hash) {
                    true // Config changed (upgrade, env fix, etc.)
                } else {
                    false // Containers exist, config unchanged, no runtime repair pending — do nothing
                };

                let reason = if !containers_exist {
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
                    let _ = hub_manager::cleanup_stale_project_containers(
                        &compose_path,
                        &env_path,
                        &data_dir,
                    );

                    let compose = compose_path;
                    let env = env_path;
                    let data = data_dir;
                    let hash = config_hash;
                    let hp = hash_path;
                    tauri::async_runtime::spawn(async move {
                        match hub_manager::start_hub(&compose, &env, &data) {
                            Ok(message) => {
                                let _ =
                                    hub_manager::append_desktop_log_for(&data, "setup", &message);
                            }
                            Err(error) => {
                                let _ = hub_manager::append_desktop_log_for(
                                    &data,
                                    "setup",
                                    &format!("Auto-start failed: {}", error),
                                );
                            }
                        }
                        // Save hash regardless of compose exit status — partial starts
                        // (e.g. Traefik port conflict) are still a valid state. Without
                        // this, every relaunch re-runs compose because the hash is never saved.
                        if let Err(error) = std::fs::write(&hp, &hash) {
                            let _ = hub_manager::append_desktop_log_for(
                                &data,
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
            app.listen("deep-link://new-url", move |event| {
                let raw = event.payload().trim_matches('"');
                if let Some(code) = extract_pairing_code(raw) {
                    let _ = app_handle.emit("deep-link-pair", code);
                }
            });

            Ok(())
        });

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .run(tauri::generate_context!())
        .expect("error while running Companion Hub Desktop");
}

use sha2::{Digest, Sha256};

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
    run();
}
