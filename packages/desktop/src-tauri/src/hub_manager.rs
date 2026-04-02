use std::path::{Path, PathBuf};
use std::process::Command;

/// Paths used by the Hub manager, stored in Tauri app state.
pub struct HubPaths {
    pub data_dir: PathBuf,
    pub compose_path: PathBuf,
    pub env_path: PathBuf,
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
    let compose_src = resource_dir.join("docker-compose.prod.yml");
    let compose_dst = data_dir.join("docker-compose.prod.yml");
    if compose_src.exists() && !compose_dst.exists() {
        std::fs::copy(&compose_src, &compose_dst)
            .map_err(|e| format!("Failed to copy compose file: {}", e))?;
    }

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
