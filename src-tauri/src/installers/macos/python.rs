use std::process::Command;
use tauri::AppHandle;

use super::super::{InstallProgress, InstallStatus};

/// Install headless Python 3.12.1 on macOS
#[tauri::command]
pub async fn install_python_macos(app: AppHandle) -> Result<(), String> {
    emit_progress(&app, "Installing Python 3.12", 30, InstallStatus::InProgress,
        "Installing Python 3.12 via Homebrew...");
    
    // Install Python 3.12 using Homebrew
    let install = Command::new("brew")
        .args(&["install", "python@3.12"])
        .output()
        .map_err(|e| format!("Failed to install Python: {}", e))?;
    
    if !install.status.success() {
        let stderr = String::from_utf8_lossy(&install.stderr);
        return Err(format!("Python installation failed: {}", stderr));
    }
    
    emit_progress(&app, "Creating virtual environment", 60, InstallStatus::InProgress,
        "Creating isolated Python virtual environment...");
    
    // Create virtual environment directory
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".to_string());
    let venv_path = format!("{}/.ci-hub-venv", home);
    
    // Create virtual environment
    let create_venv = Command::new("python3.12")
        .args(&["-m", "venv", &venv_path])
        .output()
        .map_err(|e| format!("Failed to create venv: {}", e))?;
    
    if !create_venv.status.success() {
        return Err("Failed to create virtual environment".to_string());
    }
    
    emit_progress(&app, "Installing pip packages", 80, InstallStatus::InProgress,
        "Installing essential Python packages...");
    
    // Upgrade pip in the virtual environment
    let pip_path = format!("{}/bin/pip", venv_path);
    let upgrade_pip = Command::new(&pip_path)
        .args(&["install", "--upgrade", "pip", "setuptools", "wheel"])
        .output()
        .map_err(|e| format!("Failed to upgrade pip: {}", e))?;
    
    if !upgrade_pip.status.success() {
        return Err("Failed to upgrade pip".to_string());
    }
    
    emit_progress(&app, "Python Installation Complete", 100, InstallStatus::Complete,
        "Python 3.12.1 environment installed successfully");
    
    Ok(())
}

/// Check Python version on macOS
#[tauri::command]
pub async fn check_python_version_macos() -> Result<String, String> {
    let output = Command::new("python3.12")
        .args(&["--version"])
        .output()
        .map_err(|e| format!("Failed to check Python version: {}", e))?;
    
    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout);
        Ok(version.trim().to_string())
    } else {
        Err("Python 3.12 not found".to_string())
    }
}

/// Configure Python environment for headless operation (no GUI dependencies)
#[tauri::command]
pub async fn configure_headless_python() -> Result<(), String> {
    // Set environment variables to prevent GUI dependencies
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users".to_string());
    let venv_path = format!("{}/.ci-hub-venv", home);
    let activate_script = format!("{}/bin/activate", venv_path);
    
    // Read the activation script
    let mut content = std::fs::read_to_string(&activate_script)
        .map_err(|e| format!("Failed to read activation script: {}", e))?;
    
    // Add headless environment variables
    let headless_config = r#"
# Headless Python configuration
export MPLBACKEND=Agg
export DISPLAY=
"#;
    
    if !content.contains("MPLBACKEND") {
        content.push_str(headless_config);
        std::fs::write(&activate_script, content)
            .map_err(|e| format!("Failed to update activation script: {}", e))?;
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
