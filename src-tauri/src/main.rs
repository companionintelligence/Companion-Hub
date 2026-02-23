// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

#[tauri::command]
fn get_system_info() -> Result<String, String> {
    let info = format!(
        "OS: {} {}\nArch: {}",
        std::env::consts::OS,
        std::env::consts::FAMILY,
        std::env::consts::ARCH
    );
    Ok(info)
}

#[tauri::command]
async fn check_backend_status() -> Result<bool, String> {
    // Simple health check to backend
    match reqwest::get("http://localhost:3000/api/health").await {
        Ok(response) => Ok(response.status().is_success()),
        Err(_) => Ok(false),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_system_info, check_backend_status])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
