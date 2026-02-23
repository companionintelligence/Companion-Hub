// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

mod system;
mod installers;

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
        .invoke_handler(tauri::generate_handler![
            get_system_info,
            check_backend_status,
            // System detection commands
            system::check_system_requirements,
            // Prerequisite check commands
            system::check_wsl2_installed,
            system::check_docker_installed,
            system::check_xcode_tools,
            system::check_homebrew,
            system::check_colima,
            system::check_python_installed,
            system::check_all_prerequisites,
            // Windows installer commands
            installers::windows::install_wsl2,
            installers::windows::check_wsl2_restart_required,
            installers::windows::configure_wsl2_ubuntu,
            installers::windows::install_docker_desktop,
            installers::windows::start_docker_desktop,
            installers::windows::configure_docker_wsl2,
            installers::windows::install_python_wsl2,
            installers::windows::check_python_version_wsl2,
            // macOS installer commands
            installers::macos::install_homebrew,
            installers::macos::update_homebrew,
            installers::macos::install_colima,
            installers::macos::start_colima,
            installers::macos::stop_colima,
            installers::macos::restart_colima,
            installers::macos::install_python_macos,
            installers::macos::check_python_version_macos,
            installers::macos::configure_headless_python,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
