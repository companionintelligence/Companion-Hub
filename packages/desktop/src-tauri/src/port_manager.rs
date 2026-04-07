use std::collections::HashMap;
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

/// Check if a port is available by attempting a TCP bind.
pub fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Find the next available port starting from `start`.
fn find_available_port(start: u16) -> Option<u16> {
    (start..=start.saturating_add(100)).find(|&p| is_port_available(p))
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
pub fn resolve_ports() -> Result<PortResolution, String> {
    let mut env_vars: HashMap<String, u16> = HashMap::new();
    let mut warnings = Vec::new();
    let mut info = Vec::new();

    // Fixed ports — warn but don't change
    for &(port, var) in FIXED_PORTS {
        env_vars.insert(var.to_string(), port);
        if !is_port_available(port) {
            warnings.push(format!(
                "Port {} ({}) is in use. Cloudflare tunnel / public access won't work until freed.",
                port, var
            ));
        }
    }

    // Dynamic ports — auto-resolve
    for &(default_port, var) in DYNAMIC_PORTS {
        if is_port_available(default_port) {
            env_vars.insert(var.to_string(), default_port);
        } else {
            let new_port = find_available_port(default_port + 1)
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

    // Subsequent run — only re-resolve ports that are now occupied
    let mut env_vars: HashMap<String, u16> = HashMap::new();
    let mut warnings = Vec::new();
    let mut info = Vec::new();
    let mut changed = false;

    for &(default_port, var) in FIXED_PORTS {
        env_vars.insert(var.to_string(), default_port);
        if !is_port_available(default_port) {
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

        if is_port_available(current) {
            env_vars.insert(var.to_string(), current);
        } else {
            // Need to find a new port
            let new_port = find_available_port(default_port)
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

    if changed {
        write_ports_to_env(env_path, &resolution)?;
    }

    Ok(resolution)
}
