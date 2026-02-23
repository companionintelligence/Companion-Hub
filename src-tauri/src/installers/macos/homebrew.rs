use std::process::Command;
use tauri::AppHandle;

use super::super::{InstallProgress, InstallStatus};

/// Install Homebrew package manager
#[tauri::command]
pub async fn install_homebrew(app: AppHandle) -> Result<(), String> {
    emit_progress(&app, "Downloading Homebrew", 20, InstallStatus::InProgress,
        "Downloading Homebrew installation script...");
    
    // Download and run Homebrew install script
    let install_script = r#"/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)""#;
    
    let output = Command::new("bash")
        .args(&["-c", install_script])
        .output()
        .map_err(|e| format!("Failed to install Homebrew: {}", e))?;
    
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Homebrew installation failed: {}", stderr));
    }
    
    emit_progress(&app, "Configuring PATH", 80, InstallStatus::InProgress,
        "Adding Homebrew to PATH...");
    
    // Add Homebrew to shell profile
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".to_string());
    let profile_path = format!("{}/.zprofile", home);
    
    // Determine the correct Homebrew path based on architecture
    let brew_path = if cfg!(target_arch = "aarch64") {
        "/opt/homebrew/bin/brew"
    } else {
        "/usr/local/bin/brew"
    };
    
    let shell_config = format!("\n# Homebrew\neval \"$({} shellenv)\"\n", brew_path);
    
    if let Ok(mut current_content) = std::fs::read_to_string(&profile_path) {
        if !current_content.contains("brew shellenv") {
            current_content.push_str(&shell_config);
            let _ = std::fs::write(&profile_path, current_content);
        }
    } else {
        let _ = std::fs::write(&profile_path, shell_config);
    }
    
    emit_progress(&app, "Homebrew Installation Complete", 100, InstallStatus::Complete,
        "Homebrew installed successfully");
    
    Ok(())
}

/// Update Homebrew
#[tauri::command]
pub async fn update_homebrew() -> Result<(), String> {
    let output = Command::new("brew")
        .args(&["update"])
        .output()
        .map_err(|e| format!("Failed to update Homebrew: {}", e))?;
    
    if !output.status.success() {
        return Err("Failed to update Homebrew".to_string());
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
