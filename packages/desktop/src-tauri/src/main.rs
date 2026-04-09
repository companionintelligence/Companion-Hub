// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discovery;
pub mod hub_manager;
pub mod port_manager;
mod tray;

use tauri::Manager;
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

/// Get the current Hub status (Docker availability, container state, health).
#[tauri::command]
async fn get_hub_status_command() -> hub_manager::HubStatus {
    hub_manager::get_hub_status()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
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
            get_hub_status_command,
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
                if let Some(x) = store.get("window_x").and_then(|v: serde_json::Value| v.as_f64())
                {
                    if let Some(y) =
                        store.get("window_y").and_then(|v: serde_json::Value| v.as_f64())
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
                        let _ =
                            window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                    }
                }
            }

            // Build system tray (also registers close-to-hide handler)
            tray::create_tray(app)?;

            // Initialize Hub data directory and compose file
            let resource_dir = app.path().resource_dir().map_err(|e| format!("{}", e))?;
            let (data_dir, compose_path, env_path) =
                hub_manager::initialize_hub(&resource_dir)?;

            // Store paths in app state for tray and commands to use
            app.manage(hub_manager::HubPaths {
                data_dir: data_dir.clone(),
                compose_path: compose_path.clone(),
                env_path: env_path.clone(),
            });

            // Hash-based reconciliation: only start/restart when config changed
            // or containers don't exist. Respects user intent (stopped Hub stays stopped
            // unless config changed on upgrade).
            if hub_manager::is_docker_available() {
                let config_hash = compute_config_hash(&compose_path, &env_path);
                let hash_path = data_dir.join(".config-hash");
                let saved_hash = std::fs::read_to_string(&hash_path).ok();
                let containers_exist = hub_manager::hub_containers_exist();

                let should_start = if !containers_exist {
                    true // First launch or user stopped Hub
                } else if saved_hash.as_deref() != Some(&config_hash) {
                    true // Config changed (upgrade, env fix, etc.)
                } else {
                    false // Containers exist, config unchanged — do nothing
                };

                if should_start {
                    let compose = compose_path;
                    let env = env_path;
                    let data = data_dir;
                    let hash = config_hash;
                    let hp = hash_path;
                    tauri::async_runtime::spawn(async move {
                        if hub_manager::start_hub(&compose, &env, &data).is_ok() {
                            let _ = std::fs::write(&hp, &hash);
                        }
                    });
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

use sha2::{Sha256, Digest};

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
