use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PrerequisiteStatus {
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

// Windows Prerequisites

#[tauri::command]
pub async fn check_wsl2_installed() -> Result<PrerequisiteStatus, String> {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("wsl")
            .arg("--status")
            .output();
        
        match output {
            Ok(output) => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                let stderr = String::from_utf8_lossy(&output.stderr);
                
                // Check if WSL2 is installed and is the default version
                let installed = output.status.success() 
                    && (stdout.contains("Default Version: 2") || stdout.contains("WSL 2"));
                
                let version = if installed {
                    Some("2".to_string())
                } else if stdout.contains("Default Version: 1") {
                    Some("1 (upgrade to 2 required)".to_string())
                } else {
                    None
                };
                
                Ok(PrerequisiteStatus {
                    name: "WSL2".to_string(),
                    installed,
                    version,
                    path: if installed { Some("wsl".to_string()) } else { None },
                })
            }
            Err(_) => Ok(PrerequisiteStatus {
                name: "WSL2".to_string(),
                installed: false,
                version: None,
                path: None,
            }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(PrerequisiteStatus {
            name: "WSL2".to_string(),
            installed: false,
            version: None,
            path: None,
        })
    }
}

#[tauri::command]
pub async fn check_docker_installed() -> Result<PrerequisiteStatus, String> {
    // Check if docker command is available
    let docker_path = which::which("docker").ok();
    
    if let Some(path) = &docker_path {
        // Try to get docker version
        if let Ok(output) = Command::new("docker")
            .arg("--version")
            .output()
        {
            let version_str = String::from_utf8_lossy(&output.stdout);
            let version = version_str
                .split_whitespace()
                .nth(2)
                .map(|v| v.trim_end_matches(',').to_string());
            
            // Check if Docker daemon is running
            let daemon_running = Command::new("docker")
                .arg("ps")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            
            Ok(PrerequisiteStatus {
                name: "Docker".to_string(),
                installed: daemon_running,
                version,
                path: Some(path.to_string_lossy().to_string()),
            })
        } else {
            Ok(PrerequisiteStatus {
                name: "Docker".to_string(),
                installed: false,
                version: None,
                path: Some(path.to_string_lossy().to_string()),
            })
        }
    } else {
        Ok(PrerequisiteStatus {
            name: "Docker".to_string(),
            installed: false,
            version: None,
            path: None,
        })
    }
}

// macOS Prerequisites

#[tauri::command]
pub async fn check_xcode_tools() -> Result<PrerequisiteStatus, String> {
    #[cfg(target_os = "macos")]
    {
        // Check if xcode-select is installed
        let output = Command::new("xcode-select")
            .arg("-p")
            .output();
        
        match output {
            Ok(output) => {
                let installed = output.status.success();
                let path = if installed {
                    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
                } else {
                    None
                };
                
                // Try to get version
                let version = if installed {
                    Command::new("xcode-select")
                        .arg("--version")
                        .output()
                        .ok()
                        .and_then(|o| {
                            let v = String::from_utf8_lossy(&o.stdout);
                            v.split_whitespace().last().map(|s| s.to_string())
                        })
                } else {
                    None
                };
                
                Ok(PrerequisiteStatus {
                    name: "Xcode Command Line Tools".to_string(),
                    installed,
                    version,
                    path,
                })
            }
            Err(_) => Ok(PrerequisiteStatus {
                name: "Xcode Command Line Tools".to_string(),
                installed: false,
                version: None,
                path: None,
            }),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(PrerequisiteStatus {
            name: "Xcode Command Line Tools".to_string(),
            installed: false,
            version: None,
            path: None,
        })
    }
}

#[tauri::command]
pub async fn check_homebrew() -> Result<PrerequisiteStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let brew_path = which::which("brew").ok();
        
        if let Some(path) = &brew_path {
            // Try to get brew version
            let version = Command::new("brew")
                .arg("--version")
                .output()
                .ok()
                .and_then(|o| {
                    let v = String::from_utf8_lossy(&o.stdout);
                    v.lines()
                        .next()
                        .and_then(|line| line.split_whitespace().last())
                        .map(|s| s.to_string())
                });
            
            Ok(PrerequisiteStatus {
                name: "Homebrew".to_string(),
                installed: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
            })
        } else {
            Ok(PrerequisiteStatus {
                name: "Homebrew".to_string(),
                installed: false,
                version: None,
                path: None,
            })
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(PrerequisiteStatus {
            name: "Homebrew".to_string(),
            installed: false,
            version: None,
            path: None,
        })
    }
}

#[tauri::command]
pub async fn check_colima() -> Result<PrerequisiteStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let colima_path = which::which("colima").ok();
        
        if let Some(path) = &colima_path {
            // Try to get colima version
            let version = Command::new("colima")
                .arg("version")
                .output()
                .ok()
                .and_then(|o| {
                    let v = String::from_utf8_lossy(&o.stdout);
                    v.split_whitespace()
                        .last()
                        .map(|s| s.trim().to_string())
                });
            
            // Check if colima is running
            let running = Command::new("colima")
                .arg("status")
                .output()
                .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("running"))
                .unwrap_or(false);
            
            Ok(PrerequisiteStatus {
                name: "Colima".to_string(),
                installed: running,
                version,
                path: Some(path.to_string_lossy().to_string()),
            })
        } else {
            Ok(PrerequisiteStatus {
                name: "Colima".to_string(),
                installed: false,
                version: None,
                path: None,
            })
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(PrerequisiteStatus {
            name: "Colima".to_string(),
            installed: false,
            version: None,
            path: None,
        })
    }
}

#[tauri::command]
pub async fn check_python_installed() -> Result<PrerequisiteStatus, String> {
    // Try python3 first, then python
    let python_cmd = if which::which("python3").is_ok() {
        "python3"
    } else {
        "python"
    };
    
    let python_path = which::which(python_cmd).ok();
    
    if let Some(path) = &python_path {
        // Try to get python version
        let version = Command::new(python_cmd)
            .arg("--version")
            .output()
            .ok()
            .and_then(|o| {
                let v = String::from_utf8_lossy(&o.stdout);
                v.split_whitespace()
                    .nth(1)
                    .map(|s| s.to_string())
            });
        
        // Check if it's Python 3.x
        let is_python3 = version
            .as_ref()
            .map(|v| v.starts_with("3."))
            .unwrap_or(false);
        
        Ok(PrerequisiteStatus {
            name: "Python".to_string(),
            installed: is_python3,
            version,
            path: Some(path.to_string_lossy().to_string()),
        })
    } else {
        Ok(PrerequisiteStatus {
            name: "Python".to_string(),
            installed: false,
            version: None,
            path: None,
        })
    }
}

#[tauri::command]
pub async fn check_all_prerequisites() -> Result<Vec<PrerequisiteStatus>, String> {
    let mut prerequisites = Vec::new();
    
    // Check platform-specific prerequisites
    #[cfg(target_os = "windows")]
    {
        prerequisites.push(check_wsl2_installed().await?);
    }
    
    #[cfg(target_os = "macos")]
    {
        prerequisites.push(check_xcode_tools().await?);
        prerequisites.push(check_homebrew().await?);
        prerequisites.push(check_colima().await?);
    }
    
    // Check common prerequisites
    prerequisites.push(check_docker_installed().await?);
    prerequisites.push(check_python_installed().await?);
    
    Ok(prerequisites)
}
