//! Windows host path normalization for Docker Desktop vs the WSL2 engine.

use super::*;

/// Name of the docker CLI context the in-app WSL2-engine installer creates and
/// activates (`docker context use …`, see `wsl2_engine_user_script`). Also the
/// primary daemon-independent signal for Windows bind-mount style detection — keep
/// the installer and the detector on this single constant so they cannot drift.
/// Gated to match its consumers (all Windows-only or test-only); on a non-Windows
/// release build there are none, and an ungated const would be a `-D warnings`
/// dead-code error.
#[cfg(any(test, target_os = "windows"))]
pub(crate) const DOCKER_CONTEXT_WSL_ENGINE: &str = "wsl-engine";

/// How a Windows host path must be rendered for the active Docker backend's bind
/// mounts. The two backends resolve host paths through entirely different layers:
///
/// - **Docker Desktop** shares the Windows filesystem into its VM, translating the
///   MSYS `/c/Users/...` form (and `C:\...`) back to the real Windows file.
/// - **Docker Engine running natively inside WSL2** has no such translation: its
///   filesystem *is* the WSL Linux root, where Windows drives are visible only under
///   `/mnt/<drive>/...`. A `/c/...` source does not exist there, so the daemon
///   silently creates an empty directory at that path and bind-mounts it — turning
///   every config/env *file* into a *directory* inside the container (EISDIR).
#[cfg(any(windows, test))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum WindowsDockerHostStyle {
    /// `/c/Users/...` — Docker Desktop.
    Drive,
    /// `/mnt/c/Users/...` — native Docker Engine inside WSL2.
    WslMnt,
}

/// Host path formatted for Docker bind mounts (`-v`, compose volume sources).
/// On Windows the drive form is chosen from the active backend (see
/// [`WindowsDockerHostStyle`]); `C:/...`, `C:\...`, MSYS `/c/...`, `/mnt/c/...`, and
/// `\\?\C:\...` are all accepted as input and normalized to the backend-correct form.
/// (Docker rejects a raw `C:/...` source because the drive colon is parsed as the
/// host/container delimiter, so the drive letter always moves into the leading path.)
pub(crate) fn docker_bind_mount_path(path: &Path) -> String {
    normalize_docker_host_path(&path.to_string_lossy())
}

/// Normalize a host path string for Docker bind mounts and compose `.env` values.
pub(crate) fn normalize_docker_host_path(value: &str) -> String {
    #[cfg(windows)]
    {
        // Resolve the backend style only for actual drive paths — non-drive values
        // (unix sockets, named pipes) never need detection, so they must not pay
        // for it (detection can spawn `docker info` in the fallback case).
        if split_windows_drive(value).is_some() {
            return normalize_windows_docker_host_path(value, windows_docker_host_style());
        }
        return value.trim().replace('\\', "/");
    }
    #[cfg(not(windows))]
    {
        value.trim().to_string()
    }
}

/// Extract `(lowercase_drive, "/rest/with/forward/slashes")` from any Windows path
/// form: `C:\...`, `C:/...`, `/c/...`, `/mnt/c/...`, or the `\\?\C:\...`
/// extended-length prefix. Returns `None` for non-drive paths (e.g. a `/var/run`
/// unix socket or a `//./pipe/...` named pipe), which callers pass through unchanged.
#[cfg(any(windows, test))]
fn split_windows_drive(value: &str) -> Option<(char, String)> {
    let replaced = value.trim().replace('\\', "/");
    // `\\?\C:\...` becomes `//?/C:/...` after the slash swap — strip the prefix.
    let trimmed = replaced.strip_prefix("//?/").unwrap_or(replaced.as_str());

    // `/mnt/<drive>` or `/mnt/<drive>/...`
    if let Some(rest) = trimmed.strip_prefix("/mnt/") {
        let bytes = rest.as_bytes();
        if !bytes.is_empty()
            && bytes[0].is_ascii_alphabetic()
            && (bytes.len() == 1 || bytes[1] == b'/')
        {
            let drive = (bytes[0] as char).to_ascii_lowercase();
            return Some((drive, rest[1..].to_string()));
        }
    }

    // `/<drive>` or `/<drive>/...` (MSYS/Git-Bash)
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && (bytes.len() == 2 || bytes[2] == b'/')
    {
        let drive = (bytes[1] as char).to_ascii_lowercase();
        return Some((drive, trimmed[2..].to_string()));
    }

    // `<drive>:` or `<drive>:/...`
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = trimmed[2..].trim_start_matches('/');
        let rest = if rest.is_empty() {
            String::new()
        } else {
            format!("/{rest}")
        };
        return Some((drive, rest));
    }

    None
}

/// Convert a Docker bind-mount path back to a native host path for filesystem access.
/// Built on the same [`split_windows_drive`] grammar as the forward normalizer so the
/// two cannot drift — every form `normalize_windows_docker_host_path` emits (including
/// bare drive roots like `/c` and `/mnt/c`) round-trips to the native `C:\...` path.
#[cfg(windows)]
pub(crate) fn host_path_from_docker_path(value: &str) -> PathBuf {
    match split_windows_drive(value) {
        Some((drive, rest)) => {
            let drive = drive.to_ascii_uppercase();
            let rest = rest.trim_start_matches('/').replace('/', "\\");
            PathBuf::from(format!("{drive}:\\{rest}"))
        }
        None => PathBuf::from(value),
    }
}

#[cfg(not(windows))]
pub(crate) fn host_path_from_docker_path(value: &str) -> PathBuf {
    PathBuf::from(value)
}

/// Windows bind-mount normalization (also unit-tested on other hosts). Rewrites any
/// recognized Windows path form to the drive form the active backend understands
/// (see [`WindowsDockerHostStyle`]). Non-drive inputs (unix sockets, named pipes)
/// pass through with only backslashes normalized to forward slashes.
#[cfg(any(windows, test))]
pub(crate) fn normalize_windows_docker_host_path(
    value: &str,
    style: WindowsDockerHostStyle,
) -> String {
    match split_windows_drive(value) {
        Some((drive, rest)) => match style {
            WindowsDockerHostStyle::Drive => format!("/{drive}{rest}"),
            WindowsDockerHostStyle::WslMnt => format!("/mnt/{drive}{rest}"),
        },
        None => value.trim().replace('\\', "/"),
    }
}

/// Sticky per-process fallback guess for the Windows bind-mount style, used only when
/// no deterministic CLI signal (env var / context name) resolves the backend. Sticky
/// on purpose: repeated calls must not flip mid-render (a mixed-style `.env` breaks
/// half the mounts) and must not re-spawn `docker info` per normalized value.
#[cfg(windows)]
static WINDOWS_DOCKER_HOST_STYLE_GUESS: std::sync::Mutex<Option<WindowsDockerHostStyle>> =
    std::sync::Mutex::new(None);

#[cfg(windows)]
pub(crate) fn windows_docker_host_style() -> WindowsDockerHostStyle {
    // Prefer the Hub-pinned engine so bind-mount path style stays paired with
    // DOCKER_HOST for compose / heal operations.
    if let Some(style) = crate::docker_engine::pinned_path_style(Some(&get_hub_data_dir())) {
        match style.as_str() {
            "drive" => return WindowsDockerHostStyle::Drive,
            "wsl-mnt" => return WindowsDockerHostStyle::WslMnt,
            _ => {}
        }
    }

    // Deterministic CLI signals are re-read on every call (cheap: env vars plus one
    // small file). This follows backend switches without an app restart — the in-app
    // WSL2-engine installer runs `docker context use wsl-engine` mid-session and its
    // setup flow promises the switch applies without restarting the Hub.
    if let Some(style) = windows_docker_host_style_from_cli_signals() {
        return style;
    }

    let mut guess = WINDOWS_DOCKER_HOST_STYLE_GUESS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(style) = *guess {
        return style;
    }
    let style = detect_windows_docker_host_style_via_daemon();
    *guess = Some(style);
    style
}

/// Style from deterministic CLI configuration, mirroring the docker CLI's own
/// precedence: explicit `CI_HUB_DOCKER_PATH_STYLE` override (ops escape hatch,
/// shared with the TS CLI in scripts/heal-hub-bind-mounts.ts) > `DOCKER_HOST` env >
/// `DOCKER_CONTEXT` env > config.json currentContext. A set `DOCKER_HOST` bypasses
/// contexts entirely (the CLI ignores them, and `docker_command` forwards it), so
/// contexts must not be consulted then — fall through to the daemon self-report,
/// which answers over that same endpoint.
#[cfg(windows)]
fn windows_docker_host_style_from_cli_signals() -> Option<WindowsDockerHostStyle> {
    if let Ok(override_value) = std::env::var("CI_HUB_DOCKER_PATH_STYLE") {
        match override_value.trim() {
            "drive" => return Some(WindowsDockerHostStyle::Drive),
            "wsl-mnt" => return Some(WindowsDockerHostStyle::WslMnt),
            _ => {}
        }
    }
    let docker_host_set = std::env::var("DOCKER_HOST")
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false);
    if docker_host_set {
        return None;
    }
    let context = std::env::var("DOCKER_CONTEXT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value != "default")
        .or_else(|| current_docker_context_name(None))?;
    match context.as_str() {
        DOCKER_CONTEXT_WSL_ENGINE => Some(WindowsDockerHostStyle::WslMnt),
        "desktop-linux" | "desktop-windows" => Some(WindowsDockerHostStyle::Drive),
        _ => None,
    }
}

/// One-shot expensive detection: ask the daemon to identify itself; fall back to a
/// filesystem heuristic when unreachable. The caller caches the result for the
/// process lifetime.
///  - OperatingSystem "Docker Desktop" → Drive (Desktop translates `/c/...` itself).
///  - A WSL kernel (`...-microsoft-standard-WSL2`) → WslMnt (native engine in WSL2).
///    Checked *after* the Desktop match — Desktop's own WSL2 backend also reports a
///    WSL kernel.
///  - Any other reachable daemon (remote engine, Windows-containers mode) has no
///    Windows-drive mapping in either style; keep the legacy Drive form.
///  - Daemon unreachable → `likely_docker_desktop` heuristic. Heuristic, not signal:
///    a stale `~/.docker/desktop` dir can survive a Desktop uninstall — but properly
///    installed WSL engines were already caught by the context check above.
#[cfg(windows)]
fn detect_windows_docker_host_style_via_daemon() -> WindowsDockerHostStyle {
    if let Some((os, kernel)) = docker_server_os_and_kernel() {
        if os.contains("Docker Desktop") {
            return WindowsDockerHostStyle::Drive;
        }
        let kernel = kernel.to_ascii_lowercase();
        if kernel.contains("microsoft") || kernel.contains("wsl") {
            return WindowsDockerHostStyle::WslMnt;
        }
        return WindowsDockerHostStyle::Drive;
    }
    if likely_docker_desktop() {
        WindowsDockerHostStyle::Drive
    } else {
        WindowsDockerHostStyle::WslMnt
    }
}
