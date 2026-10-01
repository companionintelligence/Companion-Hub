use std::collections::HashMap;
use std::collections::HashSet;
use std::io;
use std::net::TcpListener;
use std::path::Path;
#[cfg(target_os = "linux")]
use std::{cell::OnceCell, path::PathBuf};

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

/// What the Hub's Docker engine would find on a host port.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PortState {
    Free,
    Occupied,
    /// Below `net.ipv4.ip_unprivileged_port_start`: a rootless engine publishes as the user,
    /// who may not bind there.
    #[cfg(target_os = "linux")]
    RootlessPrivileged,
}

/// The host's ports as one resolution pass sees them.
struct HostPorts {
    /// Host ports our own running containers publish. A port held by our own
    /// stack is not a conflict — docker compose up will reuse those containers.
    ours: HashSet<u16>,
    /// The bind probe: bind the port on 127.0.0.1 and let it go.
    bind: fn(u16) -> io::Result<()>,
    /// Where the kernel's socket tables live: `/proc`.
    #[cfg(target_os = "linux")]
    proc_root: PathBuf,
    /// Whether the Hub's Docker engine runs rootless: asked at most once a pass,
    /// and only after a refused bind, so the usual path never waits on `docker info`.
    #[cfg(target_os = "linux")]
    rootless_engine: OnceCell<bool>,
}

impl HostPorts {
    fn new(ours: HashSet<u16>) -> Self {
        Self {
            ours,
            bind: bind_loopback,
            #[cfg(target_os = "linux")]
            proc_root: PathBuf::from("/proc"),
            #[cfg(target_os = "linux")]
            rootless_engine: OnceCell::new(),
        }
    }

    /// Check a port by attempting a TCP bind.
    ///
    /// A bind Linux refuses (a normal user may not bind below 1024) says nothing
    /// about the port. A rootful Docker engine publishes as root and can still
    /// use it, so the kernel's listeners decide; a rootless engine is refused
    /// just like the probe.
    fn state(&self, port: u16) -> PortState {
        match (self.bind)(port) {
            Ok(()) => PortState::Free,
            #[cfg(target_os = "linux")]
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
                if *self.rootless_engine.get_or_init(hub_engine_is_rootless) {
                    PortState::RootlessPrivileged
                } else if tcp_port_has_listener(&self.proc_root, port) {
                    PortState::Occupied
                } else {
                    PortState::Free
                }
            }
            Err(_) => PortState::Occupied,
        }
    }

    /// Check if a port is available OR held by our own containers.
    fn is_available_or_ours(&self, port: u16) -> bool {
        self.ours.contains(&port) || self.state(port) == PortState::Free
    }
}

fn bind_loopback(port: u16) -> io::Result<()> {
    TcpListener::bind(("127.0.0.1", port)).map(drop)
}

/// Whether the Hub's Docker engine runs rootless. The pin knows only when it found
/// the engine by its per-user socket: the `rootless` docker context that
/// dockerd-rootless-setuptool.sh creates and selects is pinned as `other`. So ask
/// the engine too.
#[cfg(target_os = "linux")]
fn hub_engine_is_rootless() -> bool {
    if crate::docker_engine::pinned_engine()
        .is_some_and(|engine| engine.kind == crate::docker_engine::DockerEngineKind::Rootless)
    {
        return true;
    }
    crate::hub_manager::docker_command()
        .args(["info", "--format", "{{json .SecurityOptions}}"])
        .output()
        .is_ok_and(|output| {
            output.status.success()
                && security_options_say_rootless(&String::from_utf8_lossy(&output.stdout))
        })
}

/// `docker info --format '{{json .SecurityOptions}}'` of a rootless engine lists `name=rootless`.
#[cfg(target_os = "linux")]
fn security_options_say_rootless(security_options: &str) -> bool {
    serde_json::from_str::<Vec<String>>(security_options.trim()).is_ok_and(|options| {
        options
            .iter()
            .any(|option| option.split(',').any(|field| field == "name=rootless"))
    })
}

/// Socket state `0A` in `/proc/net/tcp` and `/proc/net/tcp6`: the kernel's TCP_LISTEN.
#[cfg(target_os = "linux")]
const PROC_NET_TCP_LISTEN: &str = "0A";

/// Does a `/proc/net/tcp` or `/proc/net/tcp6` table list a socket listening on `port`?
///
/// Each row's local address ends in the port as four hex digits (`0100007F:1F90`
/// is 127.0.0.1:8080), and the fourth column is the socket state. The header row
/// matches no state, so it is skipped.
#[cfg(target_os = "linux")]
fn proc_net_tcp_has_listener(table: &str, port: u16) -> bool {
    table.lines().any(|row| {
        let columns: Vec<&str> = row.split_whitespace().collect();
        let (Some(local_address), Some(state)) = (columns.get(1), columns.get(3)) else {
            return false;
        };
        let hex_port = local_address.rsplit(':').next().unwrap_or_default();
        state.eq_ignore_ascii_case(PROC_NET_TCP_LISTEN)
            && hex_port.len() == 4
            && hex_port.bytes().all(|byte| byte.is_ascii_hexdigit())
            && u16::from_str_radix(hex_port, 16) == Ok(port)
    })
}

/// Is anything listening on TCP `port`, by the kernel's tables under `proc_root`?
#[cfg(target_os = "linux")]
fn tcp_port_has_listener(proc_root: &Path, port: u16) -> bool {
    ["tcp", "tcp6"].iter().any(|table| {
        // A kernel without IPv6 has no tcp6 table, and so no listener to report there.
        std::fs::read_to_string(proc_root.join("net").join(table))
            .is_ok_and(|content| proc_net_tcp_has_listener(&content, port))
    })
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
pub fn resolve_ports() -> Result<PortResolution, String> {
    resolve_ports_on(&HostPorts::new(get_our_container_ports()))
}

fn resolve_ports_on(host: &HostPorts) -> Result<PortResolution, String> {
    let mut env_vars: HashMap<String, u16> = HashMap::new();
    let mut assigned_ports: HashSet<u16> = HashSet::new();
    let warnings = Vec::new();
    let mut info = Vec::new();

    // Fixed ports — reassign to a free host port when the engine cannot publish them.
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
            info.push(fixed_port_moved(port, var, new_port, host.state(port)));
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
        return Ok((resolve_ports_on(host)?, true));
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
            info.push(fixed_port_moved(
                current,
                var,
                new_port,
                host.state(current),
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

/// Why a fixed port's host binding moved: a rootless engine cannot publish a
/// privileged port even when nothing holds it.
fn fixed_port_moved(port: u16, var: &str, new_port: u16, state: PortState) -> String {
    let why = match state {
        #[cfg(target_os = "linux")]
        PortState::RootlessPrivileged => {
            format!("Rootless Docker cannot publish privileged port {port} ({var})")
        }
        _ => format!("Port {port} ({var}) occupied by another process"),
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

    #[test]
    fn a_bind_that_fails_for_another_reason_means_occupied() {
        let host = HostPorts {
            bind: |_| Err(io::ErrorKind::AddrInUse.into()),
            ..HostPorts::new(HashSet::new())
        };
        assert_eq!(host.state(8880), PortState::Occupied);
    }

    /// `/proc/net/tcp`: 127.0.0.1:8080 listening, and an established connection from local port 80.
    #[cfg(target_os = "linux")]
    const PROC_NET_TCP: &str = concat!(
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n",
        "   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41275 1 0000000000000000 100 0 0 10 0\n",
        "   1: 0100007F:0050 0100007F:A1B2 01 00000000:00000000 00:00000000 00000000  1000        0 41276 1 0000000000000000 20 4 30 10 -1\n",
        "   2: 0100007F:0035 0100007F:C3D4 06 00000000:00000000 03:00001524 00000000     0        0 0 3 0000000000000000\n",
    );

    /// `/proc/net/tcp6`: [::]:443 listening.
    #[cfg(target_os = "linux")]
    const PROC_NET_TCP6: &str = concat!(
        "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n",
        "   0: 00000000000000000000000000000000:01BB 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 22817 1 0000000000000000 100 0 0 10 0\n",
    );

    /// A fake `/proc` holding only the TCP tables.
    #[cfg(target_os = "linux")]
    fn fake_proc(tcp: &str, tcp6: Option<&str>) -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir(root.path().join("net")).expect("net dir");
        std::fs::write(root.path().join("net").join("tcp"), tcp).expect("tcp table");
        if let Some(tcp6) = tcp6 {
            std::fs::write(root.path().join("net").join("tcp6"), tcp6).expect("tcp6 table");
        }
        root
    }

    /// A normal user's bind on Linux: refused below `ip_unprivileged_port_start` (1024).
    #[cfg(target_os = "linux")]
    fn refused_below_1024(port: u16) -> io::Result<()> {
        if port < 1024 {
            Err(io::ErrorKind::PermissionDenied.into())
        } else {
            Ok(())
        }
    }

    /// Linux as a normal user sees it, with the kernel's tables in `proc_root`.
    #[cfg(target_os = "linux")]
    fn linux_user_host(proc_root: &Path, rootless_engine: bool) -> HostPorts {
        HostPorts {
            bind: refused_below_1024,
            proc_root: proc_root.to_path_buf(),
            rootless_engine: OnceCell::from(rootless_engine),
            ..HostPorts::new(HashSet::new())
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn proc_net_tcp_lists_listeners_by_port_and_state() {
        assert!(proc_net_tcp_has_listener(PROC_NET_TCP, 8080));
        assert!(proc_net_tcp_has_listener(PROC_NET_TCP6, 443));
        // 80 is ESTABLISHED (01) and 53 is TIME_WAIT (06).
        assert!(!proc_net_tcp_has_listener(PROC_NET_TCP, 80));
        assert!(!proc_net_tcp_has_listener(PROC_NET_TCP, 53));
        assert!(!proc_net_tcp_has_listener(PROC_NET_TCP, 8081));
        // 0x90 is the tail of 0x1F90, and must not match it.
        assert!(!proc_net_tcp_has_listener(PROC_NET_TCP, 0x90));
        assert!(!proc_net_tcp_has_listener(PROC_NET_TCP6, 80));
        assert!(!proc_net_tcp_has_listener("", 8080));
        let header = PROC_NET_TCP.lines().next().expect("header");
        assert!(!proc_net_tcp_has_listener(header, 8080));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_both_kernel_tables_and_a_kernel_without_ipv6() {
        let both = fake_proc(PROC_NET_TCP, Some(PROC_NET_TCP6));
        assert!(tcp_port_has_listener(both.path(), 8080));
        assert!(tcp_port_has_listener(both.path(), 443));
        assert!(!tcp_port_has_listener(both.path(), 80));

        let ipv4_only = fake_proc(PROC_NET_TCP, None);
        assert!(tcp_port_has_listener(ipv4_only.path(), 8080));
        assert!(!tcp_port_has_listener(ipv4_only.path(), 443));

        let no_tables = tempfile::tempdir().expect("tempdir");
        assert!(!tcp_port_has_listener(no_tables.path(), 8080));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_refused_privileged_bind_is_decided_by_the_listeners() {
        let proc_root = fake_proc(PROC_NET_TCP, Some(PROC_NET_TCP6));
        let host = linux_user_host(proc_root.path(), false);
        assert_eq!(host.state(80), PortState::Free);
        assert_eq!(host.state(443), PortState::Occupied);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_rootless_engine_cannot_use_a_privileged_port_nothing_listens_on() {
        let proc_root = fake_proc(PROC_NET_TCP, Some(PROC_NET_TCP6));
        let host = linux_user_host(proc_root.path(), true);
        assert_eq!(host.state(80), PortState::RootlessPrivileged);
        assert_eq!(host.state(8880), PortState::Free);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_rootless_from_the_engines_security_options() {
        assert!(security_options_say_rootless(
            r#"["name=apparmor","name=seccomp,profile=builtin","name=rootless","name=cgroupns"]"#
        ));
        assert!(security_options_say_rootless(
            "[\"name=rootless\",\"name=cgroupns\"]\n"
        ));
        assert!(!security_options_say_rootless(
            r#"["name=apparmor","name=seccomp,profile=builtin","name=cgroupns"]"#
        ));
        assert!(!security_options_say_rootless("null"));
        assert!(!security_options_say_rootless(""));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fresh_install_on_a_rootful_engine_takes_80_and_moves_only_a_port_in_use() {
        let proc_root = fake_proc(PROC_NET_TCP, Some(PROC_NET_TCP6));
        let resolution =
            resolve_ports_on(&linux_user_host(proc_root.path(), false)).expect("resolution");
        assert_eq!(resolution.env_vars["HTTP_PORT"], 80);
        assert_eq!(resolution.env_vars["HTTPS_PORT"], 8443);
        assert_eq!(
            resolution.info,
            vec!["Port 443 (HTTPS_PORT) occupied by another process — using host port 8443 (Public Web via Cloudflare is unaffected)"]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_fresh_install_on_a_rootless_engine_keeps_8880_and_8443_and_says_why() {
        let proc_root = fake_proc(PROC_NET_TCP, None);
        let resolution =
            resolve_ports_on(&linux_user_host(proc_root.path(), true)).expect("resolution");
        assert_eq!(resolution.env_vars["HTTP_PORT"], 8880);
        assert_eq!(resolution.env_vars["HTTPS_PORT"], 8443);
        assert_eq!(
            resolution.info,
            vec![
                "Rootless Docker cannot publish privileged port 80 (HTTP_PORT) — using host port 8880 (Public Web via Cloudflare is unaffected)",
                "Rootless Docker cannot publish privileged port 443 (HTTPS_PORT) — using host port 8443 (Public Web via Cloudflare is unaffected)",
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_install_on_8880_stays_there_once_port_80_is_usable() {
        let proc_root = fake_proc(PROC_NET_TCP, None);
        let host = linux_user_host(proc_root.path(), false);
        assert_eq!(host.state(80), PortState::Free);

        let env = "HTTP_PORT=8880\nHTTPS_PORT=8443\nAPI_PORT=5002\nPOSTGRES_PORT=6543\nRABBITMQ_PORT=5001\nTRAEFIK_DASHBOARD_PORT=8080\n";
        let (resolution, changed) = refresh_ports(env, &host).expect("resolution");
        assert_eq!(resolution.env_vars["HTTP_PORT"], 8880);
        assert_eq!(resolution.env_vars["HTTPS_PORT"], 8443);
        assert!(resolution.info.is_empty(), "{:?}", resolution.info);
        assert!(!changed);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_install_whose_8880_is_taken_returns_to_80_and_says_8880_is_occupied() {
        let proc_root = fake_proc(PROC_NET_TCP, None);
        let host = HostPorts {
            bind: |port| match port {
                8880 => Err(io::ErrorKind::AddrInUse.into()),
                _ => refused_below_1024(port),
            },
            ..linux_user_host(proc_root.path(), false)
        };

        let (resolution, changed) =
            refresh_ports("HTTP_PORT=8880\nHTTPS_PORT=8443\nAPI_PORT=5002\n", &host)
                .expect("resolution");
        assert_eq!(resolution.env_vars["HTTP_PORT"], 80);
        assert_eq!(
            resolution.info,
            vec!["Port 8880 (HTTP_PORT) occupied — restored default host port 80"]
        );
        assert!(changed);
    }
}
