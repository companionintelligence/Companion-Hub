use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::AppHandle;

use super::super::InstallProgress;
use super::super::InstallStatus;

/// Install Docker Desktop for Windows
#[tauri::command]
pub async fn install_docker_desktop(app: AppHandle) -> Result<(), String> {
    emit_progress(&app, "Downloading Docker Desktop", 10, InstallStatus::InProgress,
        "Downloading Docker Desktop installer...");
    
    // Download Docker Desktop installer
    let download_url = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
    let installer_path = std::env::temp_dir().join("DockerDesktopInstaller.exe");
    
    let response = reqwest::get(download_url)
        .await
        .map_err(|e| format!("Failed to download Docker Desktop: {}", e))?;
    
    let bytes = response.bytes()
        .await
        .map_err(|e| format!("Failed to read download: {}", e))?;
    
    std::fs::write(&installer_path, &bytes)
        .map_err(|e| format!("Failed to save installer: {}", e))?;
    
    emit_progress(&app, "Installing Docker Desktop", 50, InstallStatus::InProgress,
        "Running Docker Desktop installer...");
    
    // Run installer with silent install flags
    let install = Command::new(&installer_path)
        .args(&["install", "--quiet", "--accept-license"])
        .output()
        .map_err(|e| format!("Failed to run installer: {}", e))?;
    
    if !install.status.success() {
        return Err("Docker Desktop installation failed".to_string());
    }
    
    emit_progress(&app, "Configuring Docker", 80, InstallStatus::InProgress,
        "Configuring Docker to use WSL2 backend...");
    
    // Wait for Docker to be available and configure it
    tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
    
    emit_progress(&app, "Docker Installation Complete", 100, InstallStatus::Complete,
        "Docker Desktop installed successfully. Starting Docker...");
    
    // Clean up installer
    let _ = std::fs::remove_file(&installer_path);
    
    Ok(())
}

/// Start Docker Desktop
#[tauri::command]
pub async fn start_docker_desktop() -> Result<(), String> {
    // Start Docker Desktop
    let start = Command::new("powershell")
        .args(&[
            "-Command",
            "Start-Process 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'"
        ])
        .output()
        .map_err(|e| format!("Failed to start Docker: {}", e))?;
    
    if !start.status.success() {
        return Err("Failed to start Docker Desktop".to_string());
    }
    
    // Wait for Docker daemon to be ready
    for i in 0..30 {
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        
        if let Ok(output) = Command::new("docker").arg("ps").output() {
            if output.status.success() {
                return Ok(());
            }
        }
        
        if i == 29 {
            return Err("Docker daemon did not start within timeout".to_string());
        }
    }
    
    Ok(())
}

/// Configure Docker to use WSL2 backend
#[tauri::command]
pub async fn configure_docker_wsl2() -> Result<(), String> {
    // Docker Desktop should auto-detect and use WSL2 if available
    // This command ensures the configuration is correct
    
    let settings_path = dirs::home_dir()
        .ok_or("Could not find home directory")?
        .join("AppData")
        .join("Roaming")
        .join("Docker")
        .join("settings.json");
    
    if settings_path.exists() {
        // Read current settings
        let contents = std::fs::read_to_string(&settings_path)
            .map_err(|e| format!("Failed to read Docker settings: {}", e))?;
        
        let mut settings: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse Docker settings: {}", e))?;
        
        // Ensure WSL2 backend is enabled
        if let Some(obj) = settings.as_object_mut() {
            obj.insert("wslEngineEnabled".to_string(), serde_json::Value::Bool(true));
            obj.insert("useWsl2".to_string(), serde_json::Value::Bool(true));
        }
        
        // Write updated settings
        let updated = serde_json::to_string_pretty(&settings)
            .map_err(|e| format!("Failed to serialize settings: {}", e))?;
        
        std::fs::write(&settings_path, updated)
            .map_err(|e| format!("Failed to write Docker settings: {}", e))?;
    }
    
    Ok(())
}

fn emit_progress(app: &AppHandle, step: &str, progress: u8, status: InstallStatus, message: &str) {
    let _ = app.emit("install-progress", InstallProgress {
        step: step.to_string(),
        progress,
        status,
        message: message.to_string(),
    });
}

// Re-export dirs crate for home directory access
use dirs;
