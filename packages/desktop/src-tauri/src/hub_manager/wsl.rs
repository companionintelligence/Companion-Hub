//! WSL2 Docker Engine backend: distro discovery, GPU runtime and Ollama reachability.

// Windows-only bodies below need the parent scope; on other hosts this looks unused.
#[allow(unused_imports)]
use super::*;

/// The daemon's self-reported host OS and kernel
/// (`docker info -f '{{.OperatingSystem}}\t{{.KernelVersion}}'`), or `None` if no
/// daemon is reachable.
#[cfg(windows)]
pub(crate) fn docker_server_os_and_kernel() -> Option<(String, String)> {
    let output = docker_command()
        .args([
            "info",
            "--format",
            "{{.OperatingSystem}}\t{{.KernelVersion}}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let line = raw.trim();
    if line.is_empty() {
        return None;
    }
    let (os, kernel) = line.split_once('\t').unwrap_or((line, ""));
    Some((os.trim().to_string(), kernel.trim().to_string()))
}

/// True when the active Docker daemon is a native Engine inside WSL2 (as opposed to
/// Docker Desktop). Docker Desktop manages the container GPU runtime itself; a native
/// engine needs nvidia-container-toolkit installed inside the distro. Mirrors the
/// backend's `detectContainerHostKind` and the CLI's `detectWindowsDockerBackend`.
#[cfg(windows)]
pub(crate) fn is_wsl_engine_docker_backend() -> bool {
    if let Some(context) = current_docker_context_name(None) {
        if context == DOCKER_CONTEXT_WSL_ENGINE {
            return true;
        }
        if context == "desktop-linux" || context == "desktop-windows" {
            return false;
        }
    }
    if let Some((os, kernel)) = docker_server_os_and_kernel() {
        if os.contains("Docker Desktop") {
            return false;
        }
        let kernel = kernel.to_ascii_lowercase();
        return kernel.contains("microsoft") || kernel.contains("wsl");
    }
    false
}

/// Whether the active Docker daemon has the `nvidia` container runtime registered.
#[cfg(windows)]
fn docker_has_nvidia_runtime() -> bool {
    docker_command()
        .args(["info", "--format", "{{json .Runtimes}}"])
        .output()
        .map(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("nvidia")
        })
        .unwrap_or(false)
}

/// The WSL2 distro hosting the Docker engine. The installer provisions Ubuntu, so
/// only an Ubuntu/Debian (apt-based) distro is a valid target for the apt install
/// flow below. Docker Desktop's own `docker-desktop*` utility distros are excluded,
/// and there is deliberately NO fallback to an arbitrary first distro — installing
/// the toolkit into the wrong distro (or running apt on a non-Debian one) would
/// silently fail to enable the GPU. Returns None → the caller skips setup cleanly.
///
/// Memoized for the process: the distro name is stable within a run, and both the GPU
/// and Ollama startup steps call this, so caching avoids a duplicate `wsl -l -q` spawn.
#[cfg(windows)]
pub(crate) fn find_wsl_distro() -> Option<String> {
    static WSL_DISTRO_CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    WSL_DISTRO_CACHE.get_or_init(compute_wsl_distro).clone()
}

#[cfg(windows)]
fn compute_wsl_distro() -> Option<String> {
    let mut command = Command::new("wsl.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    command.env("WSL_UTF8", "1");
    let output = command.args(["-l", "-q"]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(|line| line.trim().trim_matches('\u{0}').trim().to_string())
        .filter(|line| !line.is_empty())
        .find(|d| {
            let lower = d.to_ascii_lowercase();
            !lower.starts_with("docker-desktop")
                && (lower == "ubuntu"
                    || lower.starts_with("ubuntu-")
                    || lower == "debian"
                    || lower.starts_with("debian-"))
        })
}

/// Run a shell script as root inside a WSL2 distro (`wsl -d <distro> -u root -- sh -lc`).
/// Returns whether it exited 0. WSL_UTF8 keeps wsl.exe output UTF-8; CREATE_NO_WINDOW
/// suppresses a console flash. Shared by the GPU and Ollama in-distro setup steps.
#[cfg(windows)]
pub(crate) fn run_wsl_root_script(distro: &str, script: &str) -> bool {
    run_wsl_root_script_capture(distro, script).is_some()
}

/// Like `run_wsl_root_script` but returns the trimmed stdout on success (`None` on
/// failure), so callers can branch on a marker the script echoes.
#[cfg(windows)]
fn run_wsl_root_script_capture(distro: &str, script: &str) -> Option<String> {
    let mut command = Command::new("wsl.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    command.env("WSL_UTF8", "1");
    command.args(["-d", distro, "-u", "root", "--", "sh", "-lc", script]);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Install + configure nvidia-container-toolkit inside the WSL2 distro so the native
/// dockerd registers the `nvidia` runtime. Runs as root via `wsl -u root` (no sudo).
/// The Debian apt flow applies because `find_wsl_distro` only returns Ubuntu/Debian.
/// Idempotent: `gpg --yes` overwrites an existing keyring (so a retry after a failed
/// `apt-get` isn't wedged by a leftover file), and curl/gnupg are ensured first since
/// minimal WSL images may lack them.
#[cfg(windows)]
fn run_wsl_gpu_toolkit_setup(distro: &str) -> bool {
    run_wsl_root_script(
        distro,
        r#"set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl gnupg ca-certificates
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | gpg --yes --dearmor -o /etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | sed 's#deb https://#deb [signed-by=/etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null
apt-get update
apt-get install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || true"#,
    )
}

/// Whether the active Docker daemon is responding (`docker info` exits 0). Used to
/// confirm the in-distro dockerd is back after the runtime-config restart before the
/// caller proceeds to the (un-retried) database bootstrap.
#[cfg(windows)]
fn docker_daemon_responsive() -> bool {
    docker_command()
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// When the desktop runs against a native WSL2 Docker engine with an NVIDIA GPU,
/// ensure the container GPU runtime is configured inside the distro (Docker Desktop
/// does this automatically; a native engine does not). Idempotent and cheap after the
/// first success: it early-returns once `docker info` reports the `nvidia` runtime.
/// Best-effort — failure only means CPU-only inference, never blocks startup.
#[cfg(windows)]
pub(crate) fn ensure_wsl_engine_gpu_runtime(data_dir: &Path) {
    if !is_wsl_engine_docker_backend() {
        return;
    }
    // NVIDIA GPU present iff the just-refreshed probe cache exists (the refresh
    // removes it when no NVIDIA GPU is found).
    if !data_dir.join("state/hardware/nvidia.json").exists() {
        return;
    }
    if docker_has_nvidia_runtime() {
        return;
    }
    let Some(distro) = find_wsl_distro() else {
        let _ = append_desktop_log_for(
            data_dir,
            "gpu.runtime",
            "WSL2 engine + NVIDIA GPU detected, but no WSL distro was found; skipping container GPU runtime setup.",
        );
        return;
    };
    let _ = append_desktop_log_for(
        data_dir,
        "gpu.runtime",
        &format!("Configuring nvidia-container-toolkit inside WSL2 distro \"{distro}\" for the container GPU runtime…"),
    );
    if !run_wsl_gpu_toolkit_setup(&distro) {
        let _ = append_desktop_log_for(
            data_dir,
            "gpu.runtime",
            "Automatic nvidia-container-toolkit setup inside WSL2 failed; continuing without container GPU acceleration.",
        );
        return;
    }
    // The setup script restarts the in-distro dockerd so it loads the nvidia runtime.
    // That briefly drops the daemon the host CLI — and the imminent, UN-RETRIED
    // database bootstrap (start_database_first) — reach over tcp://127.0.0.1:2375.
    // Wait for the daemon to be responsive again before returning so that bootstrap
    // never hits a mid-restart daemon; report whether the runtime registered.
    const READINESS_WAIT_SECS: u32 = 20;
    for attempt in 0..READINESS_WAIT_SECS {
        if docker_daemon_responsive() {
            let message = if docker_has_nvidia_runtime() {
                "NVIDIA container runtime configured for the WSL2 Docker engine."
            } else {
                "Toolkit installed inside WSL2 but the nvidia runtime is not visible yet; it should register on the next start."
            };
            let _ = append_desktop_log_for(data_dir, "gpu.runtime", message);
            return;
        }
        if attempt + 1 < READINESS_WAIT_SECS {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    }
    let _ = append_desktop_log_for(
        data_dir,
        "gpu.runtime",
        "Toolkit installed inside WSL2 but the Docker daemon did not respond within the wait window after its restart; startup will continue.",
    );
}

/// systemd drop-in that binds the in-distro Ollama to all interfaces. Ollama defaults
/// to 127.0.0.1:11434 (the distro's loopback), which the Hub container cannot reach —
/// it only reaches the distro via the docker0 bridge gateway (172.17.0.1). Binding
/// 0.0.0.0 makes it reachable. Docker Desktop bridges this via host.docker.internal;
/// a native WSL2 engine does not, so we configure it ourselves.
#[cfg(windows)]
const OLLAMA_HOST_DROPIN_PATH: &str = "/etc/systemd/system/ollama.service.d/companionhub-host.conf";

/// Ensure the in-distro Ollama listens on 0.0.0.0 so the Hub container can reach it.
/// Only touches an existing `ollama` systemd service (installing Ollama is
/// `install_ollama`); shared by startup and the installer.
///
/// Idempotency is keyed on the *runtime* listener (whether Ollama is actually bound to
/// a wildcard address), NOT on our drop-in file — so a transient `systemctl restart`
/// failure is retried on the next call instead of being wedged forever. It also
/// respects a deliberate `OLLAMA_HOST` the user set outside our drop-in (we never
/// clobber a bind the user chose). Returns the last-line marker on success
/// (`configured` this call, `already`, `user-configured`, `no-service`) or `None` on
/// failure. The marker is taken from the last non-empty stdout line so a shell login
/// banner can't mask it.
#[cfg(windows)]
pub(crate) fn ensure_ollama_listens_on_all_interfaces(distro: &str) -> Option<String> {
    let output = run_wsl_root_script_capture(
        distro,
        &format!(
            r#"set -e
# Only configure a real ollama systemd service; installing Ollama is a separate step.
systemctl cat ollama >/dev/null 2>&1 || {{ echo no-service; exit 0; }}
# Already reachable from containers (bound to a wildcard address)? — checks the live
# listener, so a prior failed restart (still on loopback) is retried below.
if ss -ltn 2>/dev/null | grep -qE '(\*|0\.0\.0\.0|\[::\]):11434'; then echo already; exit 0; fi
# Respect a deliberate OLLAMA_HOST the user set outside our own drop-in.
if [ ! -f {path} ] && systemctl show ollama -p Environment 2>/dev/null | grep -q 'OLLAMA_HOST='; then
  echo user-configured; exit 0
fi
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' > {path}
systemctl daemon-reload
systemctl restart ollama
echo configured"#,
            path = OLLAMA_HOST_DROPIN_PATH
        ),
    )?;
    // Marker = last non-empty line (robust to any profile banner on stdout).
    Some(
        output
            .lines()
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("")
            .to_string(),
    )
}

/// True when the marker means Ollama is now reachable on the network (wildcard bind).
#[cfg(windows)]
pub(crate) fn ollama_bind_marker_is_reachable(marker: Option<&str>) -> bool {
    matches!(marker, Some("configured") | Some("already"))
}

/// When the desktop runs against a native WSL2 Docker engine, make an already-installed
/// in-distro Ollama reachable from the Hub container by binding it to 0.0.0.0. Runs at
/// startup, mirroring `ensure_wsl_engine_gpu_runtime`; idempotent and a silent no-op
/// once configured or when no Ollama service exists (installing it is `install_ollama`).
#[cfg(windows)]
pub(crate) fn ensure_wsl_engine_ollama_reachable(data_dir: &Path) {
    if !is_wsl_engine_docker_backend() {
        return;
    }
    let Some(distro) = find_wsl_distro() else {
        return;
    };
    // Only log the meaningful transition, so steady-state starts stay quiet.
    if ensure_ollama_listens_on_all_interfaces(&distro).as_deref() == Some("configured") {
        let _ = append_desktop_log_for(
            data_dir,
            "ollama.bridge",
            "Configured in-distro Ollama to listen on 0.0.0.0:11434 so the Hub container can reach it.",
        );
    }
}
