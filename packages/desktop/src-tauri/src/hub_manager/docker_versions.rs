//! The oldest Docker the Hub's stack file runs on, checked before the desktop app starts it.

use super::*;
use regex::Regex;
use std::sync::OnceLock;

/// `gw_priority` in docker-compose.prod.yml, which keeps the Hub's own traffic on ci-hub_network,
/// is new in Compose 2.33 and Engine 28. An older Compose refuses the whole file ("Additional
/// property gw_priority is not allowed"), and nothing in that error says Docker is too old.
pub(crate) const MIN_DOCKER_COMPOSE_VERSION: DockerVersion = DockerVersion(2, 33, 0);
pub(crate) const MIN_DOCKER_ENGINE_VERSION: DockerVersion = DockerVersion(28, 0, 0);

/// `major.minor.patch`, ordered field by field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct DockerVersion(pub u64, pub u64, pub u64);

/// What this computer reports for `docker compose version --short` and the engine's own version,
/// as printed. `None` for one that could not be read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct DockerVersions {
    pub compose: Option<String>,
    pub engine: Option<String>,
}

/// The first `major.minor[.patch]` in what Docker printed, so a leading `v` (`v2.33.0`), a build
/// suffix (`2.40.3-desktop.1`) or a distribution's tag (`28.2.2-0ubuntu1`) does not hide it.
/// The same rule as `parseDockerVersion` in scripts/lib/docker-versions.ts.
pub(crate) fn parse_docker_version(raw: &str) -> Option<DockerVersion> {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        Regex::new(r"([0-9]+)\.([0-9]+)(?:\.([0-9]+))?").expect("docker version pattern")
    });
    let captures = pattern.captures(raw)?;
    let field = |index: usize| {
        captures
            .get(index)
            .map_or(Some(0), |found| found.as_str().parse().ok())
    };
    Some(DockerVersion(field(1)?, field(2)?, field(3)?))
}

/// The message to stop on when Compose or the engine is older than the stack file needs, naming
/// what this computer has. `None` when both are new enough, and for a version that cannot be read
/// or parsed: not knowing is no reason to refuse a start that may well work.
pub(crate) fn docker_too_old_message(versions: &DockerVersions) -> Option<String> {
    let older_than = |found: &Option<String>, minimum: DockerVersion| {
        found
            .as_deref()
            .and_then(parse_docker_version)
            .is_some_and(|version| version < minimum)
    };
    if !older_than(&versions.compose, MIN_DOCKER_COMPOSE_VERSION)
        && !older_than(&versions.engine, MIN_DOCKER_ENGINE_VERSION)
    {
        return None;
    }
    let found: Vec<String> = [("Compose", &versions.compose), ("Engine", &versions.engine)]
        .into_iter()
        .filter_map(|(label, version)| {
            version
                .as_deref()
                .map(|version| format!("{label} {}", version.trim_start_matches('v')))
        })
        .collect();
    Some(format!(
        "Companion Hub needs Docker Compose {}.{} or newer and Docker Engine {} or newer. This computer has {}. Update Docker, then start the Hub again.",
        MIN_DOCKER_COMPOSE_VERSION.0,
        MIN_DOCKER_COMPOSE_VERSION.1,
        MIN_DOCKER_ENGINE_VERSION.0,
        found.join(" and ")
    ))
}

/// Read both versions from the Docker the Hub runs on (the pinned engine, via `docker_command`).
pub(crate) fn read_docker_versions() -> DockerVersions {
    DockerVersions {
        compose: docker_stdout(&["compose", "version", "--short"]),
        engine: docker_stdout(&["version", "--format", "{{.Server.Version}}"]),
    }
}

fn docker_stdout(args: &[&str]) -> Option<String> {
    let output = docker_command().args(args).output().ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !stdout.is_empty()).then_some(stdout)
}

/// Refuse to start on a Docker too old for the stack file, before anything is pulled or created,
/// with a message the start screen shows as it is. A version that cannot be read is logged and the
/// start goes on, so compose reports whatever is actually wrong, as it did before this check.
pub(crate) fn ensure_docker_supports_hub_stack(data_dir: &Path) -> Result<(), String> {
    check_docker_versions(data_dir, &read_docker_versions())
}

/// [`ensure_docker_supports_hub_stack`] on versions already read, which is how the tests drive it.
pub(crate) fn check_docker_versions(
    data_dir: &Path,
    versions: &DockerVersions,
) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Docker versions: compose={} engine={}",
            versions.compose.as_deref().unwrap_or("unknown"),
            versions.engine.as_deref().unwrap_or("unknown")
        ),
    );
    for (label, version) in [
        ("Docker Compose", &versions.compose),
        ("Docker Engine", &versions.engine),
    ] {
        if version.as_deref().and_then(parse_docker_version).is_none() {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!("Could not read the {label} version; starting without checking it."),
            );
        }
    }
    match docker_too_old_message(versions) {
        Some(message) => {
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            Err(message)
        }
        None => Ok(()),
    }
}
