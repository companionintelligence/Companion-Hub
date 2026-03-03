// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod discovery;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            check_hub_status,
            discover_hubs,
        ])
        .setup(|app| {
            // Build system tray
            tray::create_tray(app)?;

            // Restore saved window geometry
            let window = app.get_webview_window("main").unwrap();
            if let Ok(store) = app.store("settings.json") {
                if let Some(x) = store.get("window_x").and_then(|v: serde_json::Value| v.as_f64()) {
                    if let Some(y) = store.get("window_y").and_then(|v: serde_json::Value| v.as_f64()) {
                        let _ = window.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
                    }
                }
                if let Some(w) = store.get("window_width").and_then(|v: serde_json::Value| v.as_f64()) {
                    if let Some(h) = store.get("window_height").and_then(|v: serde_json::Value| v.as_f64()) {
                        let _ = window.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
                    }
                }
            }

            // Save window geometry on close
            let app_handle = app.handle().clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if let Ok(store) = app_handle.store("settings.json") {
                            if let Ok(pos) = window.outer_position() {
                                store.set("window_x", serde_json::json!(pos.x));
                                store.set("window_y", serde_json::json!(pos.y));
                            }
                            if let Ok(size) = window.outer_size() {
                                store.set("window_width", serde_json::json!(size.width));
                                store.set("window_height", serde_json::json!(size.height));
                            }
                            let _ = store.save();
                        }
                    }
                }
            });

            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("error while running CI OS Hub Desktop");
}

fn main() {
    run();
}
