//! Service state derivation, startup progress and hub status.

use super::*;
use chrono::{DateTime, Datelike, Utc};
use std::collections::HashMap;

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
    // The cached check: the uncached one starts a throwaway container to look for saved
    // Tailscale state, and this runs on every startup-progress poll.
    if is_private_vpn_enabled() {
        out.push("tailscale/tailscale:v1.82.5".to_string());
    }
    out
}

/// One container's state as `docker inspect` reports it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct ContainerInspect {
    /// `created`, `running`, `restarting`, `exited`, `dead`, …
    pub(crate) status: String,
    /// Health-check status, or `none` when the container has no health check.
    pub(crate) health: String,
    pub(crate) exit_code: i64,
    /// Docker's own error for the container, such as a port that is already allocated.
    pub(crate) error: String,
    pub(crate) started_at: Option<DateTime<Utc>>,
    pub(crate) finished_at: Option<DateTime<Utc>>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct InspectState {
    status: String,
    exit_code: i64,
    error: String,
    started_at: String,
    finished_at: String,
    health: Option<InspectHealth>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct InspectHealth {
    status: String,
}

/// Parse a Docker timestamp. Docker writes year 1 for "never", which becomes `None`.
fn parse_docker_time(raw: &str) -> Option<DateTime<Utc>> {
    let parsed = DateTime::parse_from_rfc3339(raw).ok()?.with_timezone(&Utc);
    (parsed.year() > 1).then_some(parsed)
}

/// Parse one `name<TAB>{State as JSON}` line printed by [`inspect_containers`].
pub(crate) fn parse_inspect_line(line: &str) -> Option<(String, ContainerInspect)> {
    let (name, state_json) = line.trim().split_once('\t')?;
    let state: InspectState = serde_json::from_str(state_json).ok()?;
    let health = state
        .health
        .map(|health| health.status)
        .filter(|status| !status.is_empty())
        .unwrap_or_else(|| "none".to_string());
    Some((
        // Docker prefixes the name with "/" in inspect output
        name.trim_start_matches('/').to_string(),
        ContainerInspect {
            status: state.status,
            health,
            exit_code: state.exit_code,
            error: state.error.trim().to_string(),
            started_at: parse_docker_time(&state.started_at),
            finished_at: parse_docker_time(&state.finished_at),
        },
    ))
}

/// Query Docker for several containers' states in one `docker inspect` call.
/// Containers that do not exist are simply absent from the map.
fn inspect_containers(names: &[&str]) -> HashMap<String, ContainerInspect> {
    if names.is_empty() {
        return HashMap::new();
    }
    let output = docker_command()
        .arg("inspect")
        .arg("--format")
        .arg("{{.Name}}\t{{json .State}}")
        .args(names)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    output.lines().filter_map(parse_inspect_line).collect()
}

/// Look a service up by its container name, falling back to the legacy name.
fn service_inspect<'a>(
    containers: &'a HashMap<String, ContainerInspect>,
    container: &str,
) -> Option<&'a ContainerInspect> {
    if let Some(found) = containers.get(container) {
        return Some(found);
    }
    let legacy = if container == HUB_CONTAINER {
        LEGACY_HUB_CONTAINER
    } else if container == HUB_QUEUE {
        LEGACY_HUB_QUEUE
    } else {
        return None;
    };
    containers.get(legacy)
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

/// What the desktop app knows about the Hub beyond the containers themselves.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct CoreServiceContext {
    /// A `start_hub` call is running right now.
    pub(crate) start_in_progress: bool,
    /// When that start began. Containers that exited before it are left over from the
    /// last run and about to be replaced, not failures.
    pub(crate) start_began_at: Option<DateTime<Utc>>,
    /// The user stopped the Hub and has not started it since.
    pub(crate) user_stopped: bool,
    /// The last start failed and the user has not tried again.
    pub(crate) start_failed: bool,
    /// That start still recreates every container, so one running now is about to be
    /// replaced. Without this, the database and queue read Ready and then drop back to
    /// Starting when the final `compose up --force-recreate` replaces them.
    pub(crate) recreate_pending: bool,
}

/// Derive a required service's state, plus what went wrong when it failed.
///
/// An exited container is only `Failed` when nothing explains it: the user stopping the
/// Hub, a clean exit, or a leftover from before the start that is running now.
pub(crate) fn derive_core_service_state(
    container: Option<&ContainerInspect>,
    ctx: &CoreServiceContext,
) -> (ServiceState, Option<String>) {
    let Some(container) = container else {
        // Not created yet, or removed by `compose down`.
        let state = if ctx.start_in_progress {
            ServiceState::Pending
        } else if ctx.user_stopped {
            ServiceState::Stopped
        } else if ctx.start_failed {
            ServiceState::NotStarted
        } else {
            ServiceState::Pending
        };
        return (state, None);
    };

    let error = (!container.error.is_empty()).then(|| container.error.clone());
    match container.status.as_str() {
        "running" if ctx.start_in_progress && ctx.recreate_pending => {
            (ServiceState::Starting, None)
        }
        "running" => (derive_service_state("running", &container.health), None),
        "restarting" => (ServiceState::Starting, None),
        "created" => {
            if ctx.start_in_progress {
                (ServiceState::Starting, None)
            } else if error.is_some() {
                (ServiceState::Failed, error)
            } else if ctx.user_stopped {
                (ServiceState::Stopped, None)
            } else if ctx.start_failed {
                (ServiceState::NotStarted, None)
            } else {
                (ServiceState::Starting, None)
            }
        }
        "exited" | "dead" => {
            let exited_during_start = ctx.start_in_progress
                && matches!(
                    (container.finished_at, ctx.start_began_at),
                    (Some(finished), Some(began)) if finished >= began
                );
            if ctx.start_in_progress && !exited_during_start {
                (ServiceState::Pending, None)
            } else if ctx.user_stopped && !ctx.start_in_progress {
                (ServiceState::Stopped, None)
            } else if error.is_some() {
                (ServiceState::Failed, error)
            } else if container.exit_code == 0 && !exited_during_start {
                (ServiceState::Stopped, None)
            } else {
                let detail = format!("Exited with code {}", container.exit_code);
                (ServiceState::Failed, Some(detail))
            }
        }
        _ => (ServiceState::Pending, None),
    }
}

/// How long a service has been waiting on its health check, in seconds.
pub(crate) fn starting_secs(
    container: Option<&ContainerInspect>,
    state: &ServiceState,
    now: DateTime<Utc>,
) -> Option<u64> {
    if !matches!(state, ServiceState::Starting) {
        return None;
    }
    let started_at = container?.started_at?;
    u64::try_from((now - started_at).num_seconds()).ok()
}

/// The startup bar's percentage. When images had to be downloaded during this start,
/// downloads count for half of it, so a first start does not sit at the services' floor
/// for the whole download.
pub(crate) fn startup_progress_pct(
    services_pct: u8,
    image_pull_pct: u8,
    counting_downloads: bool,
) -> u8 {
    if counting_downloads {
        (u16::from(services_pct) + u16::from(image_pull_pct)).div_ceil(2) as u8
    } else {
        services_pct
    }
}

fn start_began_at() -> Option<DateTime<Utc>> {
    match START_BEGAN_AT_MS.load(Ordering::SeqCst) {
        0 => None,
        ms => i64::try_from(ms)
            .ok()
            .and_then(DateTime::from_timestamp_millis),
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
        ServiceState::Stopped => 0,
        ServiceState::NotStarted => 0,
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
    let data_dir = get_hub_data_dir();
    let start_in_progress = START_IN_PROGRESS.load(Ordering::SeqCst);
    let user_stopped = is_user_stopped(&data_dir);
    let start_error = read_start_failed(&data_dir);
    let docker_access = check_docker_access();
    let docker_available = matches!(docker_access.state, DockerAccessState::Available);
    let ctx = CoreServiceContext {
        start_in_progress,
        start_began_at: start_began_at(),
        user_stopped,
        start_failed: start_error.is_some(),
        recreate_pending: START_RECREATE_PENDING.load(Ordering::SeqCst),
    };

    let vpn_on = is_private_vpn_enabled();

    // Core services in startup order. Optional ones are included for visibility but do not block
    // the "all_ready" gate. Private VPN improves remote access, but the desktop app should stay
    // usable even if the sidecar is still reconnecting.
    let (core, optional) = startup_service_definitions(vpn_on);

    let mut inspect_names: Vec<&str> = core
        .iter()
        .chain(optional.iter())
        .map(|(n, _, _)| *n)
        .collect();
    for extra in [LEGACY_HUB_CONTAINER, LEGACY_HUB_QUEUE] {
        if !inspect_names.contains(&extra) {
            inspect_names.push(extra);
        }
    }
    let containers = if docker_available {
        inspect_containers(&inspect_names)
    } else {
        HashMap::new()
    };
    let now = Utc::now();

    let mut services: Vec<ServiceStatus> = Vec::new();
    let mut ready_core: usize = 0;
    let mut core_score_sum: usize = 0;

    for (container, label, required) in core.iter().chain(optional.iter()) {
        let inspect = service_inspect(&containers, container);
        let (state, detail) = if *required {
            derive_core_service_state(inspect, &ctx)
        } else {
            let (status, health) = inspect
                .map(|found| (found.status.as_str(), found.health.as_str()))
                .unwrap_or(("", ""));
            (derive_optional_service_state(status, health), None)
        };
        if *required {
            core_score_sum += service_state_score(&state) as usize;
            if let ServiceState::Ready = state {
                ready_core += 1;
            }
        }
        services.push(ServiceStatus {
            label: label.to_string(),
            container: container.to_string(),
            starting_secs: starting_secs(inspect, &state, now),
            state,
            optional: !required,
            detail,
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
        detail: None,
        starting_secs: None,
    });

    let core_count = core.len();
    let services_pct = if core_count == 0 {
        0
    } else {
        (core_score_sum / core_count) as u8
    };

    let required_images = required_startup_images();
    let local_images = if docker_available {
        list_local_images()
    } else {
        HashSet::new()
    };
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

    // Downloads join the percentage once a poll during this start finds an image missing,
    // and stay in it until the start finishes, so the bar never jumps back when the last
    // image lands.
    if start_in_progress && image_pulled < image_total {
        START_IMAGE_DOWNLOADS_SEEN.store(true, Ordering::SeqCst);
    }
    let progress_pct = startup_progress_pct(
        services_pct,
        image_pull_pct,
        START_IMAGE_DOWNLOADS_SEEN.load(Ordering::SeqCst),
    );
    if all_ready {
        START_IMAGE_DOWNLOADS_SEEN.store(false, Ordering::SeqCst);
    }

    StartupProgress {
        services,
        progress_pct,
        image_pulled,
        image_total,
        image_pull_pct,
        all_ready,
        start_in_progress,
        user_stopped,
        user_stopped_at_ms: user_stopped
            .then(|| user_stopped_at_ms(&data_dir))
            .flatten(),
        start_failed_at_ms: start_error
            .as_ref()
            .and_then(|_| start_failed_at_ms(&data_dir)),
        start_error,
        hub_api_live: docker_available && probe_hub_api_live(),
        docker_access,
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
