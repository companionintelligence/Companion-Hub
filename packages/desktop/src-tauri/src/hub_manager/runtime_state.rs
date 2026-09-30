//! Host bind mounts, docker socket resolution and seeded runtime files.

use super::*;

/// Directories bind-mounted into the Hub container that must be writable on the host.
/// Keep policy aligned with `scripts/heal-hub-bind-mounts.ts`:
/// only `cache`, `logs`, and `user-config` are safe to auto-quarantine; data dirs
/// (`apps`, `app-data`, `media`, `repos`, `backups`) require manual ownership repair.
const HUB_BIND_MOUNT_DIRS: &[&str] = &[
    "cache",
    "state",
    "logs",
    "apps",
    "media",
    "repos",
    "app-data",
    "user-config",
    "backups",
];

/// Sibling tunnel dir bind-mounted at compose `${ROOT_FOLDER_HOST}/../tunnel`.
/// Kept separate from [`HUB_BIND_MOUNT_DIRS`] because it is not under the data dir.
fn ensure_sibling_tunnel_dir(data_dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    let tunnel_dir = tunnel_dir_for(data_dir);
    std::fs::create_dir_all(&tunnel_dir).map_err(|error| {
        format!(
            "Failed to create sibling tunnel dir {}: {}",
            tunnel_dir.display(),
            error
        )
    })?;
    #[cfg(unix)]
    if let Err(error) =
        std::fs::set_permissions(&tunnel_dir, std::fs::Permissions::from_mode(0o775))
    {
        eprintln!(
            "warning: could not chmod 775 {}: {}",
            tunnel_dir.display(),
            error
        );
    }
    Ok(())
}

/// Files prior root-owned Hub containers commonly leave on bind mounts (block EACCES on rewrite).
const HUB_STALE_ROOT_OWNED_FILES: &[(&str, &str)] = &[
    ("state", ".env.resolved"),
    ("logs", "app.log"),
    ("logs", "error.log"),
];

/// Persistent state files the backend must be able to write to at runtime. They are
/// repaired in place (not deleted) so existing data survives a root-owned container.
///
/// Both hold credentials: `settings.json` carries the host-local and Portal device keys,
/// and `seed` derives JWT_SECRET and every app's generated passwords. They are kept at
/// [`PRIVATE_STATE_FILE_MODE`], not the 0o666 they used to be chmodded to on every start.
const HUB_STATE_FILES_NEED_WRITE: &[(&str, &str)] =
    &[("state", "settings.json"), ("state", "seed")];

/// Owner read and write only, the mode the backend creates and keeps the credential files
/// at (`PRIVATE_STATE_FILE_MODE` in packages/backend/src/common/helpers/env-helpers.ts).
///
/// 0o666 was there so a container running as someone else could write them. It also let
/// every local user read the device key or plant one of their own. The Hub container
/// runs as this desktop user (or as root under Docker Desktop, which maps its files back
/// to this user), and where ownership has drifted the Docker chown in
/// `ensure_host_bind_mounts_writable` is the repair.
const PRIVATE_STATE_FILE_MODE: u32 = 0o600;

/// Clears group and other bits on a credential-bearing state file, and never adds any: a
/// file made 0o400 stays 0o400. Returns the mode it replaced, or `None` when it changed
/// nothing.
///
/// Only a file this user owns. The Hub container writes as this user, so taking bits off
/// anyone else's file could lock it out; those are left for the Docker chown, after which
/// the Hub restricts them itself on boot.
#[cfg(unix)]
pub(crate) fn restrict_private_state_file(path: &Path) -> Option<u32> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.uid() != host_container_uid_gid().0 {
        return None;
    }
    let current = metadata.mode() & 0o777;
    let restricted = current & PRIVATE_STATE_FILE_MODE;
    if restricted == current {
        return None;
    }
    match std::fs::set_permissions(path, std::fs::Permissions::from_mode(restricted)) {
        Ok(()) => Some(current),
        Err(error) => {
            // Not fatal: the Hub tries again on boot and logs it if it cannot either.
            eprintln!(
                "warning: could not restrict {} to {:o}: {}",
                path.display(),
                restricted,
                error
            );
            None
        }
    }
}

#[cfg(not(unix))]
pub(crate) fn restrict_private_state_file(_path: &Path) -> Option<u32> {
    // NTFS has no POSIX modes to restrict.
    None
}

fn restrict_private_state_files(data_dir: &Path) {
    for (subdir, file) in HUB_STATE_FILES_NEED_WRITE {
        let path = data_dir.join(subdir).join(file);
        if let Some(previous) = restrict_private_state_file(&path) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Restricted {subdir}/{file} from {previous:o} to {PRIVATE_STATE_FILE_MODE:o}: it holds credentials."
                ),
            );
        }
    }
}

/// Creates an empty `settings.json` at [`PRIVATE_STATE_FILE_MODE`].
pub(crate) fn seed_settings_json(settings_path: &Path) -> Result<(), String> {
    std::fs::write(settings_path, b"{}")
        .map_err(|error| format!("Failed to create {}: {}", settings_path.display(), error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(
            settings_path,
            std::fs::Permissions::from_mode(PRIVATE_STATE_FILE_MODE),
        );
    }
    Ok(())
}

/// UID/GID for the Hub container process — matches the desktop/CLI user that owns ROOT_FOLDER_HOST.
#[cfg(unix)]
pub(crate) fn host_container_uid_gid() -> (u32, u32) {
    unsafe { (libc::getuid(), libc::getgid()) }
}

#[cfg(unix)]
fn host_docker_gid() -> u32 {
    use std::os::unix::fs::MetadataExt;

    std::fs::metadata(host_docker_socket_path())
        .map(|metadata| metadata.gid())
        .unwrap_or(973)
}

fn docker_socket_path_from_docker_host(docker_host: &str) -> Option<PathBuf> {
    let socket_path = docker_host.strip_prefix("unix://")?.trim();
    if socket_path.is_empty() {
        return None;
    }
    Some(PathBuf::from(socket_path))
}

#[cfg_attr(not(windows), allow(dead_code))]
#[cfg(any(windows, test))]
fn resolved_host_docker_dir(host_docker_dir: Option<&Path>) -> Option<PathBuf> {
    match host_docker_dir {
        Some(docker_dir) => Some(docker_dir.to_path_buf()),
        None => dirs::home_dir().map(|home| home.join(".docker")),
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
#[cfg(any(windows, test))]
pub(crate) fn current_docker_context_name(host_docker_dir: Option<&Path>) -> Option<String> {
    let docker_dir = resolved_host_docker_dir(host_docker_dir)?;
    let raw = std::fs::read_to_string(docker_dir.join("config.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let context_name = parsed.get("currentContext")?.as_str()?.trim();
    if context_name.is_empty() || context_name == "default" {
        return None;
    }
    Some(context_name.to_string())
}

pub(crate) fn preferred_docker_host() -> Option<String> {
    crate::docker_engine::effective_docker_host(Some(&get_hub_data_dir()))
}

#[cfg(target_os = "linux")]
fn linux_docker_socket_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![PathBuf::from("/var/run/docker.sock")];
    if let Ok(runtime_dir) = std::env::var("XDG_RUNTIME_DIR") {
        candidates.push(PathBuf::from(runtime_dir).join("docker.sock"));
    }
    let uid = unsafe { libc::getuid() };
    candidates.push(PathBuf::from(format!("/run/user/{uid}/docker.sock")));
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".docker").join("run").join("docker.sock"));
        candidates.push(home.join(".docker").join("desktop").join("docker.sock"));
    }

    let mut deduped = Vec::new();
    for candidate in candidates {
        if !deduped.iter().any(|existing| existing == &candidate) {
            deduped.push(candidate);
        }
    }
    deduped
}

pub(crate) fn host_docker_socket_path() -> PathBuf {
    if let Some(socket_path) = preferred_docker_host()
        .as_deref()
        .and_then(docker_socket_path_from_docker_host)
    {
        return socket_path;
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(existing) = linux_docker_socket_candidates()
            .into_iter()
            .find(|candidate| candidate.exists())
        {
            return existing;
        }
    }

    PathBuf::from("/var/run/docker.sock")
}

#[cfg(not(target_os = "windows"))]
fn docker_socket_mount_arg() -> String {
    format!(
        "{}:/var/run/docker.sock:ro",
        docker_bind_mount_path(&host_docker_socket_path())
    )
}

/// Parse `stat -c "%u:%g"` output from a container probing the mounted Docker socket.
#[cfg(not(target_os = "windows"))]
pub(crate) fn parse_docker_socket_uid_gid(raw: &str) -> Option<(u32, u32)> {
    let trimmed = raw.trim();
    let (uid_raw, gid_raw) = trimmed.split_once(':')?;
    Some((uid_raw.parse().ok()?, gid_raw.parse().ok()?))
}

/// How the mounted Docker socket appears *inside* a throwaway container (authoritative for compose `user:`).
#[cfg(not(target_os = "windows"))]
fn docker_socket_uid_gid_inside_container() -> Option<(u32, u32)> {
    let socket_mount = docker_socket_mount_arg();
    let output = docker_command()
        .args([
            "run",
            "--rm",
            "-v",
            &socket_mount,
            "alpine",
            "stat",
            "-c",
            "%u:%g",
            "/var/run/docker.sock",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_docker_socket_uid_gid(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(unix)]
fn docker_gid_from_getent() -> Option<u32> {
    let output = std::process::Command::new("getent")
        .args(["group", "docker"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    let gid = line.split(':').nth(2)?.trim();
    gid.parse().ok()
}

fn default_docker_gid() -> u32 {
    #[cfg(unix)]
    {
        return docker_gid_from_getent().unwrap_or_else(host_docker_gid);
    }
    #[cfg(not(unix))]
    {
        973
    }
}

// Platform-neutral (env var + home-dir check); used by the Unix container-identity
// fallback below and by Windows backend-style detection.
pub(crate) fn likely_docker_desktop() -> bool {
    if std::env::var("DOCKER_HOST")
        .map(|value| value.contains("docker-desktop"))
        .unwrap_or(false)
    {
        return true;
    }
    if let Some(home) = dirs::home_dir() {
        return home.join(".docker").join("desktop").exists();
    }
    false
}

/// UID/GID for the Hub container and the host docker group GID for `group_add`.
/// Mirrors scripts/init-hub-data-dirs.ts so desktop launches stay compatible with Docker Desktop.
pub(crate) fn resolve_hub_container_identity() -> (u32, u32, u32) {
    // On Windows, Linux containers always run through Docker Desktop.
    // NTFS bind mounts do not honour Linux UID/GID ownership semantics, so the
    // container must run as root (0:0) to guarantee write access to host paths.
    // The Docker socket probe below cannot work on Windows because Docker Desktop
    // uses a named pipe (//./pipe/docker_engine) rather than /var/run/docker.sock.
    #[cfg(target_os = "windows")]
    {
        return (0, 0, default_docker_gid());
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Some((socket_uid, socket_gid)) = docker_socket_uid_gid_inside_container() {
            // Docker Desktop exposes the socket as root:root inside containers; group_add is ineffective.
            if socket_uid == 0 && socket_gid == 0 {
                return (0, 0, default_docker_gid());
            }
            let (host_uid, host_gid) = host_container_uid_gid();
            return (host_uid, host_gid, socket_gid);
        }

        if likely_docker_desktop() {
            return (0, 0, default_docker_gid());
        }

        let (host_uid, host_gid) = host_container_uid_gid();
        (host_uid, host_gid, default_docker_gid())
    }
}

/// Host paths bind-mounted into `/data/*` in the Hub container. Create as the current host user
/// so the Hub container (same UID/GID via compose) can read/write without world-writable dirs.
fn ensure_host_bind_mounts_writable(data_dir: &Path) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    for subdir in HUB_BIND_MOUNT_DIRS {
        let path = data_dir.join(subdir);
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("Failed to create {}: {}", path.display(), error))?;
        #[cfg(unix)]
        if let Err(error) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o775))
        {
            eprintln!("warning: could not chmod 775 {}: {}", path.display(), error);
        }
    }

    // Compose mounts ${ROOT_FOLDER_HOST}/../tunnel — create beside the data dir, not under it.
    ensure_sibling_tunnel_dir(data_dir)?;

    for (subdir, file) in HUB_STALE_ROOT_OWNED_FILES {
        let stale = data_dir.join(subdir).join(file);
        if stale.exists() && std::fs::remove_file(&stale).is_err() {
            eprintln!(
                "warning: could not remove stale {} (often root-owned). \
                 Docker permission repair will run if needed.",
                stale.display()
            );
        }
    }

    remove_host_root_owned_state_files(data_dir);

    let settings_path = data_dir.join("state").join("settings.json");
    if !settings_path.exists() {
        seed_settings_json(&settings_path)?;
    }

    restrict_private_state_files(data_dir);

    let docker_access = check_docker_access();
    if should_defer_docker_bind_mount_probe(&docker_access.state) {
        let detail = docker_access
            .detail
            .as_deref()
            .unwrap_or("no additional detail");
        let _ = append_desktop_log_for(
            data_dir,
            "initialize",
            &format!(
                "Skipping Docker-based bind-mount writability probes until Docker is ready. {}",
                detail
            ),
        );
        return Ok(());
    }

    // On Windows the Hub container always runs as root (UID/GID 0:0) and NTFS
    // bind mounts do not honour Linux ownership semantics, so there is nothing
    // to probe or heal.  The docker-run volume spec that these probes use
    // (`C:/path:/mnt:rw`) is also rejected by the Docker daemon on Windows
    // because it splits the spec on `:` and sees four components instead of
    // three (the Windows drive-letter colon is mistaken for a separator).
    // Attempting the probes therefore crashes startup — skip them entirely.
    #[cfg(not(target_os = "windows"))]
    {
        let (container_uid, container_gid, _) = resolve_hub_container_identity();
        let state_dir = data_dir.join("state");

        if !verify_container_can_write_file(&settings_path, container_uid, container_gid) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "state/settings.json not writable as Hub container {container_uid}:{container_gid}; repairing bind-mount permissions via Docker..."
                ),
            );
            heal_bind_mount_permissions_via_docker(
                data_dir,
                "state",
                container_uid,
                container_gid,
            )?;
            // The heal's `chmod -R a+rwX` just made the credential files world-writable.
            // Where it also left them owned by this user, they come straight back to
            // owner-only, before the check below confirms the container can still write.
            restrict_private_state_files(data_dir);
        }

        if !verify_container_can_write_file(&settings_path, container_uid, container_gid) {
            remove_host_root_owned_state_files(data_dir);
            if !settings_path.exists() {
                seed_settings_json(&settings_path)?;
            }
        }

        if !verify_container_can_write_file(&settings_path, container_uid, container_gid) {
            return Err(format!(
                "Hub data directory is not writable by the Hub container (UID/GID {container_uid}:{container_gid}). \
                 This usually happens when an older Hub version wrote bind-mounted files as a different user. \
                 Fix manually: sudo chown -R {container_uid}:{container_gid} \"{}\" \
                 or remove \"{}\" and restart the Hub.",
                state_dir.display(),
                settings_path.display()
            ));
        }
    }

    Ok(())
}

#[cfg(unix)]
fn is_host_root_owned_unwritable(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if !metadata.is_file() || metadata.uid() != 0 {
        return false;
    }

    let file = match std::fs::OpenOptions::new().append(true).open(path) {
        Ok(file) => file,
        Err(_) => return true,
    };
    drop(file);
    false
}

#[cfg(not(unix))]
fn is_host_root_owned_unwritable(_path: &Path) -> bool {
    false
}

fn remove_host_root_owned_state_files(data_dir: &Path) {
    for (subdir, file) in HUB_STATE_FILES_NEED_WRITE {
        let path = data_dir.join(subdir).join(file);
        if !path.exists() {
            continue;
        }
        if !is_host_root_owned_unwritable(&path) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Removed stale host-root-owned state file {}.",
                    path.display()
                ),
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn verify_container_can_write_file(host_file: &Path, uid: u32, gid: u32) -> bool {
    let host_dir = match host_file.parent() {
        Some(dir) => dir,
        None => return false,
    };
    if !host_dir.exists() {
        return false;
    }
    if !host_file.exists() {
        return verify_container_can_write_dir(host_dir, uid, gid);
    }

    let file_name = match host_file.file_name().and_then(|name| name.to_str()) {
        Some(name) => name,
        None => return false,
    };

    let mount_spec = format!("{}:/mnt:rw", docker_bind_mount_path(host_dir));
    let user_spec = format!("{uid}:{gid}");
    let script = format!("touch /mnt/{file_name}");
    let output = docker_command()
        .args([
            "run",
            "--rm",
            "--user",
            &user_spec,
            "-v",
            &mount_spec,
            "alpine:3.20",
            "sh",
            "-c",
            &script,
        ])
        .output();

    match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn verify_container_can_write_dir(host_dir: &Path, uid: u32, gid: u32) -> bool {
    if !host_dir.exists() {
        return false;
    }

    let mount_spec = format!("{}:/mnt:rw", docker_bind_mount_path(host_dir));
    let user_spec = format!("{uid}:{gid}");
    let output = docker_command()
        .args([
            "run",
            "--rm",
            "--user",
            &user_spec,
            "-v",
            &mount_spec,
            "alpine:3.20",
            "sh",
            "-c",
            "touch /mnt/.ci-hub-write-probe && rm -f /mnt/.ci-hub-write-probe",
        ])
        .output();

    match output {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn heal_bind_mount_permissions_via_docker(
    data_dir: &Path,
    subdir: &str,
    uid: u32,
    gid: u32,
) -> Result<(), String> {
    let host_subdir = data_dir.join(subdir);
    if !host_subdir.exists() {
        return Ok(());
    }

    let mount_spec = format!("{}:/mnt:rw", docker_bind_mount_path(&host_subdir));
    let script = format!(
        "chown -R {uid}:{gid} /mnt 2>/dev/null || true; \
         chmod -R u+rwX,g+rwX,o+rwX /mnt 2>/dev/null || chmod -R a+rwX /mnt 2>/dev/null || true"
    );

    let output = docker_command()
        .args([
            "run",
            "--rm",
            "--user",
            "0:0",
            "-v",
            &mount_spec,
            "alpine:3.20",
            "sh",
            "-c",
            &script,
        ])
        .output()
        .map_err(|error| format!("Failed to run Docker permission repair: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    Err(format!(
        "Docker permission repair failed for {}: {}",
        host_subdir.display(),
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

/// Backward-compatible alias used at hub startup.
pub(crate) fn ensure_host_state_tree_writable(data_dir: &Path) -> Result<(), String> {
    ensure_host_bind_mounts_writable(data_dir)
}

/// Remove a project container that is not running but may still hold published host ports.
pub(crate) fn ensure_container_released_if_not_running(
    data_dir: &Path,
    container_name: &str,
    ports_hint: &str,
) -> Result<(), String> {
    let output = docker_command()
        .args(["inspect", container_name, "--format", "{{.State.Status}}"])
        .output()
        .map_err(|error| {
            format!(
                "Failed to inspect {} container state: {}",
                container_name, error
            )
        })?;

    if !output.status.success() {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        if is_docker_missing_resource_message(&combined) {
            return Ok(());
        }
        return Err(format!(
            "Failed to inspect {} container state. {}",
            container_name, combined
        ));
    }

    let status = String::from_utf8_lossy(&output.stdout)
        .trim()
        .to_lowercase();
    if status == "running" || status == "restarting" {
        return Ok(());
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Removing non-running {} container (state={}) to release host ports {}.",
            container_name, status, ports_hint
        ),
    );

    let output = docker_command()
        .args(["rm", "-f", container_name])
        .output()
        .map_err(|error| format!("Failed to remove {} container: {}", container_name, error))?;

    if output.status.success() {
        return Ok(());
    }

    let combined = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );
    Err(format!(
        "Failed to remove non-running {} container. {}",
        container_name, combined
    ))
}

fn ensure_runtime_directory(path: &Path) -> Result<TraefikRuntimePreflight, String> {
    let mut result = TraefikRuntimePreflight::default();

    if path.exists() {
        if path.is_dir() {
            return Ok(result);
        }

        std::fs::remove_file(path).map_err(|error| {
            format!(
                "Failed to remove conflicting file at {}: {}",
                path.display(),
                error
            )
        })?;
        result.changed = true;
        result.repaired_conflicting_paths = true;
    }

    std::fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create directory {}: {}", path.display(), error))?;
    result.changed = true;
    Ok(result)
}

fn ensure_seeded_text_file(path: &Path, contents: &str) -> Result<TraefikRuntimePreflight, String> {
    let mut result = TraefikRuntimePreflight::default();

    if let Some(parent) = path.parent() {
        result.merge(ensure_runtime_directory(parent)?);
    }

    if path.exists() {
        if path.is_dir() {
            std::fs::remove_dir_all(path).map_err(|error| {
                format!(
                    "Failed to remove conflicting directory at {}: {}",
                    path.display(),
                    error
                )
            })?;
            result.changed = true;
            result.repaired_conflicting_paths = true;
        } else {
            let existing = std::fs::read(path)
                .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
            if existing == contents.as_bytes() {
                return Ok(result);
            }
        }
    }

    std::fs::write(path, contents)
        .map_err(|error| format!("Failed to write {}: {}", path.display(), error))?;
    result.changed = true;
    Ok(result)
}

fn ensure_runtime_file(
    path: &Path,
    default_contents: &str,
    file_mode: Option<u32>,
) -> Result<TraefikRuntimePreflight, String> {
    let mut result = TraefikRuntimePreflight::default();

    if let Some(parent) = path.parent() {
        result.merge(ensure_runtime_directory(parent)?);
    }

    let should_write = if path.exists() {
        if path.is_dir() {
            std::fs::remove_dir_all(path).map_err(|error| {
                format!(
                    "Failed to remove conflicting directory at {}: {}",
                    path.display(),
                    error
                )
            })?;
            result.changed = true;
            result.repaired_conflicting_paths = true;
            true
        } else {
            false
        }
    } else {
        true
    };

    if should_write {
        std::fs::write(path, default_contents)
            .map_err(|error| format!("Failed to write {}: {}", path.display(), error))?;
        if let Some(mode) = file_mode {
            set_file_mode(path, mode)?;
        }
        result.changed = true;
    }

    Ok(result)
}

fn set_file_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).map_err(|error| {
            format!("Failed to set permissions on {}: {}", path.display(), error)
        })?;
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (path, mode);
    }

    Ok(())
}

pub(crate) fn prepare_traefik_runtime_state(
    data_dir: &Path,
) -> Result<TraefikRuntimePreflight, String> {
    let mut result = TraefikRuntimePreflight::default();

    for relative_dir in [
        TRAEFIK_STATE_DIR,
        TRAEFIK_CONFIG_DIR,
        TRAEFIK_DYNAMIC_DIR,
        TRAEFIK_TLS_DIR,
    ] {
        result.merge(ensure_runtime_directory(&data_dir.join(relative_dir))?);
    }

    result.merge(ensure_seeded_text_file(
        &data_dir.join(TRAEFIK_CONFIG_FILE),
        &seeded_traefik_config_contents(),
    )?);
    result.merge(ensure_seeded_text_file(
        &data_dir.join(TRAEFIK_DYNAMIC_FILE),
        TRAEFIK_DYNAMIC_CONFIG_SEED,
    )?);
    result.merge(ensure_runtime_file(
        &data_dir.join(TRAEFIK_ACME_FILE),
        TRAEFIK_ACME_DEFAULT_CONTENT,
        Some(0o600),
    )?);

    Ok(result)
}

pub(crate) fn ensure_hub_docker_config_state(
    data_dir: &Path,
) -> Result<TraefikRuntimePreflight, String> {
    let docker_dir = data_dir.join(".docker");
    std::fs::create_dir_all(docker_dir.join("cli-plugins"))
        .map_err(|e| format!("Cannot create {}: {}", docker_dir.display(), e))?;
    ensure_runtime_file(&data_dir.join(HUB_DOCKER_CONFIG_FILE), "{}", None)
}

pub(crate) fn is_docker_missing_resource_message(output: &str) -> bool {
    let lower = output.to_ascii_lowercase();
    lower.contains("no such container") || lower.contains("no such object")
}
