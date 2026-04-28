use std::collections::HashMap;
use std::collections::HashSet;
use std::net::TcpListener;
use std::path::Path;

/// Ports that MUST stay fixed (Cloudflare tunnels require 80/443).
const FIXED_PORTS: &[(u16, &str)] = &[(80, "HTTP_PORT"), (443, "HTTPS_PORT")];

/// Ports that can be dynamically reassigned if occupied.
const DYNAMIC_PORTS: &[(u16, &str)] = &[
    (5002, "API_PORT"),
    (6543, "POSTGRES_PORT"),
    (5001, "RABBITMQ_PORT"),
    (8080, "TRAEFIK_DASHBOARD_PORT"),
];

/// Container names managed by our compose stack (used as docker ps filters).
const OUR_CONTAINERS: &[&str] = &[
    "ci-os-hub",
    "ci-hub-db",
    "ci-os-hub-queue",
    "traefik",
    "cloudflared",
    "headscale",
    "hub-tailscale",
];

/// Container statuses that indicate a container is genuinely holding its port.
/// Stopped / exited containers still appear in `docker ps -a` and may hold
/// stale port registrations on Docker Desktop for Windows, so we only trust
/// ports from containers in these states.
const RUNNING_STATUSES: &[&str] = &["running", "restarting"];

/// Check if a port is available by attempting a TCP bind.
pub fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Check if a port is available OR held by our own containers.
/// A port held by our own stack is not a conflict — docker compose up
/// will reuse those containers.
fn is_port_available_or_ours(port: u16, our_ports: &HashSet<u16>) -> bool {
    is_port_available(port) || our_ports.contains(&port)
}

/// Query Docker for host ports currently bound by our *running* managed
/// containers.  Only running/restarting containers are genuinely holding
/// their ports; stopped containers may leave ghost port registrations on
/// Docker Desktop for Windows that confuse `is_port_available_or_ours`.
fn get_our_container_ports() -> HashSet<u16> {
    let mut ports = HashSet::new();

    // Build filter args for our containers — only include running ones.
    let mut args: Vec<&str> = vec!["ps", "--format", "{{.Ports}}"];
    let filters: Vec<String> = OUR_CONTAINERS
        .iter()
        .map(|name| format!("name={}", name))
        .collect();
    let status_filters: Vec<String> = RUNNING_STATUSES
        .iter()
        .map(|s| format!("status={}", s))
        .collect();
    for f in &filters {
        args.push("--filter");
        args.push(f);
    }
    for f in &status_filters {
        args.push("--filter");
        args.push(f);
    }

    let output = crate::hub_manager::docker_command()
        .args(&args)
        .output();

    match output {
        Ok(out) => {
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let _ = crate::hub_manager::append_desktop_log(
                    "port_manager",
                    &format!(
                        "docker ps for port discovery exited with {:?}: {}",
                        out.status.code(),
                        stderr.trim()
                    ),
                );
                // Don't parse stdout from a failed command — it may be
                // partial or garbled.
            } else {
                let stdout = String::from_utf8_lossy(&out.stdout);
                // Parse port mappings like "0.0.0.0:5002->5002/tcp, :::5002->5002/tcp"
                for line in stdout.lines() {
                    for mapping in line.split(',') {
                        // Extract host port from "0.0.0.0:5002->5002/tcp" or ":::5002->5002/tcp"
                        if let Some(arrow_pos) = mapping.find("->") {
                            let before_arrow = mapping[..arrow_pos].trim();
                            if let Some(colon_pos) = before_arrow.rfind(':') {
                                if let Ok(port) = before_arrow[colon_pos + 1..].parse::<u16>() {
                                    ports.insert(port);
                                }
                            }
                        }
                    }
                }
            }
        }
        Err(err) => {
            let _ = crate::hub_manager::append_desktop_log(
                "port_manager",
                &format!("docker ps for port discovery failed: {}", err),
            );
        }
    }

    ports
}

/// Find the next available port starting from `start`, treating our own ports as available.
fn find_available_port(start: u16, our_ports: &HashSet<u16>) -> Option<u16> {
    (start..=start.saturating_add(100)).find(|&p| is_port_available_or_ours(p, our_ports))
}

/// Result of port resolution.
pub struct PortResolution {
    /// Environment variable assignments (e.g. API_PORT=5002).
    pub env_vars: HashMap<String, u16>,
    /// Warning messages for the user (fixed-port conflicts).
    pub warnings: Vec<String>,
    /// Info messages (dynamic port reassignments).
    pub info: Vec<String>,
}

/// Resolve all required ports: check availability, reassign dynamic ports if needed.
/// Ports held by our own containers are treated as available (not conflicts).
pub fn resolve_ports() -> Result<PortResolution, String> {
    let our_ports = get_our_container_ports();
    let mut env_vars: HashMap<String, u16> = HashMap::new();
    let mut warnings = Vec::new();
    let mut info = Vec::new();

    // Fixed ports — warn but don't change
    for &(port, var) in FIXED_PORTS {
        env_vars.insert(var.to_string(), port);
        if !is_port_available_or_ours(port, &our_ports) {
            warnings.push(format!(
                "Port {} ({}) is in use. Cloudflare tunnel / public access won't work until freed.",
                port, var
            ));
        }
    }

    // Dynamic ports — auto-resolve
    for &(default_port, var) in DYNAMIC_PORTS {
        if is_port_available_or_ours(default_port, &our_ports) {
            env_vars.insert(var.to_string(), default_port);
        } else {
            let new_port = find_available_port(default_port + 1, &our_ports)
                .ok_or_else(|| format!("Cannot find available port near {} for {}", default_port, var))?;
            info.push(format!(
                "Port {} ({}) occupied — using {} instead",
                default_port, var, new_port
            ));
            env_vars.insert(var.to_string(), new_port);
        }
    }

    Ok(PortResolution {
        env_vars,
        warnings,
        info,
    })
}

/// Write resolved port assignments into the .env file.
/// Preserves existing entries; updates or appends port variables.
pub fn write_ports_to_env(env_path: &Path, resolution: &PortResolution) -> Result<(), String> {
    let existing = std::fs::read_to_string(env_path).unwrap_or_default();
    let mut lines: Vec<String> = existing.lines().map(String::from).collect();

    for (var, port) in &resolution.env_vars {
        let entry = format!("{}={}", var, port);
        if let Some(idx) = lines.iter().position(|l| l.starts_with(&format!("{}=", var))) {
            lines[idx] = entry;
        } else {
            lines.push(entry);
        }
    }

    // Ensure trailing newline
    let content = lines.join("\n") + "\n";
    std::fs::write(env_path, content).map_err(|e| format!("Failed to write .env: {}", e))
}

/// Read the API_PORT from .env (returns default 5002 if not found).
pub fn read_api_port(env_path: &Path) -> u16 {
    std::fs::read_to_string(env_path)
        .ok()
        .and_then(|content| {
            content
                .lines()
                .find(|l| l.starts_with("API_PORT="))
                .and_then(|l| l.strip_prefix("API_PORT="))
                .and_then(|v| v.trim().parse().ok())
        })
        .unwrap_or(5002)
}

/// Re-check saved ports. If a previously saved dynamic port is now occupied,
/// re-resolve only that port and update .env.
///
/// `get_our_container_ports()` now only returns ports from *running* containers,
/// so stopped/zombie containers no longer mask real port conflicts.
pub fn refresh_ports_if_needed(env_path: &Path) -> Result<PortResolution, String> {
    let existing = std::fs::read_to_string(env_path).unwrap_or_default();

    // Check if any dynamic port vars already exist in .env
    let has_port_vars = DYNAMIC_PORTS
        .iter()
        .any(|(_, var)| existing.lines().any(|l| l.starts_with(&format!("{}=", var))));

    if !has_port_vars {
        // First run — full resolution
        let res = resolve_ports()?;
        write_ports_to_env(env_path, &res)?;
        return Ok(res);
    }

    // Subsequent run — only re-resolve ports that are now occupied.
    // `our_ports` only contains ports from running containers, so stopped
    // zombie containers left by Docker Desktop on Windows won't mask
    // real conflicts.
    let our_ports = get_our_container_ports();
    let mut env_vars: HashMap<String, u16> = HashMap::new();
    let mut warnings = Vec::new();
    let mut info = Vec::new();
    let mut changed = false;

    for &(default_port, var) in FIXED_PORTS {
        env_vars.insert(var.to_string(), default_port);
        if !is_port_available_or_ours(default_port, &our_ports) {
            warnings.push(format!(
                "Port {} ({}) is in use. Cloudflare tunnel / public access won't work until freed.",
                default_port, var
            ));
        }
    }

    for &(default_port, var) in DYNAMIC_PORTS {
        // Read current assignment from .env
        let current: u16 = existing
            .lines()
            .find(|l| l.starts_with(&format!("{}=", var)))
            .and_then(|l| l.split('=').nth(1))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(default_port);

        if is_port_available_or_ours(current, &our_ports) {
            env_vars.insert(var.to_string(), current);
        } else {
            // Need to find a new port
            let new_port = find_available_port(default_port, &our_ports)
                .ok_or_else(|| format!("Cannot find available port near {} for {}", default_port, var))?;
            info.push(format!(
                "Port {} ({}) now occupied — reassigned to {}",
                current, var, new_port
            ));
            env_vars.insert(var.to_string(), new_port);
            changed = true;
        }
    }

    let resolution = PortResolution {
        env_vars,
        warnings,
        info,
    };

    // Only write when a dynamic port assignment changed, so existing .env
    // values remain authoritative until a conflict requires reassignment.
    if changed {
        write_ports_to_env(env_path, &resolution)?;
    }

    Ok(resolution)
}
