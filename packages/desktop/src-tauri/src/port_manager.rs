use std::collections::HashMap;
use std::collections::HashSet;
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, TcpListener};
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

/// The host's ports as one resolution pass sees them.
struct HostPorts {
    /// Host ports our own running containers publish. A port held by our own
    /// stack is not a conflict — docker compose up will reuse those containers.
    ours: HashSet<u16>,
    /// Bind the port on each address Docker may publish it on, and let it go.
    bind: fn(u16) -> io::Result<()>,
}

impl HostPorts {
    fn new(ours: HashSet<u16>) -> Self {
        Self {
            ours,
            bind: bind_host_port,
        }
    }

    /// Check if a port is available by attempting a TCP bind, OR held by our own containers.
    ///
    /// Any failed bind makes the port unavailable, including Linux refusing a normal
    /// user a port below 1024 whether or not anything listens there. The app picks its
    /// ports again on every launch, so taking a free 80/443 would move every existing
    /// Linux desktop Hub off 8880/8443.
    fn is_available_or_ours(&self, port: u16) -> bool {
        self.ours.contains(&port) || (self.bind)(port).is_ok()
    }

    /// Did Linux refuse the bind because the port is below 1024 and this user is not root?
    fn refused_by_linux(&self, port: u16) -> bool {
        cfg!(target_os = "linux")
            && port < 1024
            && (self.bind)(port).is_err_and(|error| error.kind() == io::ErrorKind::PermissionDenied)
    }
}

/// Binds the port on 127.0.0.1, 0.0.0.0 and [::] in turn. Docker Desktop publishes on the
/// wildcard addresses and the WSL engine's relay on loopback, and Windows lets a bind on
/// 127.0.0.1 succeed while another program listens on 0.0.0.0 or [::], so loopback alone missed
/// a port that was already taken. A host without IPv6 has nothing listening on [::].
fn bind_host_port(port: u16) -> io::Result<()> {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).map(drop)?;
    TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).map(drop)?;
    match TcpListener::bind((Ipv6Addr::UNSPECIFIED, port)) {
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::AddrInUse | io::ErrorKind::PermissionDenied
            ) =>
        {
            Err(error)
        }
        _ => Ok(()),
    }
}

fn can_assign_port(port: u16, host: &HostPorts, assigned_ports: &HashSet<u16>) -> bool {
    !assigned_ports.contains(&port) && host.is_available_or_ours(port)
}

/// Query Docker for host ports currently bound by our *running* managed
/// containers.  Only running/restarting containers are genuinely holding
/// their ports; stopped containers may leave ghost port registrations on
/// Docker Desktop for Windows that confuse `HostPorts::is_available_or_ours`.
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
fn find_available_port(start: u16, host: &HostPorts, assigned_ports: &HashSet<u16>) -> Option<u16> {
    (start..=start.saturating_add(100)).find(|&p| can_assign_port(p, host, assigned_ports))
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
fn resolve_ports(host: &HostPorts) -> Result<PortResolution, String> {
    let mut env_vars: HashMap<String, u16> = HashMap::new();
    let mut assigned_ports: HashSet<u16> = HashSet::new();
    let warnings = Vec::new();
    let mut info = Vec::new();

    // Fixed ports — reassign to a free host port when blocked by a non-Hub process.
    for &(port, var) in FIXED_PORTS {
        if can_assign_port(port, host, &assigned_ports) {
            env_vars.insert(var.to_string(), port);
            assigned_ports.insert(port);
        } else {
            let fallback_start = fixed_port_fallback_start(port);
            let new_port = find_available_port(fallback_start, host, &assigned_ports)
                .ok_or_else(|| {
                    format!(
                        "Cannot find available host port near {} for {} (default {} is unavailable)",
                        fallback_start, var, port
                    )
                })?;
            info.push(fixed_port_moved(port, var, new_port, host));
            env_vars.insert(var.to_string(), new_port);
            assigned_ports.insert(new_port);
        }
    }

    // Dynamic ports — auto-resolve
    for &(default_port, var) in DYNAMIC_PORTS {
        if can_assign_port(default_port, host, &assigned_ports) {
            env_vars.insert(var.to_string(), default_port);
            assigned_ports.insert(default_port);
        } else {
            let new_port = find_available_port(default_port + 1, host, &assigned_ports)
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
    let (resolution, changed) =
        refresh_ports(&existing, &HostPorts::new(get_our_container_ports()))?;

    // Write when any port assignment changed so compose sees the updated bindings.
    if changed {
        write_ports_to_env(env_path, &resolution)?;
    }

    Ok(resolution)
}

/// [`refresh_ports_if_needed`] for the env file's content: the resolution, and
/// whether it changed any assignment.
fn refresh_ports(existing: &str, host: &HostPorts) -> Result<(PortResolution, bool), String> {
    // Check if any dynamic port vars already exist in .env
    let has_port_vars = DYNAMIC_PORTS.iter().any(|(_, var)| {
        existing
            .lines()
            .any(|l| l.starts_with(&format!("{}=", var)))
    });

    if !has_port_vars {
        // First run — full resolution
        return Ok((resolve_ports(host)?, true));
    }

    // Subsequent run — only re-resolve ports that are now occupied.
    // `host.ours` only contains ports from running containers, so stopped
    // zombie containers left by Docker Desktop on Windows won't mask
    // real conflicts.
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

        if can_assign_port(current, host, &assigned_ports) {
            env_vars.insert(var.to_string(), current);
            assigned_ports.insert(current);
        } else if can_assign_port(default_port, host, &assigned_ports) {
            if current != default_port {
                info.push(format!(
                    "Port {} ({}) occupied — restored default host port {}",
                    current, var, default_port
                ));
                changed = true;
            }
            env_vars.insert(var.to_string(), default_port);
            assigned_ports.insert(default_port);
        } else {
            let fallback_start = fixed_port_fallback_start(default_port);
            let new_port =
                find_available_port(fallback_start, host, &assigned_ports).ok_or_else(|| {
                    format!(
                        "Cannot find available host port near {} for {} ({} is unavailable)",
                        fallback_start, var, default_port
                    )
                })?;
            info.push(fixed_port_moved(current, var, new_port, host));
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

        if can_assign_port(current, host, &assigned_ports) {
            env_vars.insert(var.to_string(), current);
            assigned_ports.insert(current);
        } else {
            // Need to find a new port
            let new_port =
                find_available_port(default_port, host, &assigned_ports).ok_or_else(|| {
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

    Ok((resolution, changed))
}

/// Why a fixed port's host binding moved.
fn fixed_port_moved(port: u16, var: &str, new_port: u16, host: &HostPorts) -> String {
    let why = if host.refused_by_linux(port) {
        format!("Port {port} ({var}) is below 1024, which only root can open on Linux")
    } else {
        format!("Port {port} ({var}) occupied by another process")
    };
    format!("{why} — using host port {new_port} (Public Web via Cloudflare is unaffected)")
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
        let host = HostPorts::new(HashSet::new());
        let mut assigned_ports = HashSet::from([5002]);

        let port = find_available_port(5002, &host, &assigned_ports);

        let next_port = port.expect("port");
        assert_ne!(next_port, 5002);
        assigned_ports.insert(next_port);
        assert!(!can_assign_port(5002, &host, &assigned_ports));
        assert!(!can_assign_port(next_port, &host, &assigned_ports));
    }

    /// A normal user's bind on Linux: refused below 1024 (`ip_unprivileged_port_start`).
    #[cfg(target_os = "linux")]
    fn refused_below_1024(port: u16) -> io::Result<()> {
        if port < 1024 {
            Err(io::ErrorKind::PermissionDenied.into())
        } else {
            Ok(())
        }
    }

    #[cfg(target_os = "linux")]
    const REFUSED_80_AND_443: [&str; 2] = [
        "Port 80 (HTTP_PORT) is below 1024, which only root can open on Linux — using host port 8880 (Public Web via Cloudflare is unaffected)",
        "Port 443 (HTTPS_PORT) is below 1024, which only root can open on Linux — using host port 8443 (Public Web via Cloudflare is unaffected)",
    ];

    #[cfg(target_os = "linux")]
    #[test]
    fn a_new_install_takes_8880_and_8443_when_linux_refuses_80_and_443() {
        let host = HostPorts {
            bind: refused_below_1024,
            ..HostPorts::new(HashSet::new())
        };

        let resolution = resolve_ports(&host).expect("resolution");

        assert_eq!(resolution.env_vars["HTTP_PORT"], 8880);
        assert_eq!(resolution.env_vars["HTTPS_PORT"], 8443);
        assert_eq!(resolution.info, REFUSED_80_AND_443);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_install_on_80_and_443_moves_to_8880_and_8443_when_linux_refuses_them() {
        let host = HostPorts {
            bind: refused_below_1024,
            ..HostPorts::new(HashSet::new())
        };

        let (resolution, changed) =
            refresh_ports("HTTP_PORT=80\nHTTPS_PORT=443\nAPI_PORT=5002\n", &host)
                .expect("resolution");

        assert_eq!(resolution.env_vars["HTTP_PORT"], 8880);
        assert_eq!(resolution.env_vars["HTTPS_PORT"], 8443);
        assert_eq!(resolution.info, REFUSED_80_AND_443);
        assert!(changed);
    }

    /// The desktop app picks its ports again on every launch (`initialize_hub`
    /// rewrites the env file without them), so a port Linux refuses must never
    /// read as free here, or every Linux desktop Hub moves off 8880/8443 to
    /// 80/443 at its next start. Checked against the real kernel.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_port_linux_refuses_is_never_free_to_the_desktop_app() {
        let refused = |port: u16| {
            TcpListener::bind(("127.0.0.1", port))
                .is_err_and(|error| error.kind() == io::ErrorKind::PermissionDenied)
        };
        if !(refused(80) && refused(443)) {
            eprintln!("skipped: this user may bind ports 80 and 443 here");
            return;
        }
        // The Hub's own containers hold its other ports, so only 80 and 443 are bound.
        let host = HostPorts::new(HashSet::from([8880, 8443, 5002, 6543, 5001, 8080]));

        assert!(!host.is_available_or_ours(80));
        assert!(!host.is_available_or_ours(443));
        let resolution = resolve_ports(&host).expect("resolution");
        assert_eq!(resolution.env_vars["HTTP_PORT"], 8880);
        assert_eq!(resolution.env_vars["HTTPS_PORT"], 8443);
    }

    /// Windows lets a bind on 127.0.0.1 succeed while another program listens on the same port
    /// on 0.0.0.0 or [::], so a check on loopback alone handed the Hub a port that `localhost`
    /// and the PC's other addresses split between two programs. Checked against real sockets.
    #[test]
    fn a_port_another_program_holds_on_a_wildcard_address_is_not_free() {
        use std::net::IpAddr;

        let host = HostPorts::new(HashSet::new());
        let mut read_as_free = Vec::new();
        for wildcard in [
            IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            IpAddr::V6(Ipv6Addr::UNSPECIFIED),
        ] {
            let Ok(holder) = TcpListener::bind((wildcard, 0)) else {
                eprintln!("skipped {wildcard}: this host can't listen there");
                continue;
            };
            let port = holder.local_addr().expect("held port").port();
            if host.is_available_or_ours(port) {
                read_as_free.push(format!("port {port} held on {wildcard}"));
            }
        }

        assert!(read_as_free.is_empty(), "read as free: {read_as_free:?}");
    }

    #[test]
    fn a_port_in_use_falls_back_and_says_another_process_holds_it() {
        let host = HostPorts {
            bind: |port| match port {
                80 | 8880 => Err(io::ErrorKind::AddrInUse.into()),
                _ => Ok(()),
            },
            ..HostPorts::new(HashSet::new())
        };

        let resolution = resolve_ports(&host).expect("new install");
        assert_eq!(resolution.env_vars["HTTP_PORT"], 8881);
        assert_eq!(resolution.env_vars["HTTPS_PORT"], 443);
        assert_eq!(
            resolution.info,
            ["Port 80 (HTTP_PORT) occupied by another process — using host port 8881 (Public Web via Cloudflare is unaffected)"]
        );

        let (resolution, changed) =
            refresh_ports("HTTP_PORT=8880\nHTTPS_PORT=443\nAPI_PORT=5002\n", &host)
                .expect("existing install");
        assert_eq!(resolution.env_vars["HTTP_PORT"], 8881);
        assert_eq!(
            resolution.info,
            ["Port 8880 (HTTP_PORT) occupied by another process — using host port 8881 (Public Web via Cloudflare is unaffected)"]
        );
        assert!(changed);
    }

    #[test]
    fn an_install_whose_8880_is_taken_returns_to_a_free_80_and_says_8880_is_occupied() {
        let host = HostPorts {
            bind: |port| match port {
                8880 => Err(io::ErrorKind::AddrInUse.into()),
                _ => Ok(()),
            },
            ..HostPorts::new(HashSet::new())
        };

        let (resolution, changed) =
            refresh_ports("HTTP_PORT=8880\nHTTPS_PORT=8443\nAPI_PORT=5002\n", &host)
                .expect("resolution");

        assert_eq!(resolution.env_vars["HTTP_PORT"], 80);
        assert_eq!(resolution.env_vars["HTTPS_PORT"], 8443);
        assert_eq!(
            resolution.info,
            ["Port 8880 (HTTP_PORT) occupied — restored default host port 80"]
        );
        assert!(changed);
    }

    #[test]
    fn with_no_free_fallback_port_the_error_calls_the_default_unavailable() {
        let host = HostPorts {
            bind: |_| Err(io::ErrorKind::AddrInUse.into()),
            ..HostPorts::new(HashSet::new())
        };

        assert_eq!(
            resolve_ports(&host).err().as_deref(),
            Some("Cannot find available host port near 8880 for HTTP_PORT (default 80 is unavailable)")
        );
        assert_eq!(
            refresh_ports("HTTP_PORT=8880\nAPI_PORT=5002\n", &host)
                .err()
                .as_deref(),
            Some("Cannot find available host port near 8880 for HTTP_PORT (80 is unavailable)")
        );
    }
}
