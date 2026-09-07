//! Service state derivation, startup progress and hub status.

use super::*;

fn list_local_images() -> std::collections::HashSet<String> {
    let output = docker_command()
        .args(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.ends_with(":<none>"))
        .map(ToOwned::to_owned)
        .collect()
}

fn required_startup_images() -> Vec<String> {
    let env = parse_env_file(&hub_env_path());
    let hub_image = env
        .get("CI_HUB_IMAGE")
        .cloned()
        .unwrap_or_else(|| default_hub_image().to_string());

    let mut out = vec![
        hub_image,
        "postgres:14".to_string(),
        "rabbitmq:4-alpine".to_string(),
        "traefik:v3.6.7".to_string(),
    ];
    if private_vpn_enabled_from_map(&env) {
        out.push("tailscale/tailscale:v1.82.5".to_string());
    }
    out
}

/// Query Docker for a list of container states in one `docker inspect` call.
/// Returns a map of container_name → (state, health).
fn inspect_containers(names: &[&str]) -> std::collections::HashMap<String, (String, String)> {
    let mut map = std::collections::HashMap::new();
    if names.is_empty() {
        return map;
    }
    let format = "{{.Name}}:{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}";
    let output = docker_command()
        .arg("inspect")
        .arg("--format")
        .arg(format)
        .args(names)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    for line in output.lines() {
        // Docker prefixes the name with "/" in inspect output
        let line = line.trim().trim_start_matches('/');
        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() == 3 {
            map.insert(
                parts[0].to_string(),
                (parts[1].to_string(), parts[2].to_string()),
            );
        }
    }
    map
}

/// Derive a ServiceState from raw Docker state/health strings.
fn derive_service_state(state: &str, health: &str) -> ServiceState {
    match state {
        "running" => {
            if health == "healthy" || health == "none" {
                ServiceState::Ready
            } else {
                ServiceState::Starting
            }
        }
        "created" | "restarting" => ServiceState::Starting,
        "exited" | "dead" => ServiceState::Failed,
        _ => ServiceState::Pending,
    }
}

/// Translate a service state to a progress score used by averaged startup progress.
///
/// Pending means the container likely does not exist yet (pull/create still in progress),
/// so we keep a small non-zero floor to indicate startup has begun.
fn service_state_score(state: &ServiceState) -> u8 {
    match state {
        ServiceState::Pending => 15,
        ServiceState::Starting => 60,
        ServiceState::Ready => 100,
        ServiceState::Failed => 0,
        ServiceState::Unavailable => 0,
    }
}

/// Derive startup state for optional compose sidecars and host probes.
///
/// Optional rows (Private VPN, tunnel, Ollama) must never surface as `Starting` or
/// `Failed` — those states block or alarm the loading UI even though the hub API
/// is already healthy. Disconnected or churning sidecars report `Unavailable` only.
pub(crate) fn derive_optional_service_state(state: &str, health: &str) -> ServiceState {
    if state.is_empty() {
        return ServiceState::Unavailable;
    }
    match derive_service_state(state, health) {
        ServiceState::Ready => ServiceState::Ready,
        _ => ServiceState::Unavailable,
    }
}

pub(crate) fn startup_service_definitions(
    vpn_on: bool,
) -> (
    Vec<(&'static str, &'static str, bool)>,
    Vec<(&'static str, &'static str, bool)>,
) {
    let core = vec![
        ("ci-hub-db", "Database", true),
        (HUB_QUEUE, "Message queue", true),
        (HUB_CONTAINER, "Hub backend", true),
        ("traefik", "Router", true),
    ];

    let mut optional = Vec::new();
    if vpn_on {
        // Informational only — never in `core`, never blocks `all_ready` or hub health.
        optional.push(("hub-tailscale", "Private VPN", false));
    }
    optional.push(("cloudflared", "Tunnel", false));

    (core, optional)
}

/// True when the host Ollama API responds on localhost (same target the Hub backend uses).
fn probe_host_ollama() -> bool {
    {
        let cache = lock_recovering(&HOST_OLLAMA_PROBE_CACHE);
        if let Some(cached) = cache.as_ref() {
            if cached.checked_at.elapsed() < HOST_OLLAMA_PROBE_CACHE_TTL {
                return cached.available;
            }
        }
    }

    let client = match reqwest::blocking::Client::builder()
        .timeout(HOST_OLLAMA_PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    let available = client
        .get(HOST_OLLAMA_API_URL)
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false);

    let mut cache = lock_recovering(&HOST_OLLAMA_PROBE_CACHE);
    *cache = Some(CachedHostOllamaProbe {
        checked_at: Instant::now(),
        available,
    });

    available
}

/// True when the Hub HTTP API answers `/api/health/live` on localhost.
/// Docker may report `running` + health `starting` while Nest is already serving.
fn probe_hub_api_live() -> bool {
    {
        let cache = lock_recovering(&HUB_API_LIVE_PROBE_CACHE);
        if let Some(cached) = cache.as_ref() {
            if cached.checked_at.elapsed() < HUB_API_LIVE_PROBE_CACHE_TTL {
                return cached.available;
            }
        }
    }

    let port = crate::port_manager::read_api_port(&hub_env_path());
    let url = format!("http://127.0.0.1:{port}/api/health/live");
    let client = match reqwest::blocking::Client::builder()
        .timeout(HUB_API_LIVE_PROBE_TIMEOUT)
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };

    let available = client
        .get(&url)
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false);

    let mut cache = lock_recovering(&HUB_API_LIVE_PROBE_CACHE);
    *cache = Some(CachedHubApiLiveProbe {
        checked_at: Instant::now(),
        available,
    });

    available
}

/// Return per-service startup progress for the frontend loading screen.
pub fn get_startup_progress() -> StartupProgress {
    let vpn_on = is_private_vpn_enabled();

    // Core services in startup order. Optional ones are included for visibility but do not block
    // the "all_ready" gate. Private VPN improves remote access, but the desktop app should stay
    // usable even if the sidecar is still reconnecting.
    let (core, optional) = startup_service_definitions(vpn_on);

    let all_names: Vec<&str> = core
        .iter()
        .chain(optional.iter())
        .map(|(n, _, _)| *n)
        .collect();
    let mut inspect_names = all_names.clone();
    for extra in [LEGACY_HUB_CONTAINER, LEGACY_HUB_QUEUE] {
        if !inspect_names.contains(&extra) {
            inspect_names.push(extra);
        }
    }
    let states = inspect_containers(&inspect_names);

    let mut services: Vec<ServiceStatus> = Vec::new();
    let mut ready_core: usize = 0;
    let mut core_score_sum: usize = 0;

    for (container, label, required) in core.iter().chain(optional.iter()) {
        let (state_str, health_str) = service_inspect_state(&states, container);
        let svc_state = if *required {
            if state_str.is_empty() {
                ServiceState::Pending
            } else {
                derive_service_state(state_str, health_str)
            }
        } else {
            derive_optional_service_state(state_str, health_str)
        };
        services.push(ServiceStatus {
            label: label.to_string(),
            container: container.to_string(),
            state: svc_state,
            optional: !required,
        });
    }

    // Host Ollama is optional and non-blocking; probe the local API, not a compose service.
    services.push(ServiceStatus {
        label: "Ollama".to_string(),
        container: HOST_OLLAMA_SERVICE_ID.to_string(),
        state: if probe_host_ollama() {
            ServiceState::Ready
        } else {
            ServiceState::Unavailable
        },
        optional: true,
    });

    // Count ready core services and compute average core score for progress %.
    for (i, (_, _, required)) in core.iter().chain(optional.iter()).enumerate() {
        if *required {
            core_score_sum += service_state_score(&services[i].state) as usize;
            if let ServiceState::Ready = services[i].state {
                ready_core += 1;
            }
        }
    }

    let core_count = core.len();
    let progress_pct = if core_count == 0 {
        0
    } else {
        (core_score_sum / core_count) as u8
    };

    let required_images = required_startup_images();
    let local_images = list_local_images();
    let image_total = required_images.len() as u8;
    let image_pulled = required_images
        .iter()
        .filter(|img| local_images.contains(img.as_str()))
        .count() as u8;
    let image_pull_pct = if image_total == 0 {
        100
    } else {
        ((image_pulled as usize * 100) / image_total as usize) as u8
    };

    let all_ready = ready_core == core_count;

    StartupProgress {
        services,
        progress_pct,
        image_pulled,
        image_total,
        image_pull_pct,
        all_ready,
    }
}

/// Get the current status of the Hub by inspecting the Docker container.
pub fn get_hub_status() -> HubStatus {
    // If a start operation is actively running (including first-time image pulls),
    // report Starting so the frontend shows progress instead of a false "Stopped" state.
    if START_IN_PROGRESS.load(Ordering::SeqCst) {
        return HubStatus::Starting;
    }

    if !is_docker_available() {
        return HubStatus::DockerNotAvailable;
    }

    let data_dir = get_hub_data_dir();

    // Check the Hub container (canonical name first, then the legacy alias).
    let hub_name = hub_container_name();
    let status = inspect_container_state_health(hub_name);

    if status.is_empty() || status.contains("No such object") || status.contains("Error") {
        if let Some(message) = read_start_failed(&data_dir) {
            return HubStatus::Error { message };
        }
        return HubStatus::Stopped;
    }

    let parts: Vec<&str> = status.split(':').collect();
    let state = parts.first().copied().unwrap_or("");
    let health = parts.get(1).copied().unwrap_or("");

    match (state, health) {
        ("running", "healthy") => {
            // Recovered after a prior failed start — drop the sticky failure marker.
            clear_start_failed(&data_dir);
            HubStatus::Running
        }
        ("running", _) => {
            if probe_hub_api_live() {
                clear_start_failed(&data_dir);
                HubStatus::Running
            } else {
                HubStatus::Starting
            }
        }
        ("restarting", _) => {
            // Check if database is still starting — if so, Hub restart is expected
            let db_status = docker_command()
                .args([
                    "inspect",
                    "--format",
                    "{{.State.Health.Status}}",
                    "ci-hub-db",
                ])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();

            if db_status != "healthy" {
                HubStatus::Starting // DB not ready yet, Hub restart is expected
            } else {
                // DB is healthy but Hub is still restarting — might be a real error
                let restart_count = docker_command()
                    .args(["inspect", "--format", "{{.RestartCount}}", hub_name])
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
                            "Hub has restarted {} times. Open tray → View Logs for details.",
                            restart_count
                        ),
                    }
                }
            }
        }
        ("created", _) | ("exited", _) => {
            if let Some(message) = read_start_failed(&data_dir) {
                HubStatus::Error { message }
            } else {
                HubStatus::Stopped
            }
        }
        _ => HubStatus::Starting,
    }
}
