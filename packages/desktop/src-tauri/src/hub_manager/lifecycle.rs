//! Hub start/stop lifecycle: image pulls, staged startup and shutdown.

use super::*;

fn start_database_first(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Starting database service first to ensure initialization before full stack startup.",
    );

    let output = docker_command()
        .env("ENV_FILE", compose_env_file_var(env_path))
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
            "ci-hub-db",
        ])
        .output()
        .map_err(|error| {
            let message = format!("Failed to start database service: {}", error);
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    if !output.status.success() {
        let failure = if combined_output.is_empty() {
            format!(
                "Database bootstrap failed with exit code {:?}.",
                output.status.code()
            )
        } else {
            format!("Database bootstrap failed. {}", combined_output)
        };
        let _ = append_desktop_log_for(data_dir, "hub.start", &failure);
        return Err(with_view_logs_hint(failure));
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Database bootstrap command succeeded. Waiting for ci-hub-db health.",
    );

    wait_for_container_healthy("ci-hub-db", "Database", DB_START_HEALTHY_TIMEOUT_SECS).map_err(
        |error| {
            let message = format!("Database did not become healthy after bootstrap: {}", error);
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        },
    )
}

/// Refresh host RAM/disk probe files under the data dir so the Hub backend reports
/// physical host resources instead of the Docker Desktop VM when running in containers.
pub fn refresh_host_metrics_probe_cache(data_dir: &Path) {
    refresh_macos_host_probe_cache(data_dir);
    refresh_windows_host_metrics_probe_cache(data_dir);
    refresh_linux_host_metrics_probe_cache(data_dir);
}

pub fn refresh_host_hardware_probe_cache(data_dir: &Path) {
    refresh_nvidia_host_probe_cache(data_dir);
    #[cfg(target_os = "linux")]
    refresh_rocm_host_probe_cache(data_dir);
    #[cfg(target_os = "windows")]
    refresh_amd_host_probe_cache(data_dir);
    refresh_host_metrics_probe_cache(data_dir);
}

/// Start Hub using docker compose up (with port conflict resolution).
///
/// Uses a global `AtomicBool` guard to prevent concurrent invocations.
/// A `Drop` guard ensures the flag is cleared even if the inner logic panics.
pub fn start_hub(compose_path: &Path, env_path: &Path, data_dir: &Path) -> Result<String, String> {
    // Clear the user-stopped marker: the user has explicitly requested a start.
    if !stack_dev_mode_enabled() {
        clear_user_stopped(data_dir);
    }

    // Prevent concurrent start attempts.
    if START_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        let message = "A Hub start operation is already in progress — skipping duplicate request.";
        let _ = append_desktop_log_for(data_dir, "hub.start", message);
        return Ok(message.to_string());
    }

    // RAII guard: always clear the flag when the function exits, including panics.
    struct StartGuard;
    impl Drop for StartGuard {
        fn drop(&mut self) {
            START_RECREATE_PENDING.store(false, Ordering::SeqCst);
            START_IN_PROGRESS.store(false, Ordering::SeqCst);
        }
    }
    let _guard = StartGuard;

    // Startup progress compares container exit times against this, and re-decides whether
    // image downloads count toward the percentage.
    START_BEGAN_AT_MS.store(
        u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0),
        Ordering::SeqCst,
    );
    START_IMAGE_DOWNLOADS_SEEN.store(false, Ordering::SeqCst);

    // Clear sticky failure only once this call owns the start lock — UI can show Starting.
    clear_start_failed(data_dir);

    match start_hub_inner(compose_path, env_path, data_dir) {
        Ok(summary) => Ok(summary),
        Err(error) => {
            let formatted = format_start_failure_message(&error);
            if should_persist_start_failure(&error) {
                let _ = mark_start_failed(data_dir, &error);
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!("Start failed (sticky failure state set): {}", formatted),
                );
            } else {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!("Start failed (transient, not sticky): {}", formatted),
                );
            }
            Err(formatted)
        }
    }
}

/// Inner start logic, called under the `START_IN_PROGRESS` guard.
fn start_hub_inner(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<String, String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Requested start via docker compose up -d\ncompose={}\nenv={}",
            compose_path.display(),
            env_path.display()
        ),
    );

    // Re-resolve on every start/retry so affinity tracks the live Hub stack.
    crate::docker_engine::clear_process_pin();
    let engine =
        crate::docker_engine::resolve_and_pin_hub_docker_engine(data_dir).map_err(|error| {
            let message = format!("Docker engine selection failed: {error}");
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "using {} at {} because {}",
            engine.kind.as_str(),
            engine.docker_host,
            engine.reason
        ),
    );

    let candidates = crate::docker_engine::enumerate_docker_engine_candidates(None);
    let reachable = crate::docker_engine::probe_reachable_engines(&candidates);
    if let Some(conflict) = crate::docker_engine::split_brain_conflict(&engine, &reachable) {
        let _ = append_desktop_log_for(data_dir, "hub.start", &conflict);
        return Err(with_view_logs_hint(conflict));
    }

    if !is_docker_available() {
        let message = "Docker is not running — please start Docker Desktop and try again.";
        let _ = append_desktop_log_for(data_dir, "hub.start", message);
        return Err(message.to_string());
    }

    // Before anything is pulled or created: an older Compose rejects the stack file outright, and
    // its error does not say that Docker is the problem.
    ensure_docker_supports_hub_stack(data_dir)?;

    let traefik_preflight = prepare_traefik_runtime_state(data_dir).map_err(|error| {
        let message = format!("Traefik runtime preflight failed before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    if traefik_preflight.changed {
        mark_traefik_recreate_required(data_dir).map_err(|error| {
            let message = format!(
                "Traefik runtime preflight changed mounted state, but the recreate marker could not be written: {}",
                error
            );
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;
    }

    let recreate_traefik = is_traefik_recreate_required(data_dir);
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Traefik runtime preflight: changed={} repaired_conflicting_paths={} recreate_pending={}",
            traefik_preflight.changed,
            traefik_preflight.repaired_conflicting_paths,
            recreate_traefik
        ),
    );

    if recreate_traefik {
        remove_existing_traefik_container(data_dir).map_err(|error| {
            let message = format!("Traefik recreate preparation failed: {}", error);
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;
        // Traefik container has been removed — clear the marker now regardless of
        // whether compose-up succeeds.  The marker's purpose ("Traefik must be
        // recreated") is satisfied once the old container is gone.
        if let Err(error) = clear_traefik_recreate_required(data_dir) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Traefik container removed but the recreate marker could not be cleared: {}",
                    error
                ),
            );
        }
    }

    ensure_hub_compose_file(compose_path, data_dir).map_err(|message| {
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    // Ensure the file-mounted Docker config path is a file, not a directory.
    // If Docker ever created this path with the wrong type, compose startup fails
    // with an OCI runtime mount error.
    ensure_hub_docker_config_state(data_dir).map_err(|error| {
        let message = format!(
            "Failed to prepare internal docker-config file before startup: {}",
            error
        );
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    let env_changed = ensure_runtime_env_state(data_dir, env_path).map_err(|error| {
        let message = format!(
            "Failed to prepare runtime env state before startup: {}",
            error
        );
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;
    if env_changed {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "Runtime env file was repaired before startup: {}",
                env_path.display()
            ),
        );
    }

    let config_hash = compute_config_hash(compose_path, env_path);
    let hash_path = data_dir.join(".config-hash");
    let saved_hash = std::fs::read_to_string(&hash_path).ok();
    let should_refresh_stack = env_changed || saved_hash.as_deref() != Some(config_hash.as_str());
    START_RECREATE_PENDING.store(should_refresh_stack, Ordering::SeqCst);
    if should_refresh_stack {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            "Stack configuration changed — pulling images and recreating containers.",
        );
        if let Err(error) = pull_stack_images(compose_path, env_path, data_dir) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!("Stack image pull failed (non-fatal, continuing): {}", error),
            );
        }
    }

    // Surface host NVIDIA hardware to the backend even when the container lacks
    // direct GPU devices; this enables runtime-missing warnings instead of
    // misclassifying NVIDIA hosts as "no GPU detected".
    refresh_nvidia_host_probe_cache(data_dir);
    // On a native WSL2 Docker engine, configure the in-distro NVIDIA container
    // runtime (Docker Desktop does this automatically; a native engine does not).
    // Runs before compose up so the backend container comes up GPU-capable.
    #[cfg(target_os = "windows")]
    ensure_wsl_engine_gpu_runtime(data_dir);
    // Likewise, make an already-installed in-distro Ollama reachable from the Hub
    // container by binding it to 0.0.0.0 (a native WSL2 engine has no
    // host.docker.internal bridge). No-op once configured or if Ollama isn't present.
    #[cfg(target_os = "windows")]
    ensure_wsl_engine_ollama_reachable(data_dir);
    #[cfg(target_os = "linux")]
    refresh_rocm_host_probe_cache(data_dir);

    // Likewise surface host AMD/Radeon hardware on Windows. WMI's 32-bit
    // AdapterRAM field saturates at 4 GiB, so this probe reads the 64-bit
    // qwMemorySize registry value to report true VRAM (e.g. 24 GB).
    #[cfg(target_os = "windows")]
    refresh_amd_host_probe_cache(data_dir);

    // Surface host macOS hardware (RAM, CPU, Apple Silicon) to the backend so it
    // can report correct values instead of the Docker VM's constrained resources.
    refresh_macos_host_probe_cache(data_dir);
    refresh_windows_host_metrics_probe_cache(data_dir);
    // Surface Linux host hardware so the backend reports true RAM/CPU instead of
    // the Docker Desktop VM's capped resources (e.g. 8 GB instead of 128 GB).
    refresh_linux_host_metrics_probe_cache(data_dir);

    // With Docker Desktop, best-effort raise VM memory/CPUs/disk toward host capacity before compose up.
    ensure_docker_vm_resources(data_dir);

    // Release stale Docker publish mappings before resolving host ports.
    for port in [80u16, 443] {
        let _ = release_stale_port_publishers(port, data_dir, false);
    }
    let _ = release_orphaned_traefik_port_proxies(data_dir);

    // Resolve port conflicts and write to the runtime env file before starting.
    let resolution = crate::port_manager::refresh_ports_if_needed(env_path).map_err(|error| {
        let message = format!("Port resolution failed before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    // Log port resolution results (centralised into desktop.log)
    let mut log_lines = vec!["Port resolution:".to_string()];
    for w in &resolution.warnings {
        log_lines.push(format!("  WARN: {}", w));
    }
    for i in &resolution.info {
        log_lines.push(format!("  INFO: {}", i));
    }
    for (var, port) in &resolution.env_vars {
        log_lines.push(format!("  {}={}", var, port));
    }
    let _ = append_desktop_log_for(data_dir, "hub.start", &log_lines.join("\n"));

    // Bring up PostgreSQL first and wait for health so role/database initialization
    // completes before the rest of the stack starts.
    start_database_first(compose_path, env_path, data_dir)?;
    ensure_postgres_password_matches_env(env_path, data_dir)?;
    // Queue may already be running from a prior start; sync password before Hub comes up.
    let _ = docker_command()
        .env("ENV_FILE", compose_env_file_var(env_path))
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
            "--remove-orphans",
            HUB_QUEUE,
        ])
        .output();
    let _ = wait_for_queue_healthy();
    ensure_rabbitmq_password_matches_env(compose_path, env_path, data_dir)?;

    ensure_traefik_container_released(data_dir).map_err(|error| {
        let message = format!("Traefik port cleanup failed before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    // Best-effort: release orphaned docker-proxy processes that may hold Traefik ports.
    let _ = release_orphaned_traefik_port_proxies(data_dir);

    ensure_host_state_tree_writable(data_dir).map_err(|error| {
        let message = format!(
            "Failed to prepare writable state directory before startup: {}",
            error
        );
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    // Attempt compose up with automatic retry on transient container conflicts.
    let mut last_error = String::new();
    for attempt in 1..=MAX_START_RETRIES {
        if attempt > 1 {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Retry attempt {}/{} after transient failure.",
                    attempt, MAX_START_RETRIES
                ),
            );
        }

        let mut compose_up_args = vec![
            "compose".to_string(),
            "--env-file".to_string(),
            env_path.to_string_lossy().into_owned(),
            "--project-name".to_string(),
            "ci-hub".to_string(),
            "-f".to_string(),
            compose_path.to_string_lossy().into_owned(),
            "up".to_string(),
            "-d".to_string(),
            "--remove-orphans".to_string(),
        ];
        if should_refresh_stack {
            compose_up_args.extend([
                "--pull".to_string(),
                "always".to_string(),
                "--force-recreate".to_string(),
            ]);
        }
        let output = match docker_command()
            .env("ENV_FILE", compose_env_file_var(env_path))
            .args(&compose_up_args)
            .output()
        {
            Ok(output) => output,
            Err(e) => {
                let message = format!("Failed to run docker compose up -d: {}", e);
                let _ = append_desktop_log_for(data_dir, "hub.start", &message);
                return Err(with_view_logs_hint(message));
            }
        };

        let combined_output = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );

        if output.status.success() {
            let compose_message = if combined_output.is_empty() {
                "docker compose up -d succeeded.".to_string()
            } else {
                format!("docker compose up -d succeeded. {}", combined_output)
            };
            let _ = append_desktop_log_for(data_dir, "hub.start", &compose_message);
            START_RECREATE_PENDING.store(false, Ordering::SeqCst);
            // Persist after compose up (even if health check fails later) so retries
            // and subsequent launches do not repeatedly pull/recreate unchanged stacks.
            persist_config_hash(data_dir, compose_path, env_path);
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!("Waiting for {HUB_CONTAINER} to report running:healthy."),
            );

            match wait_for_hub_healthy() {
                Ok(()) => {
                    let _ = append_desktop_log_for(
                        data_dir,
                        "hub.start",
                        "Hub reached running:healthy state.",
                    );
                    warn_if_hub_node_arch_mismatches_host(data_dir);
                    return Ok("Hub started successfully".to_string());
                }
                Err(error) => {
                    let message = format!(
                        "docker compose up -d succeeded but Hub did not become ready: {}",
                        error
                    );
                    let _ = append_desktop_log_for(data_dir, "hub.start", &message);
                    return Err(with_view_logs_hint(message));
                }
            }
        }

        last_error = combined_output.clone();
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "docker compose up -d failed (attempt {}). {}",
                attempt, combined_output
            ),
        );

        // Container name conflicts are self-healable: run compose down to clear them,
        // then retry.
        if is_container_name_conflict(&combined_output) && attempt < MAX_START_RETRIES {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Detected stale container name conflict — running compose down to self-heal.",
            );
            let _ = cleanup_stale_project_containers(compose_path, env_path, data_dir);
            // Brief pause to let Docker release resources.
            std::thread::sleep(std::time::Duration::from_secs(2));
            continue;
        }

        if is_host_port_bind_conflict(&combined_output) && attempt < MAX_START_RETRIES {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Detected host port bind conflict — releasing stale publishers, re-resolving ports, and retrying.",
            );
            heal_host_port_bind_conflict(compose_path, env_path, data_dir, &combined_output);
            std::thread::sleep(std::time::Duration::from_secs(2));
            continue;
        }

        // The host path bind-mounted to /data/.docker/config.json can be poisoned as a directory.
        // Self-heal it and retry automatically.
        if is_docker_config_mount_path_error(&combined_output) && attempt < MAX_START_RETRIES {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Detected docker-config mount path type mismatch — attempting self-heal and retry.",
            );
            if let Err(error) = ensure_hub_docker_config_state(data_dir) {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!(
                        "Self-heal of hub docker-config path failed before retry: {}",
                        error
                    ),
                );
            }
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }

        // Other OCI runtime errors indicate Docker Desktop / WSL2 issues — retrying without
        // user intervention is unlikely to help.
        if is_oci_runtime_error(&combined_output) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "OCI runtime error detected — Docker Desktop may need to be restarted. Stopping retries.",
            );
            break;
        }

        // Any other transient failure — wait a moment and retry.
        if attempt < MAX_START_RETRIES {
            std::thread::sleep(std::time::Duration::from_secs(2u64.pow(attempt)));
        }
    }

    let failure = if last_error.is_empty() {
        "docker compose up -d failed after all retry attempts.".to_string()
    } else {
        format!("docker compose up -d failed. {}", last_error)
    };
    let _ = append_desktop_log_for(data_dir, "hub.start", &failure);
    Err(with_view_logs_hint(failure))
}

/// Best-effort write of the current compose/env fingerprint after startup.
///
/// Called from `start_hub_inner` so manual/tray starts persist the hash that
/// `should_refresh_stack` compares on the next launch.
pub(crate) fn persist_config_hash(data_dir: &Path, compose_path: &Path, env_path: &Path) {
    let hash_path = data_dir.join(".config-hash");
    let hash = compute_config_hash(compose_path, env_path);
    if let Err(error) = std::fs::write(&hash_path, &hash) {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "Failed to persist configuration hash at {}: {}",
                hash_path.display(),
                error
            ),
        );
    }
}

/// Drop the saved configuration hash so the next startup treats the stack as stale.
///
/// Used before host updates so post-install startup always pulls fresh images and
/// recreates containers instead of reusing ones from the previous binary version.
pub fn invalidate_config_hash(data_dir: &Path) {
    let hash_path = data_dir.join(".config-hash");
    let _ = std::fs::remove_file(&hash_path);
}

/// Compute a SHA256 hash of the compose and env file contents.
pub fn compute_config_hash(compose_path: &Path, env_path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    if let Ok(content) = std::fs::read(compose_path) {
        hasher.update(&content);
    }
    if let Ok(content) = std::fs::read(env_path) {
        hasher.update(&content);
    }
    format!("{:x}", hasher.finalize())
}

/// Pull all stack images before compose up when configuration changed.
pub fn pull_stack_images(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Pulling stack images before startup…",
    );
    let output = docker_command()
        .env("ENV_FILE", compose_env_file_var(env_path))
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "pull",
        ])
        .output()
        .map_err(|e| format!("Failed to run docker compose pull: {}", e))?;

    let combined = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    if output.status.success() {
        let message = if combined.is_empty() {
            "docker compose pull succeeded.".to_string()
        } else {
            format!("docker compose pull succeeded. {}", combined)
        };
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        Ok(())
    } else {
        Err(if combined.is_empty() {
            format!(
                "docker compose pull failed with exit code {:?}",
                output.status.code()
            )
        } else {
            format!("docker compose pull failed. {}", combined)
        })
    }
}

/// Stop Hub containers without marking user-stopped (for updates).
pub fn stop_hub_for_update(compose_path: &Path, env_path: &Path) -> Result<String, String> {
    let data_dir = get_hub_data_dir();

    // If Docker is not available there are no containers to tear down.
    let docker_check = check_docker_access();
    if !matches!(docker_check.state, DockerAccessState::Available) {
        let reason = docker_check
            .detail
            .unwrap_or_else(|| "Docker daemon is not running.".to_string());
        let message = format!(
            "Docker is not available ({}); Hub is effectively stopped for update.",
            reason
        );
        let _ = append_desktop_log_for(&data_dir, "hub.update", &message);
        return Ok(message);
    }

    let _ = append_desktop_log_for(
        &data_dir,
        "hub.update",
        &format!(
            "Stopping stack for update\ncompose={}\nenv={}",
            compose_path.display(),
            env_path.display()
        ),
    );

    let output = docker_command()
        .env("ENV_FILE", compose_env_file_var(env_path))
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "down",
            "--remove-orphans",
        ])
        .output()
        .map_err(|e| format!("Failed to run docker compose down: {}", e))?;

    if output.status.success() {
        Ok("Hub stack stopped for update".to_string())
    } else {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        Err(format!("docker compose down failed. {}", combined))
    }
}

/// Stop Hub containers
pub fn stop_hub(compose_path: &Path, env_path: &Path) -> Result<String, String> {
    let data_dir = get_hub_data_dir();
    // Record that the user intentionally stopped the Hub so the next launch
    // does not auto-restart it.
    if !stack_dev_mode_enabled() {
        mark_user_stopped(&data_dir);
    }
    START_IMAGE_DOWNLOADS_SEEN.store(false, Ordering::SeqCst);

    // If Docker is not available there are no containers to tear down.
    // Return success immediately rather than letting `docker compose down`
    // fail with a confusing plugin-flag error (e.g. "unknown flag: --env-file").
    let docker_check = check_docker_access();
    if !matches!(docker_check.state, DockerAccessState::Available) {
        let reason = docker_check
            .detail
            .unwrap_or_else(|| "Docker daemon is not running.".to_string());
        let message = format!(
            "Docker is not available ({}); Hub is effectively stopped.",
            reason
        );
        let _ = append_desktop_log_for(&data_dir, "hub.stop", &message);
        return Ok(message);
    }

    let _ = append_desktop_log_for(
        &data_dir,
        "hub.stop",
        &format!(
            "Requested stop via docker compose down{}\ncompose={}\nenv={}",
            if stack_dev_mode_enabled() {
                " (stack-dev mode: user-stopped marker unchanged)"
            } else {
                " (user-stopped marker set)"
            },
            compose_path.display(),
            env_path.display()
        ),
    );

    let output = docker_command()
        .env("ENV_FILE", compose_env_file_var(env_path))
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "down",
            "--remove-orphans",
        ])
        .output()
        .map_err(|e| {
            let message = format!("Failed to run docker compose down: {}", e);
            let _ = append_desktop_log_for(&data_dir, "hub.stop", &message);
            with_view_logs_hint(message)
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    if output.status.success() {
        let message = if combined_output.is_empty() {
            "docker compose down succeeded.".to_string()
        } else {
            format!("docker compose down succeeded. {}", combined_output)
        };
        let _ = append_desktop_log_for(&data_dir, "hub.stop", &message);
        Ok("Hub stopped".to_string())
    } else {
        let failure = if combined_output.is_empty() {
            format!(
                "docker compose down failed with exit code {:?}.",
                output.status.code()
            )
        } else {
            format!("docker compose down failed. {}", combined_output)
        };
        let _ = append_desktop_log_for(&data_dir, "hub.stop", &failure);
        Err(with_view_logs_hint(failure))
    }
}

pub fn stop_managed_app_containers() -> Result<Option<String>, String> {
    if !is_docker_available() {
        return Ok(None);
    }

    let ids = list_managed_app_container_ids()?;
    if ids.is_empty() {
        return Ok(None);
    }

    let mut command = docker_command();
    command.arg("stop");
    for id in &ids {
        command.arg(id);
    }

    let stop_output = command
        .output()
        .map_err(|error| format!("Failed to stop running app containers: {}", error))?;

    let combined_stop_output = format_command_output(
        &String::from_utf8_lossy(&stop_output.stdout),
        &String::from_utf8_lossy(&stop_output.stderr),
    );

    if stop_output.status.success() {
        Ok(Some(if combined_stop_output.is_empty() {
            format!("Stopped {} running app container(s).", ids.len())
        } else {
            format!(
                "Stopped {} running app container(s). {}",
                ids.len(),
                combined_stop_output
            )
        }))
    } else {
        Err(if combined_stop_output.is_empty() {
            format!(
                "Stopping running app containers failed with exit code {:?}.",
                stop_output.status.code()
            )
        } else {
            format!(
                "Stopping running app containers failed. {}",
                combined_stop_output
            )
        })
    }
}
