use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub fn docker_command() -> Command {
    let docker_path = find_docker_binary();
    let mut cmd = Command::new(docker_path);
    // Ensure common binary paths are in PATH for subprocesses (e.g. docker compose)
    if let Ok(current_path) = std::env::var("PATH") {
        let extra_paths = if cfg!(target_os = "macos") {
            "/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"
        } else if cfg!(target_os = "windows") {
            ""
        } else {
            "/usr/local/bin:/usr/bin"
        };
        if !extra_paths.is_empty() {
            cmd.env("PATH", format!("{}:{}", extra_paths, current_path));
        }
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Find the Docker binary, checking common install locations if not in PATH.
fn find_docker_binary() -> PathBuf {
    // Try PATH first
    if let Ok(output) = Command::new("which").arg("docker").output() {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() && output.status.success() {
            return PathBuf::from(path);
        }
    }

    // Common macOS locations
    #[cfg(target_os = "macos")]
    {
        let candidates = [
            "/usr/local/bin/docker",
            "/opt/homebrew/bin/docker",
            "/Applications/Docker.app/Contents/Resources/bin/docker",
        ];
        for candidate in candidates {
            if std::path::Path::new(candidate).exists() {
                return PathBuf::from(candidate);
            }
        }
    }

    // Common Linux locations
    #[cfg(target_os = "linux")]
    {
        let candidates = [
            "/usr/local/bin/docker",
            "/usr/bin/docker",
            "/snap/bin/docker",
        ];
        for candidate in candidates {
            if std::path::Path::new(candidate).exists() {
                return PathBuf::from(candidate);
            }
        }
    }

    // Fallback — hope it's in PATH
    PathBuf::from("docker")
}

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
    let status = docker_command()
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
        ("restarting", _) => {
            // Check if database is still starting — if so, Hub restart is expected
            let db_status = docker_command()
                .args(["inspect", "--format", "{{.State.Health.Status}}", "ci-hub-db"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();

            if db_status != "healthy" {
                HubStatus::Starting // DB not ready yet, Hub restart is expected
            } else {
                // DB is healthy but Hub is still restarting — might be a real error
                let restart_count = docker_command()
                    .args(["inspect", "--format", "{{.RestartCount}}", "ci-os-hub"])
                    .output()
                    .map(|o| {
                        String::from_utf8_lossy(&o.stdout)
                            .trim()
                            .parse::<u32>()
                            .unwrap_or(0)
                    })
                    .unwrap_or(0);

                if restart_count <= 3 {
                    HubStatus::Starting
                } else {
                    HubStatus::Error {
                        message: format!(
                            "Hub has restarted {} times. Check Docker logs for details.",
                            restart_count
                        ),
                    }
                }
            }
        }
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
    docker_command()
        .arg("info")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if Hub containers exist (stopped or running)
pub fn hub_containers_exist() -> bool {
    docker_command()
        .args(["ps", "-a", "--filter", "name=ci-os-hub", "--format", "{{.Names}}"])
        .output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

/// Start Hub using docker compose up (with port conflict resolution)
pub fn start_hub(compose_path: &Path, env_path: &Path, _data_dir: &Path) -> Result<String, String> {
    // Resolve port conflicts and write to .env before starting
    let resolution = crate::port_manager::refresh_ports_if_needed(env_path)?;

    // Log warnings and info
    let log_path = _data_dir.join("logs").join("port-resolution.log");
    let mut log_lines = vec![format!(
        "[{}] Port resolution:",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
    )];
    for w in &resolution.warnings {
        log_lines.push(format!("  WARN: {}", w));
    }
    for i in &resolution.info {
        log_lines.push(format!("  INFO: {}", i));
    }
    for (var, port) in &resolution.env_vars {
        log_lines.push(format!("  {}={}", var, port));
    }
    let _ = std::fs::write(&log_path, log_lines.join("\n") + "\n");

    let output = docker_command()
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
    let output = docker_command()
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
    let domain = option_env!("CI_HUB_DOMAIN").unwrap_or("companionintelligence.com");
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

        let cloud_url = option_env!("CI_HUB_CLOUD_URL").unwrap_or("https://portal.companionintelligence.com");
        let hub_version = option_env!("CI_HUB_BUILD_VERSION").unwrap_or("4.7.0");
        
        // Hub container image from GHCR — tag matches the target environment
        let hub_image = match domain {
            "ci.computer" => "ghcr.io/companionintelligence/ci-hub:latest",
            "companionintel.com" => "ghcr.io/companionintelligence/ci-hub:staging",
            "companionintelligence.com" => "ghcr.io/companionintelligence/ci-hub:dev",
            _ => "ghcr.io/companionintelligence/ci-hub:dev",
        }.to_string();

        // Generate a clean Docker config for the Hub container.
        // We can't mount the host's ~/.docker/config.json because Docker Desktop
        // sets "currentContext": "desktop-linux" and "credsStore": "desktop" which
        // don't exist inside the container, causing app installs to fail with:
        // "unable to resolve docker endpoint: context desktop-linux not found"
        let container_docker_config = data_dir.join(".docker-config.json");
        if !container_docker_config.exists() {
            let _ = std::fs::write(&container_docker_config, "{}\n");
        }
        let docker_config_path = container_docker_config.to_string_lossy().to_string();

        // Detect host architecture for Docker platform selection
        let docker_platform = if cfg!(target_arch = "aarch64") {
            "linux/arm64"
        } else {
            "linux/amd64"
        };

        let env_content = format!(
            "ROOT_FOLDER_HOST={data_dir}\n\
             POSTGRES_PASSWORD=postgres\n\
             JWT_SECRET={secret}\n\
             INTERNAL_IP=0.0.0.0\n\
             DOMAIN={domain}\n\
             CI_CLOUD_URL={cloud_url}\n\
             CI_HUB_VERSION={hub_version}\n\
             CI_HUB_IMAGE={hub_image}\n\
             DOCKER_CONFIG_PATH={docker_config_path}\n\
             DOCKER_PLATFORM={docker_platform}\n\
             LOG_LEVEL=info\n\
             LOCAL=false\n\
             NODE_ENV=production\n\
             EXPERIMENTAL_INSECURE_COOKIE=true\n\
             ENV_FILE=.env\n",
            data_dir = data_dir_str,
            secret = secret,
            domain = domain,
            cloud_url = cloud_url,
            hub_version = hub_version,
            hub_image = hub_image,
            docker_config_path = docker_config_path,
            docker_platform = docker_platform,
        );

        std::fs::write(&env_path, env_content)
            .map_err(|e| format!("Failed to write .env: {}", e))?;
    } else {
        // Existing .env — ensure CI_HUB_IMAGE is present (upgrades from older versions)
        let existing = std::fs::read_to_string(&env_path).unwrap_or_default();
        // Ensure DOCKER_CONFIG_PATH points to our clean config (upgrades from older versions)
        let container_docker_config = data_dir.join(".docker-config.json");
        if !container_docker_config.exists() {
            let _ = std::fs::write(&container_docker_config, "{}\n");
        }
        let clean_docker_config = container_docker_config.to_string_lossy().to_string();
        if !existing.contains("DOCKER_CONFIG_PATH=") {
            let append = format!("DOCKER_CONFIG_PATH={}\n", clean_docker_config);
            let mut file = std::fs::OpenOptions::new().append(true).open(&env_path)
                .map_err(|e| format!("Failed to append to .env: {}", e))?;
            std::io::Write::write_all(&mut file, append.as_bytes())
                .map_err(|e| format!("Failed to write DOCKER_CONFIG_PATH: {}", e))?;
        } else {
            // Always overwrite DOCKER_CONFIG_PATH to the clean config — the host's
            // ~/.docker/config.json contains Docker Desktop context/credential settings
            // that break inside the container.
            let fixed_lines: Vec<String> = existing.lines().map(|l| {
                if l.starts_with("DOCKER_CONFIG_PATH=") {
                    format!("DOCKER_CONFIG_PATH={}", clean_docker_config)
                } else {
                    l.to_string()
                }
            }).collect();
            let fixed = fixed_lines.join("\n") + "\n";
            if fixed != existing {
                std::fs::write(&env_path, fixed)
                    .map_err(|e| format!("Failed to fix DOCKER_CONFIG_PATH: {}", e))?;
            }
        }

        if !existing.contains("CI_HUB_IMAGE=") {
            let hub_image = match domain {
                "ci.computer" => "ghcr.io/companionintelligence/ci-hub:latest",
                "companionintel.com" => "ghcr.io/companionintelligence/ci-hub:staging",
                "companionintelligence.com" => "ghcr.io/companionintelligence/ci-hub:dev",
                _ => "ghcr.io/companionintelligence/ci-hub:dev",
            };
            let append = format!("CI_HUB_IMAGE={}\n", hub_image);
            let mut file = std::fs::OpenOptions::new().append(true).open(&env_path)
                .map_err(|e| format!("Failed to append to .env: {}", e))?;
            std::io::Write::write_all(&mut file, append.as_bytes())
                .map_err(|e| format!("Failed to write CI_HUB_IMAGE: {}", e))?;
        }

        // Ensure DOCKER_PLATFORM is present (upgrades from older versions)
        if !existing.contains("DOCKER_PLATFORM=") {
            let docker_platform = if cfg!(target_arch = "aarch64") {
                "linux/arm64"
            } else {
                "linux/amd64"
            };
            let append = format!("DOCKER_PLATFORM={}\n", docker_platform);
            let mut file = std::fs::OpenOptions::new().append(true).open(&env_path)
                .map_err(|e| format!("Failed to append to .env: {}", e))?;
            std::io::Write::write_all(&mut file, append.as_bytes())
                .map_err(|e| format!("Failed to write DOCKER_PLATFORM: {}", e))?;
        }

            }

    Ok((data_dir, compose_dst, env_path))
}
