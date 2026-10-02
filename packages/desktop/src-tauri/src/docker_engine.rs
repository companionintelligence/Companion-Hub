//! Cross-platform Docker engine selection for CI Hub.
//!
//! One engine is pinned per Hub data dir so compose, `docker exec`, and health
//! probes cannot split across Desktop vs system Engine (Linux) or Desktop vs
//! `wsl-engine` (Windows). Affinity to an existing Hub stack beats preference;
//! fresh installs prefer Docker Desktop when reachable.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::hub_names::{HUB_CONTAINER, HUB_NETWORK_NAMES, LEGACY_HUB_CONTAINER};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const DOCKER_CONTEXT_WSL_ENGINE: &str = "wsl-engine";
pub const DOCKER_ENGINE_STATE_FILENAME: &str = "docker-engine.json";

const HUB_IDENTITY_CONTAINERS: &[&str] = &["ci-hub-db", HUB_CONTAINER, LEGACY_HUB_CONTAINER];
const HUB_IDENTITY_VOLUME: &str = "ci_hub_pgdata";

/// Host ports the appliance publishes; colliding ownership across engines is split-brain.
const HUB_HOST_PORTS: &[&str] = &["6543", "5002", "80", "443"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DockerEngineKind {
    Desktop,
    System,
    WslEngine,
    Rootless,
    Other,
}

impl DockerEngineKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::System => "system",
            Self::WslEngine => "wsl-engine",
            Self::Rootless => "rootless",
            Self::Other => "other",
        }
    }

    pub fn is_desktop(self) -> bool {
        matches!(self, Self::Desktop)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DockerEngineCandidate {
    pub label: String,
    pub docker_host: String,
    pub kind: DockerEngineKind,
    pub context_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedDockerEngine {
    pub docker_host: String,
    pub kind: DockerEngineKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_name: Option<String>,
    pub reason: String,
    pub selected_at: u64,
    /// Windows bind-mount style: `drive` (`/c/...`) or `wsl-mnt` (`/mnt/c/...`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path_style: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReachableEngine {
    pub candidate: DockerEngineCandidate,
    pub has_hub_identity: bool,
    pub hub_host_ports: Vec<String>,
}

#[derive(Debug)]
struct ProcessPin {
    engine: PinnedDockerEngine,
}

static PROCESS_PIN: Mutex<Option<ProcessPin>> = Mutex::new(None);

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn docker_engine_state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("state").join(DOCKER_ENGINE_STATE_FILENAME)
}

pub fn clear_process_pin() {
    let mut guard = PROCESS_PIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = None;
}

pub fn pinned_engine() -> Option<PinnedDockerEngine> {
    PROCESS_PIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .as_ref()
        .map(|pin| pin.engine.clone())
}

pub fn pin_engine(engine: PinnedDockerEngine) {
    let mut guard = PROCESS_PIN
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some(ProcessPin { engine });
}

fn explicit_docker_host_override() -> Option<String> {
    explicit_docker_host_override_from(|key| std::env::var(key).ok())
}

/// The first non-blank of `CI_HUB_DOCKER_HOST` and `DOCKER_HOST`, as `lookup` reads them. Tests pass
/// their own lookup: the process environment is shared by every test in the binary, and one that
/// sets it races the others.
fn explicit_docker_host_override_from(lookup: impl Fn(&str) -> Option<String>) -> Option<String> {
    for key in ["CI_HUB_DOCKER_HOST", "DOCKER_HOST"] {
        if let Some(value) = lookup(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn path_style_for_kind(kind: DockerEngineKind) -> Option<String> {
    match kind {
        DockerEngineKind::Desktop => Some("drive".to_string()),
        DockerEngineKind::WslEngine => Some("wsl-mnt".to_string()),
        _ => None,
    }
}

fn kind_from_context_name(context_name: &str) -> DockerEngineKind {
    match context_name {
        "desktop-linux" | "desktop-windows" => DockerEngineKind::Desktop,
        DOCKER_CONTEXT_WSL_ENGINE => DockerEngineKind::WslEngine,
        _ => DockerEngineKind::Other,
    }
}

fn label_for(kind: DockerEngineKind, context_name: Option<&str>, host: &str) -> String {
    match kind {
        DockerEngineKind::Desktop => "Docker Desktop".to_string(),
        DockerEngineKind::System => "system Docker Engine".to_string(),
        DockerEngineKind::WslEngine => "WSL Engine".to_string(),
        DockerEngineKind::Rootless => "rootless Docker Engine".to_string(),
        DockerEngineKind::Other => context_name
            .map(|name| format!("Docker context `{name}`"))
            .unwrap_or_else(|| format!("Docker at {host}")),
    }
}

fn find_docker_binary() -> PathBuf {
    let locator = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let mut command = Command::new(locator);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .arg("docker")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| PathBuf::from("docker"))
}

fn base_docker_command() -> Command {
    let mut cmd = Command::new(find_docker_binary());
    if let Ok(current_path) = std::env::var("PATH") {
        if cfg!(target_os = "macos") {
            let extra =
                "/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin";
            cmd.env("PATH", format!("{extra}:{current_path}"));
        } else if cfg!(target_os = "windows") {
            let mut bin_dirs: Vec<String> = Vec::new();
            for var in &["ProgramFiles", "ProgramW6432"] {
                if let Ok(root) = std::env::var(var) {
                    let dir = format!("{root}\\Docker\\Docker\\resources\\bin");
                    if !bin_dirs.contains(&dir) {
                        bin_dirs.push(dir);
                    }
                }
            }
            if !bin_dirs.is_empty() {
                cmd.env("PATH", format!("{};{}", bin_dirs.join(";"), current_path));
            }
        } else {
            cmd.env("PATH", format!("/usr/local/bin:/usr/bin:{current_path}"));
        }
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn docker_command_for_host(docker_host: &str) -> Command {
    let mut cmd = base_docker_command();
    cmd.env("DOCKER_HOST", docker_host);
    // Avoid inheriting a sticky DOCKER_CONTEXT that fights DOCKER_HOST.
    cmd.env_remove("DOCKER_CONTEXT");
    cmd
}

pub fn probe_docker_host_reachable(docker_host: &str) -> bool {
    docker_command_for_host(docker_host)
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn docker_output(docker_host: &str, args: &[&str]) -> Option<String> {
    let output = docker_command_for_host(docker_host)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

pub fn engine_has_hub_identity(docker_host: &str) -> bool {
    for name in HUB_IDENTITY_CONTAINERS {
        if let Some(raw) = docker_output(
            docker_host,
            &["ps", "-aq", "--filter", &format!("name=^{name}$")],
        ) {
            if !raw.trim().is_empty() {
                return true;
            }
        }
    }
    for network in HUB_NETWORK_NAMES {
        if let Some(raw) = docker_output(
            docker_host,
            &[
                "network",
                "ls",
                "-q",
                "--filter",
                &format!("name=^{network}$"),
            ],
        ) {
            if !raw.trim().is_empty() {
                return true;
            }
        }
    }
    if let Some(raw) = docker_output(
        docker_host,
        &[
            "volume",
            "ls",
            "-q",
            "--filter",
            &format!("name=^{HUB_IDENTITY_VOLUME}$"),
        ],
    ) {
        if !raw.trim().is_empty() {
            return true;
        }
    }
    false
}

/// Published host ports on this engine that collide with Hub appliance ports.
pub fn engine_hub_host_ports(docker_host: &str) -> Vec<String> {
    let Some(raw) = docker_output(
        docker_host,
        &["ps", "--format", "{{.Ports}}", "--filter", "status=running"],
    ) else {
        return Vec::new();
    };

    let mut owned = Vec::new();
    for port in HUB_HOST_PORTS {
        let patterns = [
            format!("0.0.0.0:{port}->"),
            format!(":::{port}->"),
            format!("*:{port}->"),
            format!("127.0.0.1:{port}->"),
        ];
        if raw
            .lines()
            .any(|line| patterns.iter().any(|p| line.contains(p)))
        {
            owned.push((*port).to_string());
        }
    }
    owned
}

pub fn docker_context_host_from_inspect_output(raw: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let host = parsed
        .as_array()?
        .first()?
        .get("Endpoints")?
        .get("docker")?
        .get("Host")?
        .as_str()?
        .trim();
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

pub fn current_docker_context_name(host_docker_dir: Option<&Path>) -> Option<String> {
    let docker_dir = match host_docker_dir {
        Some(dir) => dir.to_path_buf(),
        None => dirs::home_dir()?.join(".docker"),
    };
    let raw = std::fs::read_to_string(docker_dir.join("config.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let context_name = parsed.get("currentContext")?.as_str()?.trim();
    if context_name.is_empty() || context_name == "default" {
        return None;
    }
    Some(context_name.to_string())
}

fn inspect_context_host(context_name: &str) -> Option<String> {
    let output = base_docker_command()
        .args(["context", "inspect", context_name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    docker_context_host_from_inspect_output(&String::from_utf8_lossy(&output.stdout))
}

fn push_unique_candidate(out: &mut Vec<DockerEngineCandidate>, candidate: DockerEngineCandidate) {
    if out
        .iter()
        .any(|existing| existing.docker_host == candidate.docker_host)
    {
        return;
    }
    out.push(candidate);
}

fn candidate_from_unix_socket(
    socket: PathBuf,
    kind: DockerEngineKind,
    context_name: Option<&str>,
) -> Option<DockerEngineCandidate> {
    if !socket.exists() {
        return None;
    }
    let docker_host = format!("unix://{}", socket.display());
    Some(DockerEngineCandidate {
        label: label_for(kind, context_name, &docker_host),
        docker_host,
        kind,
        context_name: context_name.map(str::to_string),
    })
}

#[cfg(target_os = "linux")]
fn enumerate_linux_candidates(host_docker_dir: Option<&Path>) -> Vec<DockerEngineCandidate> {
    let mut out = Vec::new();

    if let Some(context_name) = current_docker_context_name(host_docker_dir) {
        if let Some(host) = inspect_context_host(&context_name) {
            let kind = kind_from_context_name(&context_name);
            push_unique_candidate(
                &mut out,
                DockerEngineCandidate {
                    label: label_for(kind, Some(&context_name), &host),
                    docker_host: host,
                    kind,
                    context_name: Some(context_name),
                },
            );
        }
    }

    // Desktop sockets even when context is default / unset.
    if let Some(home) = dirs::home_dir() {
        for (rel, kind, ctx) in [
            (
                home.join(".docker").join("desktop").join("docker.sock"),
                DockerEngineKind::Desktop,
                Some("desktop-linux"),
            ),
            (
                home.join(".docker").join("run").join("docker.sock"),
                DockerEngineKind::Desktop,
                None,
            ),
        ] {
            if let Some(candidate) = candidate_from_unix_socket(rel, kind, ctx) {
                push_unique_candidate(&mut out, candidate);
            }
        }
    }

    if let Some(candidate) = candidate_from_unix_socket(
        PathBuf::from("/var/run/docker.sock"),
        DockerEngineKind::System,
        None,
    ) {
        push_unique_candidate(&mut out, candidate);
    }

    let mut rootless_sockets = Vec::new();
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        rootless_sockets.push(PathBuf::from(runtime_dir).join("docker.sock"));
    }
    let uid = unsafe { libc::getuid() };
    rootless_sockets.push(PathBuf::from(format!("/run/user/{uid}/docker.sock")));
    for socket in rootless_sockets {
        if let Some(candidate) =
            candidate_from_unix_socket(socket, DockerEngineKind::Rootless, None)
        {
            push_unique_candidate(&mut out, candidate);
        }
    }

    out
}

#[cfg(target_os = "windows")]
fn enumerate_windows_candidates(host_docker_dir: Option<&Path>) -> Vec<DockerEngineCandidate> {
    let mut out = Vec::new();
    let mut context_names: Vec<String> = Vec::new();

    for name in [
        "desktop-linux",
        "desktop-windows",
        DOCKER_CONTEXT_WSL_ENGINE,
    ] {
        context_names.push(name.to_string());
    }
    if let Some(current) = current_docker_context_name(host_docker_dir) {
        if !context_names.iter().any(|n| n == &current) {
            context_names.push(current);
        }
    }

    for context_name in context_names {
        let Some(host) = inspect_context_host(&context_name) else {
            continue;
        };
        let kind = kind_from_context_name(&context_name);
        push_unique_candidate(
            &mut out,
            DockerEngineCandidate {
                label: label_for(kind, Some(&context_name), &host),
                docker_host: host,
                kind,
                context_name: Some(context_name),
            },
        );
    }

    // Named pipe fallback used by Docker Desktop when contexts are unavailable.
    push_unique_candidate(
        &mut out,
        DockerEngineCandidate {
            label: "Docker Desktop".to_string(),
            docker_host: "npipe:////./pipe/docker_engine".to_string(),
            kind: DockerEngineKind::Desktop,
            context_name: Some("desktop-linux".to_string()),
        },
    );

    out
}

#[cfg(target_os = "macos")]
fn enumerate_macos_candidates(host_docker_dir: Option<&Path>) -> Vec<DockerEngineCandidate> {
    let mut out = Vec::new();

    if let Some(home) = dirs::home_dir() {
        let desktop_sock = home.join(".docker").join("run").join("docker.sock");
        if let Some(candidate) = candidate_from_unix_socket(
            desktop_sock,
            DockerEngineKind::Desktop,
            Some("desktop-linux"),
        ) {
            push_unique_candidate(&mut out, candidate);
        }
    }

    if let Some(context_name) = current_docker_context_name(host_docker_dir) {
        if let Some(host) = inspect_context_host(&context_name) {
            let kind = kind_from_context_name(&context_name);
            push_unique_candidate(
                &mut out,
                DockerEngineCandidate {
                    label: label_for(kind, Some(&context_name), &host),
                    docker_host: host,
                    kind,
                    context_name: Some(context_name),
                },
            );
        }
    }

    // Alternate engines (Colima / OrbStack / Rancher) via remaining contexts.
    if let Some(raw) = {
        let output = base_docker_command()
            .args(["context", "ls", "--format", "{{.Name}}"])
            .output()
            .ok();
        output
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
    } {
        for name in raw.lines().map(str::trim).filter(|n| !n.is_empty()) {
            if name == "default" {
                continue;
            }
            if out.iter().any(|c| c.context_name.as_deref() == Some(name)) {
                continue;
            }
            if let Some(host) = inspect_context_host(name) {
                let kind = kind_from_context_name(name);
                push_unique_candidate(
                    &mut out,
                    DockerEngineCandidate {
                        label: label_for(kind, Some(name), &host),
                        docker_host: host,
                        kind,
                        context_name: Some(name.to_string()),
                    },
                );
            }
        }
    }

    out
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn enumerate_platform_candidates(_host_docker_dir: Option<&Path>) -> Vec<DockerEngineCandidate> {
    Vec::new()
}

pub fn enumerate_docker_engine_candidates(
    host_docker_dir: Option<&Path>,
) -> Vec<DockerEngineCandidate> {
    #[cfg(target_os = "linux")]
    {
        return enumerate_linux_candidates(host_docker_dir);
    }
    #[cfg(target_os = "windows")]
    {
        return enumerate_windows_candidates(host_docker_dir);
    }
    #[cfg(target_os = "macos")]
    {
        return enumerate_macos_candidates(host_docker_dir);
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        enumerate_platform_candidates(host_docker_dir)
    }
}

pub fn probe_reachable_engines(candidates: &[DockerEngineCandidate]) -> Vec<ReachableEngine> {
    let mut reachable = Vec::new();
    for candidate in candidates {
        if !probe_docker_host_reachable(&candidate.docker_host) {
            continue;
        }
        let has_hub_identity = engine_has_hub_identity(&candidate.docker_host);
        let hub_host_ports = if has_hub_identity {
            engine_hub_host_ports(&candidate.docker_host)
        } else {
            // Still record Hub ports owned by non-identity containers for split-brain.
            engine_hub_host_ports(&candidate.docker_host)
        };
        reachable.push(ReachableEngine {
            candidate: candidate.clone(),
            has_hub_identity,
            hub_host_ports,
        });
    }
    reachable
}

/// Pure selection among already-probed engines (unit-tested).
pub fn select_docker_engine(
    reachable: &[ReachableEngine],
    explicit_host: Option<&str>,
) -> Result<(DockerEngineCandidate, String), String> {
    if let Some(host) = explicit_host {
        if let Some(engine) = reachable.iter().find(|e| e.candidate.docker_host == host) {
            return Ok((
                engine.candidate.clone(),
                format!("explicit override DOCKER_HOST/CI_HUB_DOCKER_HOST={host}"),
            ));
        }
        // Override may point at a host we did not enumerate; still honor it.
        return Ok((
            DockerEngineCandidate {
                label: format!("explicit Docker host {host}"),
                docker_host: host.to_string(),
                kind: DockerEngineKind::Other,
                context_name: None,
            },
            format!("explicit override DOCKER_HOST/CI_HUB_DOCKER_HOST={host}"),
        ));
    }

    if reachable.is_empty() {
        return Err(
            "No reachable Docker engine found. Start Docker Desktop (or your Docker Engine) and try again."
                .to_string(),
        );
    }

    let with_stack: Vec<&ReachableEngine> =
        reachable.iter().filter(|e| e.has_hub_identity).collect();

    if with_stack.len() == 1 {
        let engine = with_stack[0];
        return Ok((
            engine.candidate.clone(),
            format!(
                "affinity: Hub stack already on {} ({})",
                engine.candidate.label, engine.candidate.docker_host
            ),
        ));
    }

    if with_stack.len() > 1 {
        if let Some(desktop) = with_stack.iter().find(|e| e.candidate.kind.is_desktop()) {
            return Ok((
                desktop.candidate.clone(),
                format!(
                    "multiple engines have Hub identity; preferring Desktop among them ({})",
                    desktop.candidate.docker_host
                ),
            ));
        }
        let engine = with_stack[0];
        return Ok((
            engine.candidate.clone(),
            format!(
                "multiple engines have Hub identity; using {} ({})",
                engine.candidate.label, engine.candidate.docker_host
            ),
        ));
    }

    // Fresh install: prefer Desktop, then platform fallback order as enumerated.
    if let Some(desktop) = reachable.iter().find(|e| e.candidate.kind.is_desktop()) {
        return Ok((
            desktop.candidate.clone(),
            format!(
                "fresh install: prefer Docker Desktop at {}",
                desktop.candidate.docker_host
            ),
        ));
    }

    let engine = &reachable[0];
    Ok((
        engine.candidate.clone(),
        format!(
            "fresh install: platform fallback {} ({})",
            engine.candidate.label, engine.candidate.docker_host
        ),
    ))
}

fn persist_engine(data_dir: &Path, engine: &PinnedDockerEngine) -> Result<(), String> {
    let path = docker_engine_state_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Failed to create Docker engine state dir {}: {error}",
                parent.display()
            )
        })?;
    }
    let body = serde_json::to_string_pretty(engine)
        .map_err(|error| format!("Failed to serialize Docker engine state: {error}"))?;
    std::fs::write(&path, body).map_err(|error| {
        format!(
            "Failed to write Docker engine state {}: {error}",
            path.display()
        )
    })
}

pub fn load_persisted_engine(data_dir: &Path) -> Option<PinnedDockerEngine> {
    let raw = std::fs::read_to_string(docker_engine_state_path(data_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn resolve_hub_docker_engine(
    data_dir: &Path,
    host_docker_dir: Option<&Path>,
) -> Result<PinnedDockerEngine, String> {
    let explicit = explicit_docker_host_override();
    let candidates = enumerate_docker_engine_candidates(host_docker_dir);
    let reachable = probe_reachable_engines(&candidates);
    let (selected, reason) = select_docker_engine(&reachable, explicit.as_deref())?;

    // If explicit override points at a host that is not reachable, still pin it
    // but warn via reason — callers that need reachability should probe.
    let kind = selected.kind;
    let path_style = path_style_for_kind(kind);
    let engine = PinnedDockerEngine {
        docker_host: selected.docker_host,
        kind,
        context_name: selected.context_name,
        reason,
        selected_at: now_unix_secs(),
        path_style,
    };
    let _ = persist_engine(data_dir, &engine);
    Ok(engine)
}

/// Resolve, persist, and pin for this process. Call at the start of Hub start/retry.
pub fn resolve_and_pin_hub_docker_engine(data_dir: &Path) -> Result<PinnedDockerEngine, String> {
    let engine = resolve_hub_docker_engine(data_dir, None)?;
    pin_engine(engine.clone());
    Ok(engine)
}

/// Effective DOCKER_HOST for `docker` subprocesses.
///
/// Order: process pin → env override → full resolve/pin (affinity) against the
/// Hub data dir when provided.
pub fn effective_docker_host(data_dir: Option<&Path>) -> Option<String> {
    if let Some(pinned) = pinned_engine() {
        return Some(pinned.docker_host);
    }
    if let Some(host) = explicit_docker_host_override() {
        return Some(host);
    }
    let dir = data_dir?;
    match resolve_and_pin_hub_docker_engine(dir) {
        Ok(engine) => Some(engine.docker_host),
        Err(_) => load_persisted_engine(dir).map(|e| e.docker_host),
    }
}

/// Windows path-style hint from the pinned / persisted engine, if any.
pub fn pinned_path_style(data_dir: Option<&Path>) -> Option<String> {
    if let Some(pinned) = pinned_engine() {
        return pinned.path_style;
    }
    let dir = data_dir?;
    load_persisted_engine(dir).and_then(|e| e.path_style)
}

/// Detect split-brain: Hub identity or Hub host ports owned by a non-selected engine.
pub fn split_brain_conflict(
    selected: &PinnedDockerEngine,
    reachable: &[ReachableEngine],
) -> Option<String> {
    let selected_has_identity = reachable
        .iter()
        .find(|e| e.candidate.docker_host == selected.docker_host)
        .map(|e| e.has_hub_identity)
        .unwrap_or(false);

    // Affinity / prefer-among already chose an engine that owns the Hub stack.
    if selected_has_identity {
        return None;
    }

    for engine in reachable {
        if engine.candidate.docker_host == selected.docker_host {
            continue;
        }
        if engine.has_hub_identity {
            return Some(format!(
                "Hub stack is on {} ({}) but {} ({}) is selected. \
                 Hub will not start a second stack (host ports {}). \
                 Set CI_HUB_DOCKER_HOST to the stack's engine, or remove the other stack.",
                engine.candidate.label,
                engine.candidate.docker_host,
                label_for(
                    selected.kind,
                    selected.context_name.as_deref(),
                    &selected.docker_host
                ),
                selected.docker_host,
                HUB_HOST_PORTS.join("/")
            ));
        }
        if !engine.hub_host_ports.is_empty() {
            return Some(format!(
                "Host port(s) {} are already published on {} ({}), but Hub selected {} ({}). \
                 Stop the conflicting containers or set CI_HUB_DOCKER_HOST to that engine.",
                engine.hub_host_ports.join(", "),
                engine.candidate.label,
                engine.candidate.docker_host,
                label_for(
                    selected.kind,
                    selected.context_name.as_deref(),
                    &selected.docker_host
                ),
                selected.docker_host
            ));
        }
    }
    None
}

/// Classify Postgres TCP probe failures for honest sticky messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostgresProbeFailureKind {
    Auth,
    Network,
    Unknown,
}

pub fn classify_postgres_probe_output(stdout: &str, stderr: &str) -> PostgresProbeFailureKind {
    let combined = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    if combined.contains("password authentication failed")
        || combined.contains("fatal:  password authentication failed")
    {
        return PostgresProbeFailureKind::Auth;
    }
    if combined.contains("could not translate host name")
        || combined.contains("network not found")
        || combined.contains("could not connect to server")
        || combined.contains("no such host")
        || combined.contains("name or service not known")
        || combined.contains("connection refused")
        || combined.contains("temporary failure in name resolution")
    {
        return PostgresProbeFailureKind::Network;
    }
    PostgresProbeFailureKind::Unknown
}

pub fn format_postgres_probe_failure(
    kind: PostgresProbeFailureKind,
    engine: Option<&PinnedDockerEngine>,
    detail: &str,
) -> String {
    let engine_note = engine
        .map(|e| {
            format!(
                " Docker engine: {} ({}) — {}.",
                e.kind.as_str(),
                e.docker_host,
                e.reason
            )
        })
        .unwrap_or_default();
    match kind {
        PostgresProbeFailureKind::Auth => format!(
            "Postgres password sync did not restore TCP authentication for user companion.{engine_note} {detail}"
        ),
        PostgresProbeFailureKind::Network => format!(
            "Postgres TCP probe could not reach ci-hub-db on the selected Docker engine (network/DNS), not an auth failure.{engine_note} {detail}"
        ),
        PostgresProbeFailureKind::Unknown => format!(
            "Postgres TCP probe failed after password sync.{engine_note} {detail}"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(label: &str, host: &str, kind: DockerEngineKind) -> DockerEngineCandidate {
        DockerEngineCandidate {
            label: label.to_string(),
            docker_host: host.to_string(),
            kind,
            context_name: None,
        }
    }

    fn reachable(
        label: &str,
        host: &str,
        kind: DockerEngineKind,
        has_hub_identity: bool,
    ) -> ReachableEngine {
        ReachableEngine {
            candidate: candidate(label, host, kind),
            has_hub_identity,
            hub_host_ports: Vec::new(),
        }
    }

    #[test]
    fn explicit_override_prefers_ci_hub_docker_host_and_skips_blank_values() {
        let env = |vars: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                vars.iter()
                    .find(|(name, _)| *name == key)
                    .map(|(_, value)| value.to_string())
            }
        };

        assert_eq!(
            explicit_docker_host_override_from(env(&[(
                "DOCKER_HOST",
                " unix:///tmp/ci-hub-docker.sock "
            )])),
            Some("unix:///tmp/ci-hub-docker.sock".to_string())
        );
        assert_eq!(
            explicit_docker_host_override_from(env(&[
                ("CI_HUB_DOCKER_HOST", "unix:///run/hub.sock"),
                ("DOCKER_HOST", "unix:///tmp/ci-hub-docker.sock"),
            ])),
            Some("unix:///run/hub.sock".to_string())
        );
        assert_eq!(
            explicit_docker_host_override_from(env(&[
                ("CI_HUB_DOCKER_HOST", "  "),
                ("DOCKER_HOST", "unix:///tmp/ci-hub-docker.sock"),
            ])),
            Some("unix:///tmp/ci-hub-docker.sock".to_string())
        );
        assert_eq!(explicit_docker_host_override_from(env(&[])), None);
    }

    #[test]
    fn selects_explicit_override() {
        let engines = vec![reachable(
            "system",
            "unix:///var/run/docker.sock",
            DockerEngineKind::System,
            true,
        )];
        let (selected, reason) =
            select_docker_engine(&engines, Some("unix:///custom.sock")).unwrap();
        assert_eq!(selected.docker_host, "unix:///custom.sock");
        assert!(reason.contains("explicit"));
    }

    #[test]
    fn affinity_to_single_stack_beats_desktop() {
        let engines = vec![
            reachable(
                "Desktop",
                "unix:///home/u/.docker/desktop/docker.sock",
                DockerEngineKind::Desktop,
                false,
            ),
            reachable(
                "system",
                "unix:///var/run/docker.sock",
                DockerEngineKind::System,
                true,
            ),
        ];
        let (selected, reason) = select_docker_engine(&engines, None).unwrap();
        assert_eq!(selected.docker_host, "unix:///var/run/docker.sock");
        assert!(reason.contains("affinity"));
    }

    #[test]
    fn prefers_desktop_among_multiple_stacks() {
        let engines = vec![
            reachable(
                "Desktop",
                "unix:///home/u/.docker/desktop/docker.sock",
                DockerEngineKind::Desktop,
                true,
            ),
            reachable(
                "system",
                "unix:///var/run/docker.sock",
                DockerEngineKind::System,
                true,
            ),
        ];
        let (selected, reason) = select_docker_engine(&engines, None).unwrap();
        assert!(selected.kind.is_desktop());
        assert!(reason.contains("multiple"));
    }

    #[test]
    fn fresh_install_prefers_desktop() {
        let engines = vec![
            reachable(
                "system",
                "unix:///var/run/docker.sock",
                DockerEngineKind::System,
                false,
            ),
            reachable(
                "Desktop",
                "unix:///home/u/.docker/desktop/docker.sock",
                DockerEngineKind::Desktop,
                false,
            ),
        ];
        let (selected, reason) = select_docker_engine(&engines, None).unwrap();
        assert!(selected.kind.is_desktop());
        assert!(reason.contains("fresh"));
    }

    #[test]
    fn fresh_install_falls_back_when_desktop_missing() {
        let engines = vec![reachable(
            "system",
            "unix:///var/run/docker.sock",
            DockerEngineKind::System,
            false,
        )];
        let (selected, reason) = select_docker_engine(&engines, None).unwrap();
        assert_eq!(selected.kind, DockerEngineKind::System);
        assert!(reason.contains("fallback"));
    }

    #[test]
    fn windows_affinity_to_wsl_engine() {
        let engines = vec![
            reachable(
                "Desktop",
                "npipe:////./pipe/docker_engine",
                DockerEngineKind::Desktop,
                false,
            ),
            reachable(
                "WSL",
                "tcp://127.0.0.1:2375",
                DockerEngineKind::WslEngine,
                true,
            ),
        ];
        let (selected, reason) = select_docker_engine(&engines, None).unwrap();
        assert_eq!(selected.kind, DockerEngineKind::WslEngine);
        assert!(reason.contains("affinity"));
    }

    #[test]
    fn unreachable_desktop_is_not_selected_when_system_has_stack() {
        // Desktop absent from reachable list (probe failed) → system affinity.
        let engines = vec![reachable(
            "system",
            "unix:///var/run/docker.sock",
            DockerEngineKind::System,
            true,
        )];
        let (selected, _) = select_docker_engine(&engines, None).unwrap();
        assert_eq!(selected.docker_host, "unix:///var/run/docker.sock");
    }

    #[test]
    fn split_brain_detects_other_engine_stack() {
        let selected = PinnedDockerEngine {
            docker_host: "unix:///home/u/.docker/desktop/docker.sock".to_string(),
            kind: DockerEngineKind::Desktop,
            context_name: Some("desktop-linux".to_string()),
            reason: "fresh".to_string(),
            selected_at: 1,
            path_style: Some("drive".to_string()),
        };
        let reachable = vec![
            ReachableEngine {
                candidate: candidate(
                    "Desktop",
                    "unix:///home/u/.docker/desktop/docker.sock",
                    DockerEngineKind::Desktop,
                ),
                has_hub_identity: false,
                hub_host_ports: Vec::new(),
            },
            ReachableEngine {
                candidate: candidate(
                    "system",
                    "unix:///var/run/docker.sock",
                    DockerEngineKind::System,
                ),
                has_hub_identity: true,
                hub_host_ports: vec!["6543".to_string()],
            },
        ];
        let msg = split_brain_conflict(&selected, &reachable).expect("conflict");
        assert!(msg.contains("Hub stack is on"));
        assert!(msg.contains("system"));
    }

    #[test]
    fn classifies_postgres_auth_vs_network() {
        assert_eq!(
            classify_postgres_probe_output("", "psql: error: password authentication failed"),
            PostgresProbeFailureKind::Auth
        );
        assert_eq!(
            classify_postgres_probe_output(
                "",
                "psql: error: could not translate host name \"ci-hub-db\" to address"
            ),
            PostgresProbeFailureKind::Network
        );
        assert_eq!(
            classify_postgres_probe_output("", "network ci-os-hub_network not found"),
            PostgresProbeFailureKind::Network
        );
        assert_eq!(
            classify_postgres_probe_output("", "network ci-hub_network not found"),
            PostgresProbeFailureKind::Network
        );
    }

    #[test]
    fn parses_docker_context_host_from_inspect_output() {
        let inspect_output = r#"[{
            "Name": "desktop-linux",
            "Endpoints": {
                "docker": {
                    "Host": "unix:///home/test/.docker/desktop/docker.sock"
                }
            }
        }]"#;
        assert_eq!(
            docker_context_host_from_inspect_output(inspect_output),
            Some("unix:///home/test/.docker/desktop/docker.sock".to_string())
        );
    }

    #[test]
    fn persists_and_loads_engine_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let engine = PinnedDockerEngine {
            docker_host: "unix:///var/run/docker.sock".to_string(),
            kind: DockerEngineKind::System,
            context_name: None,
            reason: "affinity".to_string(),
            selected_at: 42,
            path_style: None,
        };
        persist_engine(dir.path(), &engine).expect("persist");
        let loaded = load_persisted_engine(dir.path()).expect("load");
        assert_eq!(loaded.docker_host, engine.docker_host);
        assert_eq!(loaded.kind, DockerEngineKind::System);
        assert_eq!(loaded.reason, "affinity");
    }
}
