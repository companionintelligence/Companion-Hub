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
    cached_docker_access_check(check_docker_access_uncached)
}

/// [`check_docker_access`] with the uncached check passed in: the cached answer while it is fresh,
/// else `check_uncached`'s, cached unless the cache was forgotten while it ran.
pub(crate) fn cached_docker_access_check(
    check_uncached: impl FnOnce() -> DockerAccessCheck,
) -> DockerAccessCheck {
    {
        let cache = lock_recovering(&DOCKER_ACCESS_CACHE);
        if let Some((checked_at, check)) = cache.as_ref() {
            if docker_access_cache_is_fresh(*checked_at, Instant::now(), DOCKER_ACCESS_CACHE_TTL) {
                return check.clone();
            }
        }
    }

    let generation = DOCKER_ACCESS_GENERATION.load(Ordering::SeqCst);
    let check = check_uncached();
    let mut cache = lock_recovering(&DOCKER_ACCESS_CACHE);
    // A check that began before Docker started (a status poll during Start engine's wait) must
    // not put "not running" back for the next five seconds.
    if DOCKER_ACCESS_GENERATION.load(Ordering::SeqCst) == generation {
        *cache = Some((Instant::now(), check.clone()));
    }
    check
}

/// Bumped by [`forget_docker_access_check`], so a check already under way doesn't cache its answer.
static DOCKER_ACCESS_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Drop the cached check, so the next one asks Docker: it has just started, or its last answer
/// may be stale.
pub(crate) fn forget_docker_access_check() {
    let mut cache = lock_recovering(&DOCKER_ACCESS_CACHE);
    DOCKER_ACCESS_GENERATION.fetch_add(1, Ordering::SeqCst);
    *cache = None;
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

    docker_access_from_info_output(
        output.status.success(),
        output.status.code(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    )
}

/// What a finished `docker info` says about this user's access to Docker.
pub(crate) fn docker_access_from_info_output(
    succeeded: bool,
    exit_code: Option<i32>,
    stdout: &str,
    stderr: &str,
) -> DockerAccessCheck {
    let (stderr, config_file_unreadable) = without_cli_warnings(stderr);
    let stderr = stderr.trim();
    let stdout = stdout.trim();
    let combined = if !stderr.is_empty() && !stdout.is_empty() {
        format!("{}\n{}", stderr, stdout)
    } else if !stderr.is_empty() {
        stderr.to_string()
    } else {
        stdout.to_string()
    };

    // `docker info` can exit 0 while printing daemon-unreachable errors to stderr (e.g. when
    // Docker Desktop is paused or still starting). Run the same classifier used for non-zero exits
    // so those cases are caught.
    let mut check = classify_docker_access_result(&combined, exit_code);
    if succeeded
        && !matches!(
            check.state,
            DockerAccessState::DaemonUnavailable | DockerAccessState::PermissionDenied
        )
    {
        return DockerAccessCheck {
            state: DockerAccessState::Available,
            detail: None,
        };
    }

    if config_file_unreadable {
        // Without its config file the CLI also loses the current context, so it may have asked
        // the wrong engine. The warning itself stays out: its "permission denied" or "Access is
        // denied" would read as Docker refusing this user.
        let detail = check.detail.get_or_insert_with(String::new);
        if !detail.is_empty() {
            detail.push('\n');
        }
        detail.push_str(CONFIG_FILE_UNREADABLE_NOTE);
    }
    check
}

/// Added after the error when `docker info` warned that it couldn't load or parse its config file.
pub(crate) const CONFIG_FILE_UNREADABLE_NOTE: &str =
    "Docker could not read its config file, so it ran without the settings in it, such as the current context.";

/// Drops the warnings the Docker CLI prints about its own files before carrying on, and says
/// whether one of them was about the config file.
///
/// "WARNING: Error loading config file: <why>" comes when it can't read the config file.
/// `sudo docker login` leaves `~/.docker/config.json` owned by root, so the reason is often
/// "permission denied". "WARNING: Error parsing config file (<path>): <why>" comes when the file
/// is broken. "WARNING: Plugin \"<path>\" is not valid: ...: permission denied" comes when a CLI
/// plugin can't be run. These are about files, not the daemon, so they must not read as Docker
/// refusing this user, nor become the first line of a real error.
fn without_cli_warnings(stderr: &str) -> (String, bool) {
    let mut config_file_unreadable = false;
    let kept = stderr
        .lines()
        .filter(|line| {
            let lower = line.trim_start().to_lowercase();
            if lower.starts_with("warning: error loading config file")
                || lower.starts_with("warning: error parsing config file")
            {
                config_file_unreadable = true;
                return false;
            }
            !(lower.starts_with("warning: plugin ") && lower.contains(" is not valid"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    (kept, config_file_unreadable)
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

    // The CLI stopped before asking any engine: it couldn't read the current context (left owned
    // by root by `sudo docker context create`) or the context doesn't exist. No daemon refused
    // this user, so the "permission denied" in it must not read as that.
    if combined_lower.contains("unable to resolve docker endpoint") {
        return DockerAccessCheck {
            state: DockerAccessState::Error,
            detail: Some(combined.to_string()),
        };
    }

    // Docker 29 says "failed to connect to the docker API at ...; check if the path is correct and
    // if the daemon is running" when the socket is gone, which is how a stopped Docker Desktop,
    // Colima or rootless engine looks.
    if combined_lower.contains("cannot connect to the docker daemon")
        || combined_lower.contains("is the docker daemon running")
        || combined_lower.contains("check if the path is correct and if the daemon is running")
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
