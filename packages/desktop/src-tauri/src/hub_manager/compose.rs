//! Compose file resolution, hub initialization and container docker config.

use super::*;

pub(crate) fn compose_env_file_var(env_path: &Path) -> String {
    docker_bind_mount_path(env_path)
}

fn compose_resource_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    vec![
        resource_dir.join(HUB_COMPOSE_FILENAME),
        resource_dir.join("resources").join(HUB_COMPOSE_FILENAME),
        std::env::current_exe()
            .unwrap_or_default()
            .parent()
            .unwrap_or(Path::new("."))
            .join("resources")
            .join(HUB_COMPOSE_FILENAME),
        PathBuf::from("/usr/lib/companion-hub/resources").join(HUB_COMPOSE_FILENAME),
        PathBuf::from("/usr/lib/Companion Hub/resources").join(HUB_COMPOSE_FILENAME),
        PathBuf::from("/usr/share/companion-hub").join(HUB_COMPOSE_FILENAME),
    ]
}

/// Ensure `docker-compose.prod.yml` exists at `compose_path` before hub start.
///
/// Recovery order matches `initialize_hub`: copy from bundled resource candidates,
/// then write the compile-time embedded seed. Without the seed fallback, machines
/// that lost the data-dir compose file (or never finished initialize) looped the
/// watchdog forever on "Database bootstrap failed. open …/docker-compose.prod.yml:
/// no such file or directory" (RUST-HUB-DESKTOP-SHELL-3N/3Q/3P).
pub(crate) fn ensure_hub_compose_file(compose_path: &Path, data_dir: &Path) -> Result<(), String> {
    if compose_path.exists() {
        return Ok(());
    }

    let recover_candidates = compose_resource_candidates(
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .as_deref()
            .unwrap_or(Path::new(".")),
    );

    if let Some(src) = recover_candidates
        .iter()
        .find(|candidate| candidate.exists())
    {
        std::fs::copy(src, compose_path).map_err(|error| {
            format!(
                "Compose file was missing and recovery copy from {} failed: {}",
                src.display(),
                error
            )
        })?;
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "Recovered missing compose file at {} from {}",
                compose_path.display(),
                src.display()
            ),
        );
        return Ok(());
    }

    std::fs::write(compose_path, HUB_COMPOSE_SEED).map_err(|error| {
        // Intentionally not phrased like a compose open race — this must stick
        // until the user retries after fixing disk permissions / free space.
        format!(
            "Failed to materialize {} from the embedded seed (no bundled resource found): {}",
            compose_path.display(),
            error
        )
    })?;
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Recovered missing compose file at {} from embedded seed",
            compose_path.display()
        ),
    );
    Ok(())
}

/// Initialize Hub data directory and generate .env file.
///
/// Uses a regenerate-and-preserve approach:
/// - Preserved values (read from existing .env, generated if missing): ROOT_FOLDER_HOST, JWT_SECRET, POSTGRES_PASSWORD
/// - Preserved value learned at pairing (kept, never re-derived once a Portal has answered): DOMAIN
/// - Derived values (always recomputed from the current binary): INTERNAL_IP, CI_CLOUD_URL, CI_HUB_VERSION, CI_HUB_IMAGE, DOCKER_PLATFORM, DEVICE_ID
/// - CI_CLOUD_URL follows the desktop-only Portal URL override file when it holds a valid origin; see `portal_url`
///
/// Returns the initialized desktop data paths and Traefik preflight result.
pub fn initialize_hub(resource_dir: &Path) -> Result<HubInitialization, String> {
    let data_dir = get_hub_data_dir();

    // Create data subdirectories
    let subdirs = [
        "state",
        "repos",
        "apps",
        "logs",
        "media",
        "user-config",
        "app-data",
        "backups",
        "cache",
        ".internal",
    ];
    for sub in subdirs {
        std::fs::create_dir_all(data_dir.join(sub))
            .map_err(|e| format!("Failed to create {}: {}", sub, e))?;
    }
    ensure_host_state_tree_writable(&data_dir)?;
    let _ = append_desktop_log_for(
        &data_dir,
        "initialize",
        &format!(
            "Initializing desktop resources from {}",
            resource_dir.display()
        ),
    );
    ensure_bundled_cli_available(resource_dir, &data_dir);

    // Copy docker-compose.prod.yml from resources
    let compose_candidates = compose_resource_candidates(resource_dir);

    let mut log_lines = vec![format!("initialize_hub: resource_dir = {:?}", resource_dir)];
    for (i, candidate) in compose_candidates.iter().enumerate() {
        log_lines.push(format!(
            "  candidate[{}]: {:?} exists={}",
            i,
            candidate,
            candidate.exists()
        ));
    }

    let compose_src = compose_candidates.iter().find(|p| p.exists());
    let compose_dst = data_dir.join(HUB_COMPOSE_FILENAME);

    if let Some(src) = compose_src {
        log_lines.push(format!("  -> using: {:?}", src));
        std::fs::copy(src, &compose_dst).map_err(|e| {
            let message = format!("Failed to copy compose file from {:?}: {}", src, e);
            let _ = append_desktop_log_for(&data_dir, "initialize", &message);
            with_view_logs_hint(message)
        })?;
        log_lines.push("  -> updated in data_dir".to_string());
    } else {
        // No bundled resource was located — fall back to the compile-time embedded
        // copy so the data-dir compose file always exists and startup can proceed.
        log_lines.push(
            "  -> WARNING: no compose file found in any candidate path; writing embedded fallback"
                .to_string(),
        );
        std::fs::write(&compose_dst, HUB_COMPOSE_SEED).map_err(|e| {
            let message = format!(
                "Failed to write embedded compose fallback to {:?}: {}",
                compose_dst, e
            );
            let _ = append_desktop_log_for(&data_dir, "initialize", &message);
            with_view_logs_hint(message)
        })?;
        let _ = append_desktop_log_for(
            &data_dir,
            "initialize",
            "No docker-compose.prod.yml resource was found in any candidate path; wrote the embedded fallback compose instead.",
        );
        log_lines.push("  -> wrote embedded fallback compose to data_dir".to_string());
    }

    // --- Regenerate the runtime env file with preserve-and-derive approach ---
    if let Err(error) = generate_container_docker_config(&data_dir, None) {
        let message = format!("Failed to generate .docker/config.json: {}", error);
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        return Err(with_view_logs_hint(message));
    }
    log_lines.push("  docker-config: .docker/config.json ready".to_string());

    let env_path = hub_env_path_for(&data_dir);
    let existing = load_runtime_env_values(&data_dir, &env_path);

    // Build .env content with deterministic key order
    let env_content = render_runtime_env_content(&data_dir, &existing);

    // Write the primary runtime env file, keeping the port lines the last start wrote
    let old_content = std::fs::read_to_string(&env_path).unwrap_or_default();
    // Strip port vars from old content for comparison (port manager manages those)
    let env_changed = strip_port_vars(&old_content) != env_content;
    std::fs::write(
        &env_path,
        launch_env_file_content(&env_content, &old_content),
    )
    .map_err(|e| {
        let message = format!("Failed to write {}: {}", env_path.display(), e);
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        with_view_logs_hint(message)
    })?;

    let compat_env_path = compat_hub_env_path_for(&data_dir);
    if compat_env_path != env_path {
        let _ = std::fs::write(&compat_env_path, &env_content);
    }

    log_lines.push(format!("  {} changed: {}", env_path.display(), env_changed));

    let mut traefik_preflight = prepare_traefik_runtime_state(&data_dir).map_err(|error| {
        let message = format!("Failed to prepare Traefik runtime state: {}", error);
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        with_view_logs_hint(message)
    })?;

    let docker_config_preflight = ensure_hub_docker_config_state(&data_dir).map_err(|error| {
        let message = format!(
            "Failed to prepare hub docker-config runtime state: {}",
            error
        );
        let _ = append_desktop_log_for(&data_dir, "initialize", &message);
        with_view_logs_hint(message)
    })?;
    traefik_preflight.merge(docker_config_preflight);

    if traefik_preflight.changed {
        mark_traefik_recreate_required(&data_dir).map_err(|error| {
            let message = format!(
                "Traefik runtime state changed, but the recreate marker could not be written: {}",
                error
            );
            let _ = append_desktop_log_for(&data_dir, "initialize", &message);
            with_view_logs_hint(message)
        })?;
    }

    let recreate_pending = is_traefik_recreate_required(&data_dir);
    log_lines.push(format!(
        "  traefik preflight: changed={} repaired_conflicting_paths={} recreate_pending={}",
        traefik_preflight.changed, traefik_preflight.repaired_conflicting_paths, recreate_pending,
    ));

    // Log init summary (centralised into desktop.log)
    let init_summary = log_lines.join("\n");
    let _ = append_desktop_log_for(&data_dir, "initialize", &init_summary);

    // Clean up legacy files that are no longer used
    let legacy_docker_config = data_dir.join(".docker-config.json");
    if legacy_docker_config.exists() {
        let _ = std::fs::remove_file(&legacy_docker_config);
    }
    for legacy_log in ["init.log", "port-resolution.log"] {
        let path = logs_dir_for(&data_dir).join(legacy_log);
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }

    Ok(HubInitialization {
        data_dir,
        compose_path: compose_dst,
        env_path,
        traefik_preflight,
    })
}

/// Generate a container-safe Docker config at `.docker/config.json` under the data dir.
///
/// Reads the host's `~/.docker/config.json`, strips host-only fields that
/// break the Docker CLI inside Linux containers (currentContext, credsStore
/// set to desktop/osxkeychain/wincred/secretservice/pass, plugins, features,
/// hooks), preserves inline `auth` entries and the `proxies` section, and also
/// preserves `credsStore` and `credHelpers` entries when they are not in the
/// host-only list.
///
/// If the destination path is a directory (stale Docker placeholder from a
/// previous failed mount), it is removed first.
///
/// `host_docker_dir` overrides the default `~/.docker` directory (used by
/// tests to avoid mutating global environment variables).
pub(crate) fn generate_container_docker_config(
    data_dir: &Path,
    host_docker_dir: Option<&Path>,
) -> Result<(), String> {
    let docker_dir = data_dir.join(".docker");
    let config_path = docker_dir.join("config.json");

    for legacy in LEGACY_DOCKER_CONFIG_PATHS {
        let legacy_path = data_dir.join(legacy);
        if legacy_path.is_file() && !config_path.exists() {
            if let Err(e) = std::fs::copy(&legacy_path, &config_path) {
                eprintln!(
                    "warning: could not migrate {} -> {}: {}",
                    legacy_path.display(),
                    config_path.display(),
                    e
                );
            }
        }
    }

    // On Windows, Docker may have created a directory at this path when the
    // file was missing during a previous `docker compose up`.  Remove it so
    // we can write a proper file.  Use symlink_metadata to avoid following
    // symlinks — refuse to proceed if the path is a symlink.
    match std::fs::symlink_metadata(&config_path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(format!(
                "Refusing to write Docker config at {:?} because the destination is a symlink",
                config_path
            ));
        }
        Ok(metadata) if metadata.is_dir() => match std::fs::remove_dir_all(&config_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "Cannot remove stale directory at {:?}: {}",
                    config_path, e
                ));
            }
        },
        Ok(_) => {} // Regular file — will be overwritten below
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {} // Does not exist yet
        Err(e) => {
            return Err(format!(
                "Cannot inspect Docker config path at {:?}: {}",
                config_path, e
            ));
        }
    }

    // Resolve the host Docker config path.  When no explicit override is
    // given, fall back to `~/.docker/config.json`.  If the home directory
    // can't be resolved, proceed with an empty config rather than
    // accidentally reading from the current working directory.
    let resolved_docker_dir: Option<PathBuf> = match host_docker_dir {
        Some(d) => Some(d.to_path_buf()),
        None => dirs::home_dir().map(|h| h.join(".docker")),
    };

    let host_config: serde_json::Value = if let Some(docker_dir) = resolved_docker_dir {
        let host_config_path = docker_dir.join("config.json");
        match std::fs::read_to_string(&host_config_path) {
            Ok(raw) => match serde_json::from_str(&raw) {
                Ok(config) => config,
                Err(e) => {
                    let msg = format!(
                        "Cannot parse host Docker config at {:?}: {}. Proceeding with empty config.",
                        host_config_path, e
                    );
                    stderr_fallback(&msg);
                    let _ = append_desktop_log_for(data_dir, "docker-config", &msg);
                    serde_json::json!({})
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
            Err(e) => {
                let msg = format!(
                    "Cannot read host Docker config at {:?}: {}. Proceeding with empty config.",
                    host_config_path, e
                );
                stderr_fallback(&msg);
                let _ = append_desktop_log_for(data_dir, "docker-config", &msg);
                serde_json::json!({})
            }
        }
    } else {
        serde_json::json!({})
    };

    // Credential-store values that rely on host-only binaries
    let host_only_credstores = ["desktop", "osxkeychain", "wincred", "secretservice", "pass"];

    let mut sanitized = serde_json::Map::new();

    // Preserve auths that carry inline `auth` tokens (the only kind that
    // works without a host-side credential helper binary).
    if let Some(auths) = host_config.get("auths").and_then(|v| v.as_object()) {
        let mut kept = serde_json::Map::new();
        for (registry, entry) in auths {
            if let Some(auth) = entry.get("auth").and_then(|a| a.as_str()) {
                if !auth.is_empty() {
                    kept.insert(registry.clone(), serde_json::json!({ "auth": auth }));
                }
            }
        }
        if !kept.is_empty() {
            sanitized.insert("auths".to_string(), serde_json::Value::Object(kept));
        }
    }

    // Keep credsStore only if it isn't a host-only helper
    if let Some(creds_store) = host_config.get("credsStore").and_then(|v| v.as_str()) {
        if !host_only_credstores.contains(&creds_store) {
            sanitized.insert(
                "credsStore".to_string(),
                serde_json::Value::String(creds_store.to_string()),
            );
        }
    }

    // Keep per-registry credHelpers that aren't host-only
    if let Some(helpers) = host_config.get("credHelpers").and_then(|v| v.as_object()) {
        let mut kept = serde_json::Map::new();
        for (registry, helper) in helpers {
            if let Some(h) = helper.as_str() {
                if !host_only_credstores.contains(&h) {
                    kept.insert(registry.clone(), serde_json::Value::String(h.to_string()));
                }
            }
        }
        if !kept.is_empty() {
            sanitized.insert("credHelpers".to_string(), serde_json::Value::Object(kept));
        }
    }

    // Keep `proxies` as it is: Docker Compose sets HTTP_PROXY, HTTPS_PROXY and
    // NO_PROXY (and the lower-case forms) from it in every container it
    // creates. The Hub's own compose calls read this copy (its stack updater
    // recreating `ci-hub`, every app install and start), so without it those
    // containers lacked the proxy that the desktop's containers get.
    if let Some(proxies) = host_config.get("proxies").filter(|v| v.is_object()) {
        sanitized.insert("proxies".to_string(), proxies.clone());
    }

    // Only auths (inline), credsStore (non-host-only), credHelpers
    // (non-host-only) and proxies are preserved.  Everything else is dropped:
    // currentContext, plugins, features, hooks, aliases, experimental, etc.
    // — all host-specific and either unused or harmful in-container.

    let content = serde_json::to_string_pretty(&serde_json::Value::Object(sanitized))
        .map_err(|e| format!("Cannot serialise docker config: {}", e))?;
    std::fs::create_dir_all(docker_dir.join("cli-plugins"))
        .map_err(|e| format!("Cannot create {}: {}", docker_dir.display(), e))?;

    // On Unix, write to a temp file with mode 0600, flush+sync, then
    // atomically rename over the destination.  This ensures the old config
    // stays in place if the write fails (disk full, crash).
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let tmp_path = docker_dir.join(".config.json.tmp");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp_path)
            .map_err(|e| format!("Cannot open {}: {}", tmp_path.display(), e))?;
        file.write_all(format!("{}\n", content).as_bytes())
            .map_err(|e| format!("Cannot write {}: {}", tmp_path.display(), e))?;
        file.flush()
            .map_err(|e| format!("Cannot flush {}: {}", tmp_path.display(), e))?;
        file.sync_all()
            .map_err(|e| format!("Cannot sync {}: {}", tmp_path.display(), e))?;
        std::fs::rename(&tmp_path, &config_path).map_err(|e| {
            format!(
                "Cannot rename {} -> {}: {}",
                tmp_path.display(),
                config_path.display(),
                e
            )
        })?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        std::fs::write(&config_path, format!("{}\n", content))
            .map_err(|e| format!("Cannot write {}: {}", config_path.display(), e))?;
    }

    Ok(())
}

/// The env file lines the port manager owns. It writes them when it starts the Hub.
const PORT_VAR_PREFIXES: [&str; 6] = [
    "API_PORT=",
    "POSTGRES_PORT=",
    "RABBITMQ_PORT=",
    "TRAEFIK_DASHBOARD_PORT=",
    "HTTP_PORT=",
    "HTTPS_PORT=",
];

fn is_port_var_line(line: &str) -> bool {
    PORT_VAR_PREFIXES
        .iter()
        .any(|prefix| line.starts_with(prefix))
}

/// The env file a launch writes: `rendered`, then the port lines of `previous`. Only a start writes
/// the ports, and a launch that finds the Hub running and unchanged doesn't start it, so the file
/// keeps the ones the last start chose. Dropping them made every launch hash a different file from
/// the one that start saved, and recreate the stack (Companion-Hub#1931).
pub(crate) fn launch_env_file_content(rendered: &str, previous: &str) -> String {
    let mut content = rendered.to_string();
    for line in previous.lines().filter(|line| is_port_var_line(line)) {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(line);
        content.push('\n');
    }
    content
}

/// Strip dynamic port variables from .env content for comparison purposes.
/// Port manager owns these vars (see [`PORT_VAR_PREFIXES`]).
pub(crate) fn strip_port_vars(content: &str) -> String {
    content
        .lines()
        .filter(|line| !is_port_var_line(line))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
