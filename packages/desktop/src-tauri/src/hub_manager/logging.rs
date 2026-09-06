//! Desktop log file reading, formatting and rotation; tunnel token state.

use super::*;

/// Read the desktop log file (last `max_lines` lines) for in-app diagnostics.
///
/// Uses a bounded tail read from the end of the file to avoid loading the entire
/// file into memory when the log has grown large.
pub fn read_desktop_logs(max_lines: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};

    let log_path = desktop_log_path();
    let mut file = match std::fs::File::open(&log_path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };

    let file_len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if file_len == 0 {
        return String::new();
    }

    // Read at most 256 KB from the end — more than enough for a few hundred lines.
    const MAX_TAIL_BYTES: u64 = 256 * 1024;
    let read_from = file_len.saturating_sub(MAX_TAIL_BYTES);
    let _ = file.seek(SeekFrom::Start(read_from));

    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return String::new();
    }

    let lines: Vec<&str> = buf.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    // If we seeked into the middle of the file, the first "line" is likely
    // a partial line — skip it when we didn't start from the beginning.
    let start = if read_from > 0 && start == 0 && lines.len() > 1 {
        1
    } else {
        start
    };
    lines[start..].join("\n")
}

/// Canonical tunnel dir on disk — sibling of the Hub data dir.
///
/// Matches compose `${ROOT_FOLDER_HOST}/../tunnel` (desktop + CLI + heal scripts).
/// Do not use `<data_dir>/tunnel`; that nested path is legacy-only.
pub(crate) fn tunnel_dir_for(data_dir: &Path) -> PathBuf {
    data_dir
        .parent()
        .map(|parent| parent.join("tunnel"))
        .unwrap_or_else(|| data_dir.join("tunnel"))
}

/// Pre-sibling migration path (`<data_dir>/tunnel`). Still accepted when reading.
fn legacy_tunnel_dir_for(data_dir: &Path) -> PathBuf {
    data_dir.join("tunnel")
}

pub(crate) fn tunnel_token_path_for(data_dir: &Path) -> PathBuf {
    tunnel_dir_for(data_dir).join("token")
}

fn legacy_tunnel_token_path_for(data_dir: &Path) -> PathBuf {
    legacy_tunnel_dir_for(data_dir).join("token")
}

/// True when a non-empty tunnel token exists at the canonical sibling path or the legacy nested path.
pub(crate) fn tunnel_token_present_for_data_dir(data_dir: &Path) -> bool {
    for path in [
        tunnel_token_path_for(data_dir),
        legacy_tunnel_token_path_for(data_dir),
    ] {
        if std::fs::metadata(&path)
            .map(|m| m.is_file() && m.len() > 0)
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

const TUNNEL_USER_CLEARED_MARKER: &str = ".user-cleared-token";

pub(crate) fn tunnel_user_cleared_marker_path_for(data_dir: &Path) -> PathBuf {
    tunnel_dir_for(data_dir).join(TUNNEL_USER_CLEARED_MARKER)
}

/// Remove the Cloudflare tunnel token file and record that the user intentionally cleared it.
/// Returns a human-readable summary of what was removed for logging. Errors only
/// when the filesystem refuses to delete an existing file — a missing token is a
/// no-op success since the post-condition (no token on disk) is already satisfied.
///
/// Clears both the canonical sibling token and any legacy nested copy so profile
/// detection and compose cannot resurrect a "cleared" tunnel from the old path.
pub fn clear_tunnel_token(data_dir: &Path) -> Result<String, String> {
    let token_path = tunnel_token_path_for(data_dir);
    let legacy_token_path = legacy_tunnel_token_path_for(data_dir);
    let tunnel_dir = tunnel_dir_for(data_dir);
    let marker_path = tunnel_user_cleared_marker_path_for(data_dir);

    let mut removed: Vec<String> = Vec::new();
    for path in [&token_path, &legacy_token_path] {
        if path.exists() {
            std::fs::remove_file(path).map_err(|e| {
                format!("Failed to remove tunnel token at {}: {}", path.display(), e)
            })?;
            removed.push(path.display().to_string());
        }
    }

    std::fs::create_dir_all(&tunnel_dir).map_err(|e| {
        format!(
            "Failed to create tunnel dir at {}: {}",
            tunnel_dir.display(),
            e
        )
    })?;
    std::fs::write(&marker_path, b"1").map_err(|e| {
        format!(
            "Failed to write tunnel user-cleared marker at {}: {}",
            marker_path.display(),
            e
        )
    })?;

    let summary = if !removed.is_empty() {
        format!(
            "Tunnel token cleared ({}) and user-cleared marker written.",
            removed.join(", ")
        )
    } else {
        format!(
            "No tunnel token to clear at {} (already absent); user-cleared marker written.",
            token_path.display()
        )
    };
    Ok(summary)
}

pub(crate) fn managed_app_container_ps_args() -> [&'static str; 6] {
    [
        "ps",
        "-q",
        "--filter",
        HUB_MANAGED_LABEL_FILTER,
        "--filter",
        HUB_APPURN_LABEL_FILTER,
    ]
}

pub(crate) fn legacy_managed_app_container_ps_args() -> [&'static str; 6] {
    [
        "ps",
        "-q",
        "--filter",
        LEGACY_HUB_MANAGED_LABEL_FILTER,
        "--filter",
        LEGACY_HUB_APPURN_LABEL_FILTER,
    ]
}

pub(crate) fn list_managed_app_container_ids() -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for args in [
        managed_app_container_ps_args(),
        legacy_managed_app_container_ps_args(),
    ] {
        let output = docker_command()
            .args(args)
            .output()
            .map_err(|error| format!("Failed to list running app containers: {}", error))?;

        let combined_output = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );

        if !output.status.success() {
            return Err(if combined_output.is_empty() {
                format!(
                    "Listing running app containers failed with exit code {:?}.",
                    output.status.code()
                )
            } else {
                format!("Listing running app containers failed. {}", combined_output)
            });
        }

        for id in parse_container_ids(&String::from_utf8_lossy(&output.stdout)) {
            if seen.insert(id.clone()) {
                ids.push(id);
            }
        }
    }
    Ok(ids)
}

pub(crate) fn parse_container_ids(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn format_log_entry(operation: &str, message: &str) -> String {
    let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return format!("[{}] {}\n", timestamp, operation);
    }

    let mut lines = trimmed.lines();
    let first_line = lines.next().unwrap_or_default().trim_end();
    let mut formatted = format!("[{}] {}: {}\n", timestamp, operation, first_line);
    for line in lines {
        formatted.push_str(&format!("    {}\n", line.trim_end()));
    }
    formatted
}

pub(crate) fn append_desktop_log_for(
    data_dir: &Path,
    operation: &str,
    message: &str,
) -> std::io::Result<PathBuf> {
    let logs_dir = logs_dir_for(data_dir);
    let log_path = desktop_log_path_for(data_dir);
    let entry = format_log_entry(operation, message);

    if let Err(err) = std::fs::create_dir_all(&logs_dir) {
        // Fallback: emit to stderr so the entry is not silently lost.
        stderr_fallback(&format!(
            "[desktop-log-fallback] create_dir_all({}) failed: {}",
            logs_dir.display(),
            err
        ));
        stderr_fallback(&entry);
        return Err(err);
    }

    // Hold the lock across rotation + write so concurrent callers cannot
    // interleave renames and appends.
    let _lock = lock_recovering(&LOG_WRITE_LOCK);

    rotate_log_if_needed(&log_path, &logs_dir, MAX_LOG_SIZE_BYTES);
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(mut file) => {
            use std::io::Write;
            if let Err(err) = file.write_all(entry.as_bytes()) {
                stderr_fallback(&format!(
                    "[desktop-log-fallback] failed to append to {}: {}",
                    log_path.display(),
                    err
                ));
                stderr_fallback(&entry);
                return Err(err);
            }
        }
        Err(err) => {
            stderr_fallback(&format!(
                "[desktop-log-fallback] failed to write {}: {}",
                log_path.display(),
                err
            ));
            stderr_fallback(&entry);
            return Err(err);
        }
    }

    crate::error_reporting::record_log_event(operation, message);
    Ok(log_path)
}

/// Write `msg` to stderr without panicking.  In a GUI desktop app stderr
/// can be closed/missing, so we must not use `eprintln!` (which unwraps
/// internally).
pub(crate) fn stderr_fallback(msg: &str) {
    use std::io::Write;
    let _ = std::io::stderr().write_all(msg.as_bytes());
    // Ensure a trailing newline so entries don't run together.
    if !msg.ends_with('\n') {
        let _ = std::io::stderr().write_all(b"\n");
    }
}

/// Rotate `desktop.log` when it reaches or exceeds `max_size` bytes.
///
/// Checked before each append, so the active file may slightly exceed
/// `max_size` by the size of the most recent log entry.
///
/// Keeps up to `MAX_LOG_ROTATIONS` historical files:
///   desktop.log.3 → deleted
///   desktop.log.2 → desktop.log.3
///   desktop.log.1 → desktop.log.2
///   desktop.log   → desktop.log.1
pub(crate) fn rotate_log_if_needed(log_path: &Path, logs_dir: &Path, max_size: u64) {
    let size = match std::fs::metadata(log_path) {
        Ok(metadata) => metadata.len(),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return,
        Err(err) => {
            stderr_fallback(&format!(
                "[log-rotate] failed to read metadata for {}: {}",
                log_path.display(),
                err
            ));
            return;
        }
    };
    if size < max_size {
        return;
    }

    // Remove the oldest rotation explicitly (it will be shifted off the end).
    let oldest = logs_dir.join(format!("{}.{}", DESKTOP_LOG_FILENAME, MAX_LOG_ROTATIONS));
    remove_if_exists(&oldest);

    // Shift existing rotations: .2→.3, .1→.2, current→.1.
    // Try rename first; only delete dst and retry when the error is AlreadyExists
    // (Windows) so we don't discard a valid rotated file on other failures.
    for i in (1..MAX_LOG_ROTATIONS).rev() {
        let src = logs_dir.join(format!("{}.{}", DESKTOP_LOG_FILENAME, i));
        let dst = logs_dir.join(format!("{}.{}", DESKTOP_LOG_FILENAME, i + 1));
        rename_or_replace(&src, &dst);
    }
    let rotated = logs_dir.join(format!("{}.1", DESKTOP_LOG_FILENAME));
    rename_or_replace(log_path, &rotated);
}

/// Remove a file, ignoring "not found" but logging other errors to stderr.
fn remove_if_exists(path: &Path) {
    if let Err(err) = std::fs::remove_file(path) {
        if err.kind() != std::io::ErrorKind::NotFound {
            stderr_fallback(&format!(
                "[log-rotate] failed to remove {}: {}",
                path.display(),
                err
            ));
        }
    }
}

/// Rename `src` to `dst`, skipping silently when `src` doesn't exist.
/// On `AlreadyExists` (Windows), removes `dst` and retries so that the
/// existing destination is only deleted when the rename can actually proceed.
fn rename_or_replace(src: &Path, dst: &Path) {
    match std::fs::rename(src, dst) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
            remove_if_exists(dst);
            if let Err(retry_err) = std::fs::rename(src, dst) {
                if retry_err.kind() != std::io::ErrorKind::NotFound {
                    stderr_fallback(&format!(
                        "[log-rotate] failed to rename {} -> {}: {}",
                        src.display(),
                        dst.display(),
                        retry_err
                    ));
                }
            }
        }
        Err(err) => {
            stderr_fallback(&format!(
                "[log-rotate] failed to rename {} -> {}: {}",
                src.display(),
                dst.display(),
                err
            ));
        }
    }
}

pub fn append_desktop_log(operation: &str, message: &str) -> std::io::Result<PathBuf> {
    append_desktop_log_for(&get_hub_data_dir(), operation, message)
}

pub(crate) fn with_view_logs_hint(message: impl Into<String>) -> String {
    format!("{} Open tray → View Logs for details.", message.into())
}
