// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discovery;
pub mod hub_manager;
pub mod port_manager;
mod tray;

use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri_plugin_store::StoreExt;

#[tauri::command]
async fn check_hub_status(url: String) -> Result<bool, String> {
    match reqwest::get(format!("{}/api/health", url)).await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[tauri::command]
async fn discover_hubs() -> Result<Vec<String>, String> {
    discovery::find_hubs().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn start_hub_command(
    state: tauri::State<'_, hub_manager::HubPaths>,
) -> Result<String, String> {
    hub_manager::start_hub(&state.compose_path, &state.env_path, &state.data_dir)
}

#[tauri::command]
async fn check_docker_available() -> Result<bool, String> {
    Ok(hub_manager::is_docker_available())
}

#[tauri::command]
async fn check_docker_access_command() -> Result<hub_manager::DockerAccessCheck, String> {
    Ok(hub_manager::check_docker_access())
}

#[tauri::command]
async fn install_docker_command() -> Result<hub_manager::DockerInstallResult, String> {
    hub_manager::install_docker()
}

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
            check_docker_access_command,
            get_hub_status_command,
            install_docker_command,
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or("main window not found")?;

            #[cfg(not(target_os = "macos"))]
            {
                let _ = window.set_decorations(false);
            }

            if let Ok(store) = app.store("settings.json") {
                if let Some(x) = store
                    .get("window_x")
                    .and_then(|v: serde_json::Value| v.as_f64())
                {
                    if let Some(y) = store
                        .get("window_y")
                        .and_then(|v: serde_json::Value| v.as_f64())
                    {
                        let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
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

            tray::create_tray(app)?;

            let resource_dir = app.path().resource_dir().map_err(|e| format!("{}", e))?;
            let bootstrap_data_dir = hub_manager::get_hub_data_dir();
            let _ = hub_manager::log_desktop_event(
                &bootstrap_data_dir,
                "startup",
                &format!(
                    "Desktop setup starting. resource_dir={}",
                    resource_dir.display()
                ),
            );

            let (data_dir, compose_path, env_path) = hub_manager::initialize_hub(&resource_dir)?;
            let _ = hub_manager::log_desktop_event(
                &data_dir,
                "startup",
                &format!(
                    "Desktop paths ready. compose={} env={}",
                    compose_path.display(),
                    env_path.display()
                ),
            );

            app.manage(hub_manager::HubPaths {
                data_dir: data_dir.clone(),
                compose_path: compose_path.clone(),
                env_path: env_path.clone(),
            });

            if hub_manager::is_docker_available() {
                let config_hash = compute_config_hash(&compose_path, &env_path);
                let hash_path = data_dir.join(".config-hash");
                let saved_hash = std::fs::read_to_string(&hash_path).ok();
                let containers_exist = hub_manager::hub_containers_exist();

                let auto_start_reason = if !containers_exist {
                    Some("Hub containers do not exist yet.".to_string())
                } else if saved_hash.as_deref() != Some(&config_hash) {
                    Some("Hub configuration changed since the last launch.".to_string())
                } else {
                    None
                };

                if let Some(reason) = auto_start_reason {
                    let _ = hub_manager::log_desktop_event(
                        &data_dir,
                        "startup",
                        &format!("Auto-start scheduled. {}", reason),
                    );

                    let compose = compose_path.clone();
                    let env = env_path.clone();
                    let data = data_dir.clone();
                    let hash = config_hash;
                    let hp = hash_path;
                    tauri::async_runtime::spawn(async move {
                        let _ = hub_manager::start_hub(&compose, &env, &data);
                        match std::fs::write(&hp, &hash) {
                            Ok(()) => {
                                let _ = hub_manager::log_desktop_event(
                                    &data,
                                    "startup",
                                    &format!(
                                        "Persisted configuration hash after auto-start attempt at {}.",
                                        hp.display()
                                    ),
                                );
                            }
                            Err(error) => {
                                let _ = hub_manager::log_desktop_event(
                                    &data,
                                    "startup",
                                    &format!(
                                        "Failed to persist configuration hash at {}: {}",
                                        hp.display(),
                                        error
                                    ),
                                );
                            }
                        }
                    });
                } else {
                    let _ = hub_manager::log_desktop_event(
                        &data_dir,
                        "startup",
                        "Skipping auto-start. Containers already exist and configuration hash is unchanged.",
                    );
                }
            } else {
                let _ = hub_manager::log_desktop_event(
                    &data_dir,
                    "startup",
                    "Docker is unavailable during setup. Skipping auto-start reconciliation.",
                );
            }

            Ok(())
        });

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .run(tauri::generate_context!())
        .expect("error while running Companion Hub Desktop");
}

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
