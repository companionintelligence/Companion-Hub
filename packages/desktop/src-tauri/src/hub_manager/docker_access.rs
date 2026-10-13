//! Docker availability and access classification, plus Traefik recreate markers.

use super::*;

/// Check if Docker is available
pub fn is_docker_available() -> bool {
    matches!(check_docker_access().state, DockerAccessState::Available)
}

pub(crate) fn should_defer_docker_bind_mount_probe(state: &DockerAccessState) -> bool {
    !matches!(state, DockerAccessState::Available)
}

pub fn check_docker_access() -> DockerAccessCheck {
    {
        let cache = lock_recovering(&DOCKER_ACCESS_CACHE);
        if let Some((checked_at, check)) = cache.as_ref() {
            if docker_access_cache_is_fresh(*checked_at, Instant::now(), DOCKER_ACCESS_CACHE_TTL) {
                return check.clone();
            }
        }
    }

    let check = check_docker_access_uncached();
    *lock_recovering(&DOCKER_ACCESS_CACHE) = Some((Instant::now(), check.clone()));
    check
}

fn check_docker_access_uncached() -> DockerAccessCheck {
    let output = match docker_command().arg("info").output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return DockerAccessCheck {
                state: DockerAccessState::NotInstalled,
                detail: Some("Docker CLI was not found on PATH.".to_string()),
            };
        }
        Err(error) => {
            return DockerAccessCheck {
                state: DockerAccessState::Error,
                detail: Some(format!("Failed to run docker info: {}", error)),
            };
        }
    };

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let combined = if !stderr.is_empty() && !stdout.is_empty() {
        format!("{}\n{}", stderr, stdout)
    } else if !stderr.is_empty() {
        stderr.clone()
    } else {
        stdout.clone()
    };

    if output.status.success() {
        // `docker info` can exit 0 while printing daemon-unreachable errors to
        // stderr (e.g. when Docker Desktop is paused or still starting).  Run
        // the same classifier used for non-zero exits so those cases are caught.
        let check = classify_docker_access_result(&combined, output.status.code());
        if matches!(
            check.state,
            DockerAccessState::DaemonUnavailable | DockerAccessState::PermissionDenied
        ) {
            return check;
        }
        return DockerAccessCheck {
            state: DockerAccessState::Available,
            detail: None,
        };
    }

    classify_docker_access_result(&combined, output.status.code())
}

pub(crate) fn classify_docker_access_result(
    combined: &str,
    exit_code: Option<i32>,
) -> DockerAccessCheck {
    let combined_lower = combined.to_lowercase();
    let references_windows_docker_pipe = combined_lower.contains("//./pipe/docker")
        || combined_lower.contains("\\\\.\\pipe\\docker")
        || combined_lower.contains("%2f%2f.%2fpipe%2fdocker");
    let windows_pipe_not_ready = references_windows_docker_pipe
        && (combined_lower.contains("the system cannot find the file specified")
            || combined_lower.contains("the pipe has been ended")
            || combined_lower.contains("the semaphore timeout period has expired"));

    if combined_lower.contains("cannot connect to the docker daemon")
        || combined_lower.contains("is the docker daemon running")
        || combined_lower.contains("error during connect")
        || combined_lower.contains("connection refused")
        || combined_lower.contains("context deadline exceeded")
        || combined_lower.contains("this error may indicate that the docker daemon is not running")
        || windows_pipe_not_ready
    {
        return DockerAccessCheck {
            state: DockerAccessState::DaemonUnavailable,
            detail: Some(if combined.is_empty() {
                "Docker is installed, but the daemon is not ready yet.".to_string()
            } else {
                combined.to_string()
            }),
        };
    }

    if combined_lower.contains("permission denied")
        || combined_lower.contains("got permission denied")
        || combined_lower.contains("permission denied while trying to connect")
        || combined_lower.contains("dial unix /var/run/docker.sock: connect: permission denied")
        || combined_lower.contains("access is denied")
        || combined_lower.contains("must be run with elevated privileges")
        || combined_lower.contains("requested operation requires elevation")
    {
        return DockerAccessCheck {
            state: DockerAccessState::PermissionDenied,
            detail: Some(if combined.is_empty() {
                "Docker is installed, but this user cannot access the Docker daemon yet."
                    .to_string()
            } else {
                combined.to_string()
            }),
        };
    }

    DockerAccessCheck {
        state: DockerAccessState::Error,
        detail: Some(if combined.is_empty() {
            format!("docker info failed with exit code {:?}", exit_code)
        } else {
            combined.to_string()
        }),
    }
}

/// Check if Hub containers exist (stopped or running)
pub fn hub_containers_exist() -> bool {
    first_existing_container(HUB_CONTAINER_NAMES).is_some()
        || first_existing_container(HUB_QUEUE_NAMES).is_some()
}

fn traefik_recreate_marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TRAEFIK_RECREATE_MARKER_FILENAME)
}

pub(crate) fn is_traefik_recreate_required(data_dir: &Path) -> bool {
    traefik_recreate_marker_path(data_dir).exists()
}

pub(crate) fn mark_traefik_recreate_required(data_dir: &Path) -> Result<(), String> {
    let marker_path = traefik_recreate_marker_path(data_dir);
    std::fs::write(
        &marker_path,
        b"Traefik container must be recreated before the next startup.\n",
    )
    .map_err(|error| {
        format!(
            "Failed to persist Traefik recreate marker at {}: {}",
            marker_path.display(),
            error
        )
    })
}

pub(crate) fn clear_traefik_recreate_required(data_dir: &Path) -> Result<(), String> {
    let marker_path = traefik_recreate_marker_path(data_dir);
    if !marker_path.exists() {
        return Ok(());
    }

    std::fs::remove_file(&marker_path).map_err(|error| {
        format!(
            "Failed to clear Traefik recreate marker at {}: {}",
            marker_path.display(),
            error
        )
    })
}

pub(crate) fn seeded_traefik_config_contents() -> String {
    let acme_email =
        std::env::var("ACME_EMAIL").unwrap_or_else(|_| DEFAULT_TRAEFIK_ACME_EMAIL.to_string());
    TRAEFIK_CONFIG_SEED.replace("{{ACME_EMAIL}}", &acme_email)
}
