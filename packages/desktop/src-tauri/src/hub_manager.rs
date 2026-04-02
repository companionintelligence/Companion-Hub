use std::path::{Path, PathBuf};
use std::process::Command;

/// Paths used by the Hub manager, stored in Tauri app state.
pub struct HubPaths {
    pub data_dir: PathBuf,
    pub compose_path: PathBuf,
    pub env_path: PathBuf,
}

#[derive(Clone, serde::Serialize)]
pub enum HubStatus {
    DockerNotAvailable,
    Stopped,
    Starting,
    Running,
    Error { message: String },
}

/// Get the current status of the Hub by inspecting the Docker container.
pub fn get_hub_status() -> HubStatus {
    if !is_docker_available() {
        return HubStatus::DockerNotAvailable;
    }

    // Check ci-os-hub container specifically
    let status = Command::new("docker")
        .args([
            "inspect",
            "--format",
            "{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
            "ci-os-hub",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    if status.is_empty() || status.contains("No such object") || status.contains("Error") {
        return HubStatus::Stopped;
    }

    let parts: Vec<&str> = status.split(':').collect();
    let state = parts.first().copied().unwrap_or("");
    let health = parts.get(1).copied().unwrap_or("");

    match (state, health) {
        ("running", "healthy") => HubStatus::Running,
        ("running", _) => HubStatus::Starting,
        ("restarting", _) => HubStatus::Error {
            message: "Container is restarting — check Docker logs".to_string(),
        },
        ("created", _) | ("exited", _) => HubStatus::Stopped,
        _ => HubStatus::Starting,
    }
}

/// Get the Hub data directory (platform-specific)
pub fn get_hub_data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("companion-hub")
}

/// Check if Docker is available
pub fn is_docker_available() -> bool {
    Command::new("docker")
        .arg("info")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if Hub containers exist (stopped or running)
pub fn hub_containers_exist() -> bool {
    Command::new("docker")
        .args(["ps", "-a", "--filter", "name=ci-os-hub", "--format", "{{.Names}}"])
        .output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

/// Start Hub using docker compose up
pub fn start_hub(compose_path: &Path, env_path: &Path, data_dir: &Path) -> Result<String, String> {
    let output = Command::new("docker")
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "up",
            "-d",
        ])
        .env("ROOT_FOLDER_HOST", data_dir.to_string_lossy().to_string())
        .output()
        .map_err(|e| format!("Failed to run docker compose: {}", e))?;

    if output.status.success() {
        Ok("Hub started successfully".to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Stop Hub containers
pub fn stop_hub(compose_path: &Path, env_path: &Path) -> Result<String, String> {
    let output = Command::new("docker")
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "down",
        ])
        .output()
        .map_err(|e| format!("Failed to stop hub: {}", e))?;

    if output.status.success() {
        Ok("Hub stopped".to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Initialize Hub data directory and .env file
pub fn initialize_hub(resource_dir: &Path) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let data_dir = get_hub_data_dir();

    // Create data subdirectories
    let subdirs = [
        "state", "repos", "apps", "logs", "media", "user-config", "app-data", "backups", "cache",
    ];
    for sub in subdirs {
        std::fs::create_dir_all(data_dir.join(sub))
            .map_err(|e| format!("Failed to create {}: {}", sub, e))?;
    }

    // Copy docker-compose.prod.yml from resources
    // Try multiple candidate paths — Tauri resource dir varies by platform and install method
    let compose_candidates = [
        resource_dir.join("docker-compose.prod.yml"),
        resource_dir.join("resources").join("docker-compose.prod.yml"),
        // For dev builds, try relative to executable
        std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .unwrap_or(Path::new("."))
            .join("resources")
            .join("docker-compose.prod.yml"),
    ];

    // Log candidate paths for debugging
    let log_path = data_dir.join("logs").join("init.log");
    let mut log_lines = vec![format!(
        "[{}] initialize_hub: resource_dir = {:?}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        resource_dir
    )];
    for (i, candidate) in compose_candidates.iter().enumerate() {
        log_lines.push(format!(
            "  candidate[{}]: {:?} exists={}",
            i,
            candidate,
            candidate.exists()
        ));
    }

    let compose_src = compose_candidates.iter().find(|p| p.exists());
    let compose_dst = data_dir.join("docker-compose.prod.yml");

    if let Some(src) = compose_src {
        log_lines.push(format!("  -> using: {:?}", src));
        if !compose_dst.exists() {
            std::fs::copy(src, &compose_dst)
                .map_err(|e| format!("Failed to copy compose file: {}", e))?;
            log_lines.push("  -> copied to data_dir".to_string());
        } else {
            // Always update compose file in case it changed
            std::fs::copy(src, &compose_dst)
                .map_err(|e| format!("Failed to update compose file: {}", e))?;
            log_lines.push("  -> updated in data_dir".to_string());
        }
    } else {
        log_lines.push("  -> WARNING: no compose file found in any candidate path!".to_string());
    }

    // Write init log (append)
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            use std::io::Write;
            writeln!(f, "{}", log_lines.join("\n"))
        });

    // Generate .env if it doesn't exist
    let env_path = data_dir.join(".env");
    if !env_path.exists() {
        let secret: String = (0..64)
            .map(|_| format!("{:02x}", rand::random::<u8>()))
            .collect();

        // On Windows with Docker Desktop, use /c/Users/... Linux-style path
        let data_dir_str = if cfg!(windows) {
            let path = data_dir.to_string_lossy().to_string();
            if path.len() >= 2 && path.chars().nth(1) == Some(':') {
                let drive = path.chars().next().unwrap().to_lowercase().to_string();
                format!("/{}{}", drive, path[2..].replace('\\', "/"))
            } else {
                path.replace('\\', "/")
            }
        } else {
            data_dir.to_string_lossy().to_string()
        };

        let env_content = format!(
            "ROOT_FOLDER_HOST={data_dir}\n\
             POSTGRES_PASSWORD=companion-hub-local\n\
             JWT_SECRET={secret}\n\
             INTERNAL_IP=0.0.0.0\n\
             DOMAIN=companionintelligence.com\n\
             CI_CLOUD_URL=https://portal.companionintelligence.com\n\
             CI_HUB_VERSION=0.1.0\n\
             LOG_LEVEL=info\n\
             LOCAL=false\n\
             NODE_ENV=production\n\
             EXPERIMENTAL_INSECURE_COOKIE=true\n\
             ENV_FILE=.env\n",
            data_dir = data_dir_str,
            secret = secret,
        );

        std::fs::write(&env_path, env_content)
            .map_err(|e| format!("Failed to write .env: {}", e))?;
    }

    Ok((data_dir, compose_dst, env_path))
}
