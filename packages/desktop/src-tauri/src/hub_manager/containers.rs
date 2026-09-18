//! Container conflict healing, port release and health waiting.

use super::*;

pub(crate) fn remove_existing_traefik_container(data_dir: &Path) -> Result<(), String> {
    let output = docker_command()
        .args(["rm", "-f", "traefik"])
        .output()
        .map_err(|error| {
            format!(
                "Failed to remove the existing Traefik container before recreate: {}",
                error
            )
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    // `docker rm -f` exits 0 even when the container is already gone, but still
    // prints "No such container" to stderr. Treat that as a normal clean-state
    // condition — not a failure and not an error-level telemetry event.
    if is_docker_missing_resource_message(&combined_output) {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            "Traefik recreate was requested, but no existing Traefik container was present.",
        );
        return Ok(());
    }

    if output.status.success() {
        let message = if combined_output.is_empty() {
            "Removed existing Traefik container before recreate.".to_string()
        } else {
            format!(
                "Removed existing Traefik container before recreate. {}",
                combined_output
            )
        };
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        return Ok(());
    }

    if combined_output.is_empty() {
        Err(format!(
            "Failed to remove the existing Traefik container before recreate (exit code {:?}).",
            output.status.code()
        ))
    } else {
        Err(format!(
            "Failed to remove the existing Traefik container before recreate. {}",
            combined_output
        ))
    }
}

/// Remove a Traefik container that is not running but still holds 80/443 via docker-proxy.
///
/// Docker can leave a `created` (or exited) Traefik container with published ports while
/// `compose up` fails on the next start with "ports are not available".
pub(crate) fn ensure_traefik_container_released(data_dir: &Path) -> Result<(), String> {
    let output = docker_command()
        .args(["inspect", "traefik", "--format", "{{.State.Status}}"])
        .output()
        .map_err(|error| format!("Failed to inspect Traefik container state: {}", error))?;

    if !output.status.success() {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        if is_docker_missing_resource_message(&combined) {
            return Ok(());
        }
        return Err(format!(
            "Failed to inspect Traefik container state. {}",
            combined
        ));
    }

    let status = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_lowercase();
    if status == "running" || status == "restarting" {
        return Ok(());
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Removing non-running Traefik container (state={}) to release host ports 80/443.",
            status
        ),
    );
    remove_existing_traefik_container(data_dir)
}

/// Remove stale project containers left behind by a previous installation.
/// Runs `docker compose down --remove-orphans` to clean up before a fresh start.
pub fn cleanup_stale_project_containers(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.cleanup",
        "Cleaning up stale containers before start.",
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
            let message = format!("Failed to run cleanup compose down: {}", e);
            let _ = append_desktop_log_for(data_dir, "hub.cleanup", &message);
            message
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    // Log result but treat non-zero exit as non-fatal — the subsequent start
    // will surface any real problem.
    if output.status.success() {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.cleanup",
            &format!("Stale container cleanup succeeded. {}", combined_output),
        );
    } else {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.cleanup",
            &format!(
                "Stale container cleanup returned non-zero (non-fatal). {}",
                combined_output
            ),
        );
    }

    Ok(())
}

/// Returns `true` if the error output indicates a Docker container name conflict
/// ("is already in use by container").
pub(crate) fn is_container_name_conflict(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("is already in use by container")
}

/// Returns `true` if the error output indicates an OCI runtime creation failure.
pub(crate) fn is_oci_runtime_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("oci runtime create failed") || lower.contains("failed to create shim task")
}

pub(crate) fn is_docker_config_mount_path_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("docker-config.json")
        && (lower.contains("not a directory")
            || lower.contains("is a directory")
            || lower.contains("mount a directory onto a file"))
}

/// Returns `true` when Docker cannot publish Traefik's HTTP/HTTPS host ports.
pub(crate) fn is_host_port_bind_conflict(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("ports are not available")
        || lower.contains("address already in use")
        || lower.contains("bind: address already in use")
        || lower.contains("port is already allocated")
}

const HUB_STACK_CONTAINERS: &[&str] = &[
    HUB_CONTAINER,
    LEGACY_HUB_CONTAINER,
    "ci-hub-db",
    HUB_QUEUE,
    LEGACY_HUB_QUEUE,
    "traefik",
    "cloudflared",
    "hub-tailscale",
];

/// Remove stopped Hub stack containers (and optionally Traefik) that still claim
/// a host port publish mapping. Running non-Hub containers are left alone so we
/// can reassign HTTP_PORT/HTTPS_PORT instead of killing unrelated services.
pub(crate) fn release_stale_port_publishers(
    port: u16,
    data_dir: &Path,
    force_traefik: bool,
) -> Result<(), String> {
    let filter = format!("publish={}", port);
    let output = docker_command()
        .args([
            "ps",
            "-a",
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.Status}}",
            "--filter",
            &filter,
        ])
        .output()
        .map_err(|error| {
            format!(
                "Failed to list containers publishing host port {}: {}",
                port, error
            )
        })?;

    if !output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let id = parts[0].trim();
        let names = parts[1].trim();
        let status = parts[2].trim();
        if id.is_empty() {
            continue;
        }

        let status_lower = status.to_lowercase();
        let is_running = status_lower.starts_with("up");
        let is_traefik = names
            .split(',')
            .any(|name| name.trim().eq_ignore_ascii_case("traefik"));
        let is_ours = names.split(',').any(|name| {
            HUB_STACK_CONTAINERS
                .iter()
                .any(|container| name.trim().eq_ignore_ascii_case(container))
        });

        let should_remove = if force_traefik && is_traefik {
            true
        } else if is_traefik && !is_running {
            true
        } else if is_ours && !is_running {
            true
        } else if !is_running {
            true
        } else {
            false
        };

        if !should_remove {
            continue;
        }

        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "Removing container {} ({}, {}) to release host port {}.",
                id, names, status, port
            ),
        );

        let rm_output = docker_command().args(["rm", "-f", id]).output();
        match rm_output {
            Ok(rm) if rm.status.success() => {}
            Ok(rm) => {
                let combined = format_command_output(
                    &String::from_utf8_lossy(&rm.stdout),
                    &String::from_utf8_lossy(&rm.stderr),
                );
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!(
                        "Failed to remove container {} publishing port {} (non-fatal). {}",
                        id, port, combined
                    ),
                );
            }
            Err(error) => {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!(
                        "Failed to remove container {} publishing port {} (non-fatal): {}",
                        id, port, error
                    ),
                );
            }
        }
    }

    Ok(())
}

/// Targeted self-heal for Traefik host port bind failures.
pub(crate) fn heal_host_port_bind_conflict(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
    error_output: &str,
) {
    let ports: Vec<u16> = crate::port_manager::parse_bind_conflict_port(error_output)
        .map(|port| vec![port])
        .unwrap_or_else(|| vec![80, 443]);

    for port in ports {
        let _ = release_stale_port_publishers(port, data_dir, true);
    }

    let _ = ensure_traefik_container_released(data_dir);
    let _ = ensure_container_released_if_not_running(data_dir, "ci-hub-db", "6543");
    let _ = ensure_container_released_if_not_running(data_dir, HUB_QUEUE, "5001");
    let _ = ensure_container_released_if_not_running(data_dir, LEGACY_HUB_QUEUE, "5001");
    let _ = cleanup_stale_project_containers(compose_path, env_path, data_dir);
    let _ = release_orphaned_traefik_port_proxies(data_dir);

    match crate::port_manager::refresh_ports_if_needed(env_path) {
        Ok(resolution) => {
            let mut log_lines = vec!["Port re-resolution after bind conflict:".to_string()];
            for message in &resolution.info {
                log_lines.push(format!("  INFO: {}", message));
            }
            for message in &resolution.warnings {
                log_lines.push(format!("  WARN: {}", message));
            }
            for (var, port) in &resolution.env_vars {
                if var == "HTTP_PORT" || var == "HTTPS_PORT" {
                    log_lines.push(format!("  {}={}", var, port));
                }
            }
            let _ = append_desktop_log_for(data_dir, "hub.start", &log_lines.join("\n"));
        }
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Port re-resolution after bind conflict failed (non-fatal): {}",
                    error
                ),
            );
        }
    }
}

/// On Linux, find `docker-proxy` PIDs holding Traefik's target ports with no
/// corresponding *running* container (i.e. orphaned after Docker cleanup).
///
/// `/proc/<pid>/cmdline` is world-readable even for root-owned processes, so
/// this requires no elevated privileges.  Each returned tuple is `(pid, port)`.
#[cfg(target_os = "linux")]
fn find_orphaned_traefik_proxy_pids(target_ports: &[u16]) -> Vec<(u32, u16)> {
    let mut proxy_pids: Vec<(u32, u16)> = Vec::new();

    let proc_dir = match std::fs::read_dir("/proc") {
        Ok(d) => d,
        Err(_) => return proxy_pids,
    };

    for entry in proc_dir.flatten() {
        let name = entry.file_name();
        let pid = match name.to_string_lossy().parse::<u32>() {
            Ok(n) => n,
            Err(_) => continue,
        };

        let bytes = match std::fs::read(format!("/proc/{}/cmdline", pid)) {
            Ok(b) => b,
            Err(_) => continue,
        };

        // argv is NUL-separated; last element may be empty
        let args: Vec<&[u8]> = bytes.split(|&b| b == 0).collect();

        let is_docker_proxy = args
            .first()
            .and_then(|a| std::str::from_utf8(a).ok())
            .map(|s| s.ends_with("docker-proxy"))
            .unwrap_or(false);

        if !is_docker_proxy {
            continue;
        }

        for window in args.windows(2) {
            let key = std::str::from_utf8(window[0]).unwrap_or("");
            let val = std::str::from_utf8(window[1]).unwrap_or("");
            if key == "-host-port" {
                if let Ok(port) = val.parse::<u16>() {
                    if target_ports.contains(&port) {
                        proxy_pids.push((pid, port));
                    }
                }
            }
        }
    }

    if proxy_pids.is_empty() {
        return proxy_pids;
    }

    // Keep only proxies for ports not legitimately owned by a *running* container.
    proxy_pids
        .into_iter()
        .filter(|(_, port)| {
            let claimed = docker_command()
                .args(["ps", "-q", "--filter", &format!("publish={}", port)])
                .output()
                .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
                .unwrap_or(false);
            !claimed
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn find_orphaned_traefik_proxy_pids(_target_ports: &[u16]) -> Vec<(u32, u16)> {
    Vec::new()
}

/// Kill orphaned `docker-proxy` processes that may be preventing Traefik from
/// binding its host ports. Uses `sudo -n kill` when available; otherwise logs
/// remediation steps and continues startup (compose will surface a real bind error).
pub(crate) fn release_orphaned_traefik_port_proxies(data_dir: &Path) -> Result<(), String> {
    let target_ports: &[u16] = &[80, 443, 8080];
    let orphaned = find_orphaned_traefik_proxy_pids(target_ports);

    if orphaned.is_empty() {
        return Ok(());
    }

    let pids: Vec<String> = orphaned.iter().map(|(pid, _)| pid.to_string()).collect();
    let ports: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        orphaned
            .iter()
            .filter(|(_, p)| seen.insert(*p))
            .map(|(_, p)| p.to_string())
            .collect()
    };

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Orphaned docker-proxy processes detected on Traefik ports [{}] (PIDs: {}). Attempting cleanup.",
            ports.join(", "),
            pids.join(", ")
        ),
    );

    // Attempt: sudo -n kill <pids>
    let mut kill_args = vec!["kill"];
    kill_args.extend(pids.iter().map(String::as_str));

    let kill_ok = std::process::Command::new("sudo")
        .arg("-n")
        .args(&kill_args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if kill_ok {
        // Poll briefly for the processes to disappear (up to ~2 s).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            let still_alive = find_orphaned_traefik_proxy_pids(target_ports);
            if still_alive.is_empty() {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    "Orphaned docker-proxy processes cleared; Traefik ports are now available.",
                );
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    // Best-effort cleanup; do not block hub startup when sudo is unavailable.
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Could not clear orphaned docker-proxy on ports [{}] (PIDs: {}). \
             If Traefik fails to start, run `sudo systemctl restart docker` or restart Docker Desktop.",
            ports.join(", "),
            pids.join(", ")
        ),
    );
    Ok(())
}

pub(crate) fn inspect_container_state_health(container_name: &str) -> String {
    docker_command()
        .args([
            "inspect",
            "--format",
            "{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
            container_name,
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

pub(crate) fn first_existing_container(names: &[&'static str]) -> Option<&'static str> {
    first_preferred_container(names, |name| inspect_container_state_health(name))
}

fn container_inspect_state(status: &str) -> Option<&str> {
    if !inspect_status_ok(status) {
        return None;
    }
    status.split(':').next().filter(|state| !state.is_empty())
}

pub(crate) fn first_preferred_container<'a>(
    names: &[&'a str],
    inspect_status: impl Fn(&str) -> String,
) -> Option<&'a str> {
    let mut fallback = None;
    for name in names {
        let status = inspect_status(name);
        let Some(state) = container_inspect_state(&status) else {
            continue;
        };
        if fallback.is_none() {
            fallback = Some(*name);
        }
        if state == "running" {
            return Some(*name);
        }
    }
    fallback
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum NamedContainerWaitDecision {
    Ready,
    KeepWaiting,
    Failed(String),
}

pub(crate) fn named_container_wait_decision(
    names: &[&str],
    statuses: &[(&str, &str)],
    display_name: &str,
) -> NamedContainerWaitDecision {
    let mut last_status = String::new();
    let mut saw_existing = false;
    let mut saw_live = false;

    for name in names {
        let Some((_, status)) = statuses.iter().find(|(candidate, _)| *candidate == *name) else {
            continue;
        };
        let Some(state) = container_inspect_state(status) else {
            continue;
        };
        saw_existing = true;
        last_status = (*status).to_string();
        if *status == "running:healthy" {
            return NamedContainerWaitDecision::Ready;
        }
        if matches!(state, "exited" | "dead") {
            continue;
        }
        saw_live = true;
    }

    if saw_existing && !saw_live {
        return NamedContainerWaitDecision::Failed(format!(
            "{} container exited during startup (status: {}).",
            display_name, last_status
        ));
    }

    NamedContainerWaitDecision::KeepWaiting
}

pub(crate) fn hub_container_name() -> &'static str {
    first_existing_container(HUB_CONTAINER_NAMES).unwrap_or(HUB_CONTAINER)
}

pub(crate) fn hub_queue_name() -> &'static str {
    first_existing_container(HUB_QUEUE_NAMES).unwrap_or(HUB_QUEUE)
}

fn docker_network_exists(name: &str) -> bool {
    docker_command()
        .args(["network", "inspect", name, "--format", "{{.Id}}"])
        .output()
        .map(|output| {
            output.status.success() && !String::from_utf8_lossy(&output.stdout).trim().is_empty()
        })
        .unwrap_or(false)
}

pub(crate) fn postgres_docker_network() -> &'static str {
    if docker_network_exists(HUB_NETWORK) {
        HUB_NETWORK
    } else {
        LEGACY_HUB_NETWORK
    }
}

fn inspect_status_ok(status: &str) -> bool {
    !status.is_empty() && !status.contains("No such object") && !status.contains("Error")
}

pub(crate) fn wait_for_container_healthy(
    container_name: &str,
    display_name: &str,
    timeout_secs: u64,
) -> Result<(), String> {
    wait_for_named_container_healthy(&[container_name], display_name, timeout_secs)
}

fn wait_for_named_container_healthy(
    names: &[&str],
    display_name: &str,
    timeout_secs: u64,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_status = String::new();

    while Instant::now() < deadline {
        let inspected: Vec<(&str, String)> = names
            .iter()
            .map(|name| (*name, inspect_container_state_health(name)))
            .collect();
        let statuses: Vec<(&str, &str)> = inspected
            .iter()
            .map(|(name, status)| (*name, status.as_str()))
            .collect();
        match named_container_wait_decision(names, &statuses, display_name) {
            NamedContainerWaitDecision::Ready => return Ok(()),
            NamedContainerWaitDecision::Failed(message) => return Err(message),
            NamedContainerWaitDecision::KeepWaiting => {
                if let Some((_, status)) = statuses
                    .iter()
                    .rev()
                    .find(|(_, status)| inspect_status_ok(status))
                {
                    last_status = (*status).to_string();
                }
            }
        }

        std::thread::sleep(Duration::from_secs(1));
    }

    Err(format!(
        "Timed out waiting for {} to become healthy (last status: {}).",
        display_name,
        if last_status.is_empty() {
            "unknown"
        } else {
            &last_status
        }
    ))
}

pub(crate) fn wait_for_hub_healthy() -> Result<(), String> {
    wait_for_named_container_healthy(HUB_CONTAINER_NAMES, "Hub", HUB_START_HEALTHY_TIMEOUT_SECS)
}

pub(crate) fn wait_for_queue_healthy() -> Result<(), String> {
    wait_for_named_container_healthy(
        HUB_QUEUE_NAMES,
        "Message queue",
        DB_START_HEALTHY_TIMEOUT_SECS,
    )
}

/// Log loudly when the Hub container's Node arch does not match this desktop binary.
/// An amd64 Node image on Apple Silicon runs under Rosetta and has been observed to
/// wedge the HTTP accept loop shortly after boot.
pub(crate) fn warn_if_hub_node_arch_mismatches_host(data_dir: &Path) {
    let expected = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let output = match docker_command()
        .args(["exec", hub_container_name(), "node", "-p", "process.arch"])
        .output()
    {
        Ok(output) => output,
        Err(err) => {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!("Could not probe Hub Node arch: {err}"),
            );
            return;
        }
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!("Could not probe Hub Node arch: {stderr}"),
        );
        return;
    }
    let actual = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if actual == expected {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!("Hub Node arch ok: process.arch={actual}"),
        );
        return;
    }
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "WARNING: Hub Node arch mismatch — container process.arch={actual}, desktop expects {expected}. \
             On Apple Silicon this usually means the arm64 image slot contains amd64 content (Rosetta). \
             Pull/rebuild a native arm64 Hub image before relying on this stack."
        ),
    );
}
