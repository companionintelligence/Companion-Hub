use std::process::Command;
use tauri::AppHandle;

use super::super::{InstallProgress, InstallStatus};

/// Install Colima and Lima for container runtime
#[tauri::command]
pub async fn install_colima(app: AppHandle) -> Result<(), String> {
    emit_progress(&app, "Installing Lima", 20, InstallStatus::InProgress,
        "Installing Lima virtualization framework...");
    
    // Install Lima first
    let install_lima = Command::new("brew")
        .args(&["install", "lima"])
        .output()
        .map_err(|e| format!("Failed to install Lima: {}", e))?;
    
    if !install_lima.status.success() {
        return Err("Failed to install Lima".to_string());
    }
    
    emit_progress(&app, "Installing Colima", 40, InstallStatus::InProgress,
        "Installing Colima container runtime...");
    
    // Install Colima
    let install_colima = Command::new("brew")
        .args(&["install", "colima"])
        .output()
        .map_err(|e| format!("Failed to install Colima: {}", e))?;
    
    if !install_colima.status.success() {
        return Err("Failed to install Colima".to_string());
    }
    
    emit_progress(&app, "Installing Docker CLI", 60, InstallStatus::InProgress,
        "Installing Docker command-line tools...");
    
    // Install Docker CLI
    let install_docker = Command::new("brew")
        .args(&["install", "docker"])
        .output()
        .map_err(|e| format!("Failed to install Docker CLI: {}", e))?;
    
    if !install_docker.status.success() {
        return Err("Failed to install Docker CLI".to_string());
    }
    
    emit_progress(&app, "Installing Docker Compose", 80, InstallStatus::InProgress,
        "Installing Docker Compose...");
    
    // Install Docker Compose
    let install_compose = Command::new("brew")
        .args(&["install", "docker-compose"])
        .output()
        .map_err(|e| format!("Failed to install Docker Compose: {}", e))?;
    
    if !install_compose.status.success() {
        return Err("Failed to install Docker Compose".to_string());
    }
    
    emit_progress(&app, "Colima Installation Complete", 100, InstallStatus::Complete,
        "Colima and Docker tools installed successfully");
    
    Ok(())
}

/// Start Colima with appropriate configuration
#[tauri::command]
pub async fn start_colima(app: AppHandle) -> Result<(), String> {
    emit_progress(&app, "Starting Colima", 50, InstallStatus::InProgress,
        "Starting Colima with Docker runtime...");
    
    // Determine CPU and memory allocation based on system
    let cpus = num_cpus::get().min(4); // Use up to 4 CPUs
    let memory = 4; // 4GB memory
    
    // Start Colima with configuration
    let start = Command::new("colima")
        .args(&[
            "start",
            "--cpu", &cpus.to_string(),
            "--memory", &memory.to_string(),
            "--disk", "60",
            "--runtime", "docker",
            "--arch", if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" }
        ])
        .output()
        .map_err(|e| format!("Failed to start Colima: {}", e))?;
    
    if !start.status.success() {
        let stderr = String::from_utf8_lossy(&start.stderr);
        return Err(format!("Failed to start Colima: {}", stderr));
    }
    
    emit_progress(&app, "Colima Started", 100, InstallStatus::Complete,
        "Colima is running and ready");
    
    Ok(())
}

/// Stop Colima
#[tauri::command]
pub async fn stop_colima() -> Result<(), String> {
    let stop = Command::new("colima")
        .args(&["stop"])
        .output()
        .map_err(|e| format!("Failed to stop Colima: {}", e))?;
    
    if !stop.status.success() {
        return Err("Failed to stop Colima".to_string());
    }
    
    Ok(())
}

/// Restart Colima
#[tauri::command]
pub async fn restart_colima(app: AppHandle) -> Result<(), String> {
    stop_colima().await?;
    
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    
    start_colima(app).await
}

fn emit_progress(app: &AppHandle, step: &str, progress: u8, status: InstallStatus, message: &str) {
    let _ = app.emit("install-progress", InstallProgress {
        step: step.to_string(),
        progress,
        status,
        message: message.to_string(),
    });
}

// Add num_cpus dependency for CPU detection
use num_cpus;
