use serde::{Deserialize, Serialize};
use std::process::Command;
use tauri::AppHandle;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct InstallProgress {
    pub step: String,
    pub progress: u8, // 0-100
    pub status: InstallStatus,
    pub message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub enum InstallStatus {
    Pending,
    InProgress,
    Complete,
    Failed,
    Skipped,
}

/// Install WSL2 and Ubuntu 22.04
#[tauri::command]
pub async fn install_wsl2(app: AppHandle) -> Result<(), String> {
    emit_progress(&app, "Enabling WSL feature", 10, InstallStatus::InProgress, 
        "Enabling Windows Subsystem for Linux feature...");
    
    // Enable WSL and Virtual Machine Platform features
    let enable_wsl = Command::new("powershell")
        .args(&[
            "-Command",
            "dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart"
        ])
        .output();
    
    if let Err(e) = enable_wsl {
        return Err(format!("Failed to enable WSL feature: {}", e));
    }
    
    emit_progress(&app, "Enabling Virtual Machine Platform", 30, InstallStatus::InProgress,
        "Enabling Virtual Machine Platform feature...");
    
    let enable_vm = Command::new("powershell")
        .args(&[
            "-Command",
            "dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart"
        ])
        .output();
    
    if let Err(e) = enable_vm {
        return Err(format!("Failed to enable VM Platform: {}", e));
    }
    
    emit_progress(&app, "Setting WSL2 as default", 50, InstallStatus::InProgress,
        "Setting WSL version 2 as default...");
    
    // Set WSL2 as default
    let _ = Command::new("wsl")
        .args(&["--set-default-version", "2"])
        .output();
    
    emit_progress(&app, "Installing Ubuntu 22.04", 70, InstallStatus::InProgress,
        "Installing Ubuntu 22.04 LTS distribution...");
    
    // Install Ubuntu 22.04
    let install_ubuntu = Command::new("wsl")
        .args(&["--install", "--distribution", "Ubuntu-22.04"])
        .output();
    
    if let Err(e) = install_ubuntu {
        return Err(format!("Failed to install Ubuntu: {}", e));
    }
    
    emit_progress(&app, "WSL2 Installation Complete", 100, InstallStatus::Complete,
        "WSL2 and Ubuntu 22.04 installed successfully. A system restart may be required.");
    
    Ok(())
}

/// Check if WSL2 needs a system restart to complete installation
#[tauri::command]
pub async fn check_wsl2_restart_required() -> Result<bool, String> {
    // Check if WSL features are pending reboot
    let output = Command::new("powershell")
        .args(&[
            "-Command",
            "Get-WindowsOptionalFeature -Online | Where-Object {$_.FeatureName -like '*WSL*' -or $_.FeatureName -like '*VirtualMachine*'} | Select-Object -ExpandProperty State"
        ])
        .output()
        .map_err(|e| e.to_string())?;
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.contains("EnablePending"))
}

/// Configure WSL2 Ubuntu environment
#[tauri::command]
pub async fn configure_wsl2_ubuntu(app: AppHandle) -> Result<(), String> {
    emit_progress(&app, "Configuring Ubuntu", 20, InstallStatus::InProgress,
        "Updating Ubuntu package lists...");
    
    // Update package lists
    let update = Command::new("wsl")
        .args(&["-d", "Ubuntu-22.04", "--", "sudo", "apt-get", "update"])
        .output()
        .map_err(|e| format!("Failed to update packages: {}", e))?;
    
    if !update.status.success() {
        return Err("Failed to update Ubuntu packages".to_string());
    }
    
    emit_progress(&app, "Installing dependencies", 50, InstallStatus::InProgress,
        "Installing essential packages...");
    
    // Install essential packages
    let install = Command::new("wsl")
        .args(&[
            "-d", "Ubuntu-22.04", "--", "sudo", "apt-get", "install", "-y",
            "ca-certificates", "curl", "gnupg", "lsb-release", "build-essential"
        ])
        .output()
        .map_err(|e| format!("Failed to install packages: {}", e))?;
    
    if !install.status.success() {
        return Err("Failed to install essential packages".to_string());
    }
    
    emit_progress(&app, "Configuration Complete", 100, InstallStatus::Complete,
        "Ubuntu environment configured successfully");
    
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
