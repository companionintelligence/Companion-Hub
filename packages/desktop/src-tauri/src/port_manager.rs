use std::collections::HashMap;
use std::collections::HashSet;
use std::net::TcpListener;
use std::path::Path;

use crate::hub_names::{HUB_CONTAINER, HUB_QUEUE, LEGACY_HUB_CONTAINER, LEGACY_HUB_QUEUE};

/// Default host bindings for Traefik HTTP/HTTPS. Cloudflare Public Web routes to
/// `traefik:80` / `traefik:443` on the Docker network, so host ports can be
/// reassigned when 80/443 are occupied by another process.
const FIXED_PORTS: &[(u16, &str)] = &[(80, "HTTP_PORT"), (443, "HTTPS_PORT")];

/// Fallback host ports when 80/443 cannot be freed (avoid TRAEFIK_DASHBOARD_PORT 8080).
const HTTP_PORT_FALLBACK_START: u16 = 8880;
const HTTPS_PORT_FALLBACK_START: u16 = 8443;

/// Ports that can be dynamically reassigned if occupied.
const DYNAMIC_PORTS: &[(u16, &str)] = &[
    (5002, "API_PORT"),
    (6543, "POSTGRES_PORT"),
    (5001, "RABBITMQ_PORT"),
    (8080, "TRAEFIK_DASHBOARD_PORT"),
];

/// Container names managed by our compose stack (used as docker ps filters).
const OUR_CONTAINERS: &[&str] = &[
    HUB_CONTAINER,
    LEGACY_HUB_CONTAINER,
    "ci-hub-db",
    HUB_QUEUE,
    LEGACY_HUB_QUEUE,
    "traefik",
    "cloudflared",
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

fn can_assign_port(port: u16, our_ports: &HashSet<u16>, assigned_ports: &HashSet<u16>) -> bool {
    !assigned_ports.contains(&port) && is_port_available_or_ours(port, our_ports)
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

    let output = crate::hub_manager::docker_command().args(&args).output();

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

/// Find the next available port starting from `start`, treating our own ports as
/// available but never reusing a host port already assigned in this resolution pass.
fn find_available_port(
    start: u16,
    our_ports: &HashSet<u16>,
    assigned_ports: &HashSet<u16>,
) -> Option<u16> {
    (start..=start.saturating_add(100)).find(|&p| can_assign_port(p, our_ports, assigned_ports))
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
    let mut assigned_ports: HashSet<u16> = HashSet::new();
    let warnings = Vec::new();
    let mut info = Vec::new();

    // Fixed ports — reassign to a free host port when blocked by a non-Hub process.
    for &(port, var) in FIXED_PORTS {
        if can_assign_port(port, &our_ports, &assigned_ports) {
            env_vars.insert(var.to_string(), port);
            assigned_ports.insert(port);
        } else {
            let fallback_start = fixed_port_fallback_start(port);
            let new_port = find_available_port(fallback_start, &our_ports, &assigned_ports)
                .ok_or_else(|| {
                    format!(
                        "Cannot find available host port near {} for {} (default {} is occupied)",
                        fallback_start, var, port
                    )
                })?;
            info.push(format!(
                "Port {} ({}) occupied by another process — using host port {} (Public Web via Cloudflare is unaffected)",
                port, var, new_port
            ));
            env_vars.insert(var.to_string(), new_port);
            assigned_ports.insert(new_port);
        }
    }

    // Dynamic ports — auto-resolve
    for &(default_port, var) in DYNAMIC_PORTS {
        if can_assign_port(default_port, &our_ports, &assigned_ports) {
            env_vars.insert(var.to_string(), default_port);
            assigned_ports.insert(default_port);
        } else {
            let new_port = find_available_port(default_port + 1, &our_ports, &assigned_ports)
                .ok_or_else(|| {
                    format!(
                        "Cannot find available port near {} for {}",
                        default_port, var
                    )
                })?;
            info.push(format!(
                "Port {} ({}) occupied — using {} instead",
                default_port, var, new_port
            ));
            env_vars.insert(var.to_string(), new_port);
            assigned_ports.insert(new_port);
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
        if let Some(idx) = lines
            .iter()
            .position(|l| l.starts_with(&format!("{}=", var)))
        {
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
    let has_port_vars = DYNAMIC_PORTS.iter().any(|(_, var)| {
        existing
            .lines()
            .any(|l| l.starts_with(&format!("{}=", var)))
    });

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
    let mut assigned_ports: HashSet<u16> = HashSet::new();
    let warnings = Vec::new();
    let mut info = Vec::new();
    let mut changed = false;

    for &(default_port, var) in FIXED_PORTS {
        let current: u16 = existing
            .lines()
            .find(|l| l.starts_with(&format!("{}=", var)))
            .and_then(|l| l.split('=').nth(1))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(default_port);

        if can_assign_port(current, &our_ports, &assigned_ports) {
            env_vars.insert(var.to_string(), current);
            assigned_ports.insert(current);
        } else if can_assign_port(default_port, &our_ports, &assigned_ports) {
            if current != default_port {
                info.push(format!(
                    "Port {} ({}) now free — restored default host port {}",
                    current, var, default_port
                ));
                changed = true;
            }
            env_vars.insert(var.to_string(), default_port);
            assigned_ports.insert(default_port);
        } else {
            let fallback_start = fixed_port_fallback_start(default_port);
            let new_port = find_available_port(fallback_start, &our_ports, &assigned_ports)
                .ok_or_else(|| {
                    format!(
                        "Cannot find available host port near {} for {} ({} is occupied)",
                        fallback_start, var, default_port
                    )
                })?;
            info.push(format!(
                "Port {} ({}) occupied — using host port {} instead",
                if current == default_port {
                    default_port
                } else {
                    current
                },
                var,
                new_port
            ));
            env_vars.insert(var.to_string(), new_port);
            assigned_ports.insert(new_port);
            changed = true;
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

        if can_assign_port(current, &our_ports, &assigned_ports) {
            env_vars.insert(var.to_string(), current);
            assigned_ports.insert(current);
        } else {
            // Need to find a new port
            let new_port = find_available_port(default_port, &our_ports, &assigned_ports)
                .ok_or_else(|| {
                    format!(
                        "Cannot find available port near {} for {}",
                        default_port, var
                    )
                })?;
            info.push(format!(
                "Port {} ({}) now occupied — reassigned to {}",
                current, var, new_port
            ));
            env_vars.insert(var.to_string(), new_port);
            assigned_ports.insert(new_port);
            changed = true;
        }
    }

    let resolution = PortResolution {
        env_vars,
        warnings,
        info,
    };

    // Write when any port assignment changed so compose sees the updated bindings.
    if changed {
        write_ports_to_env(env_path, &resolution)?;
    }

    Ok(resolution)
}

fn fixed_port_fallback_start(default_port: u16) -> u16 {
    match default_port {
        80 => HTTP_PORT_FALLBACK_START,
        443 => HTTPS_PORT_FALLBACK_START,
        other => other.saturating_add(1000),
    }
}

/// Parse the host port from a Docker "ports are not available" / bind error.
pub fn parse_bind_conflict_port(output: &str) -> Option<u16> {
    // "exposing port TCP 0.0.0.0:80 -> ..." or "Bind for 0.0.0.0:443 failed"
    for token in output.split_whitespace() {
        if let Some(host_part) = token.strip_prefix("0.0.0.0:") {
            if let Ok(port) = host_part
                .trim_end_matches(|c: char| !c.is_ascii_digit())
                .parse()
            {
                return Some(port);
            }
        }
        if let Some(host_part) = token.strip_prefix("[::]:") {
            if let Ok(port) = host_part
                .trim_end_matches(|c: char| !c.is_ascii_digit())
                .parse()
            {
                return Some(port);
            }
        }
    }

    let lower = output.to_lowercase();
    if lower.contains(":80") || lower.contains("port 80") {
        return Some(80);
    }
    if lower.contains(":443") || lower.contains("port 443") {
        return Some(443);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_traefik_port_eighty_bind_error() {
        let output = r#"Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:80 -> 127.0.0.1:0: listen tcp 0.0.0.0:80: bind: address already in use"#;
        assert_eq!(parse_bind_conflict_port(output), Some(80));
    }

    #[test]
    fn parses_https_bind_error() {
        let output = r#"Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:443 -> 127.0.0.1:0: listen tcp 0.0.0.0:443: bind: address already in use"#;
        assert_eq!(parse_bind_conflict_port(output), Some(443));
    }

    #[test]
    fn fixed_port_fallback_avoids_dashboard_port() {
        assert_eq!(fixed_port_fallback_start(80), 8880);
        assert_eq!(fixed_port_fallback_start(443), 8443);
    }

    #[test]
    fn avoids_reusing_ports_already_assigned_in_same_resolution_pass() {
        let our_ports = HashSet::new();
        let mut assigned_ports = HashSet::from([5002]);

        let port = find_available_port(5002, &our_ports, &assigned_ports);

        let next_port = port.expect("port");
        assert_ne!(next_port, 5002);
        assigned_ports.insert(next_port);
        assert!(!can_assign_port(5002, &our_ports, &assigned_ports));
        assert!(!can_assign_port(next_port, &our_ports, &assigned_ports));
    }
}
