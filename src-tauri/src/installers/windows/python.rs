use std::process::Command;
use tauri::AppHandle;

use super::super::{InstallProgress, InstallStatus};

/// Install Python 3.12.1 in WSL2 Ubuntu
#[tauri::command]
pub async fn install_python_wsl2(app: AppHandle) -> Result<(), String> {
    emit_progress(&app, "Adding Python repository", 10, InstallStatus::InProgress,
        "Adding deadsnakes PPA for Python 3.12...");
    
    // Add deadsnakes PPA for Python 3.12
    let add_ppa = Command::new("wsl")
        .args(&[
            "-d", "Ubuntu-22.04", "--", "sudo", "add-apt-repository", "-y", "ppa:deadsnakes/ppa"
        ])
        .output()
        .map_err(|e| format!("Failed to add PPA: {}", e))?;
    
    if !add_ppa.status.success() {
        return Err("Failed to add Python PPA".to_string());
    }
    
    emit_progress(&app, "Updating package lists", 30, InstallStatus::InProgress,
        "Updating package lists...");
    
    // Update package lists
    let update = Command::new("wsl")
        .args(&["-d", "Ubuntu-22.04", "--", "sudo", "apt-get", "update"])
        .output()
        .map_err(|e| format!("Failed to update packages: {}", e))?;
    
    if !update.status.success() {
        return Err("Failed to update package lists".to_string());
    }
    
    emit_progress(&app, "Installing Python 3.12.1", 50, InstallStatus::InProgress,
        "Installing Python 3.12 and dependencies...");
    
    // Install Python 3.12 and essential packages
    let install = Command::new("wsl")
        .args(&[
            "-d", "Ubuntu-22.04", "--", "sudo", "apt-get", "install", "-y",
            "python3.12", "python3.12-venv", "python3.12-dev", "python3-pip"
        ])
        .output()
        .map_err(|e| format!("Failed to install Python: {}", e))?;
    
    if !install.status.success() {
        return Err("Failed to install Python 3.12".to_string());
    }
    
    emit_progress(&app, "Creating virtual environment", 80, InstallStatus::InProgress,
        "Creating Python virtual environment...");
    
    // Create virtual environment in a standard location
    let venv_path = "/home/$USER/.ci-hub-venv";
    let create_venv = Command::new("wsl")
        .args(&[
            "-d", "Ubuntu-22.04", "--", "python3.12", "-m", "venv", venv_path
        ])
        .output()
        .map_err(|e| format!("Failed to create venv: {}", e))?;
    
    if !create_venv.status.success() {
        return Err("Failed to create virtual environment".to_string());
    }
    
    emit_progress(&app, "Installing pip packages", 90, InstallStatus::InProgress,
        "Installing essential Python packages...");
    
    // Upgrade pip in the virtual environment
    let _ = Command::new("wsl")
        .args(&[
            "-d", "Ubuntu-22.04", "--", "bash", "-c",
            &format!("source {}/bin/activate && pip install --upgrade pip setuptools wheel", venv_path)
        ])
        .output();
    
    emit_progress(&app, "Python Installation Complete", 100, InstallStatus::Complete,
        "Python 3.12.1 environment installed successfully");
    
    Ok(())
}

/// Check Python version in WSL2
#[tauri::command]
pub async fn check_python_version_wsl2() -> Result<String, String> {
    let output = Command::new("wsl")
        .args(&["-d", "Ubuntu-22.04", "--", "python3.12", "--version"])
        .output()
        .map_err(|e| format!("Failed to check Python version: {}", e))?;
    
    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout);
        Ok(version.trim().to_string())
    } else {
        Err("Python 3.12 not found in WSL2".to_string())
    }
}

fn emit_progress(app: &AppHandle, step: &str, progress: u8, status: InstallStatus, message: &str) {
    let _ = app.emit("install-progress", InstallProgress {
        step: step.to_string(),
        progress,
        status,
        message: message.to_string(),
    });
}
