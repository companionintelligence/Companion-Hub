//! WSL2 Docker Engine backend: distro discovery, keeping the engine running, where the Hub reaches
//! the update listener, GPU runtime and Ollama reachability.

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

// ─── Keeping the engine running ───────────────────────────────────────────────
//
// WSL stops a distro soon after its last foreground process ends, and systemd services such as
// dockerd don't count. The installer's logon script runs `sleep infinity` in the distro for that,
// so after `wsl --shutdown` or `wsl --terminate` nothing started the engine again until the next
// logon, and the Hub stayed down.

/// How long a start waits for Docker to answer once the distro runs again. systemd boots and
/// starts dockerd in about 15 seconds.
#[cfg(windows)]
const WSL_ENGINE_START_TIMEOUT: Duration = Duration::from_secs(90);

/// The status polls ask every few seconds. A keepalive that ends at once (no distro, a broken WSL)
/// is not started again sooner than this unless the user asks.
#[cfg(any(test, windows))]
const WSL_KEEPALIVE_RETRY_AFTER: Duration = Duration::from_secs(30);

/// The engine the Hub runs on: the one this process pinned, else the one the last start recorded.
pub(crate) fn hub_docker_engine(
    data_dir: &Path,
) -> Option<crate::docker_engine::PinnedDockerEngine> {
    crate::docker_engine::pinned_engine()
        .or_else(|| crate::docker_engine::load_persisted_engine(data_dir))
}

/// Whether Docker not answering should start the WSL engine's distro again: only for a Hub on
/// that engine, and not while the user has the Hub stopped.
#[cfg(any(test, windows))]
pub(crate) fn wsl_engine_should_revive(
    engine: Option<&crate::docker_engine::PinnedDockerEngine>,
    user_stopped: bool,
) -> bool {
    !user_stopped
        && engine
            .is_some_and(|engine| engine.kind == crate::docker_engine::DockerEngineKind::WslEngine)
}

/// `wsl.exe` arguments for the keepalive: the command the installer's logon script runs.
#[cfg(any(test, windows))]
pub(crate) fn wsl_keepalive_args(distro: &str) -> [&str; 7] {
    ["-d", distro, "-u", "root", "--", "sleep", "infinity"]
}

#[cfg(any(test, windows))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeepaliveState {
    Running,
    /// Ended, with its exit code when it has one.
    Exited(Option<i32>),
}

/// A process that keeps the WSL engine's distro running.
#[cfg(any(test, windows))]
pub(crate) trait KeepaliveProcess {
    fn state(&mut self) -> KeepaliveState;
}

#[cfg(windows)]
impl KeepaliveProcess for std::process::Child {
    fn state(&mut self) -> KeepaliveState {
        match self.try_wait() {
            Ok(None) => KeepaliveState::Running,
            Ok(Some(status)) => KeepaliveState::Exited(status.code()),
            Err(_) => KeepaliveState::Exited(None),
        }
    }
}

#[cfg(any(test, windows))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeepaliveStart {
    Started,
    /// The keepalive this app started still runs.
    AlreadyRunning,
    /// The last attempt was under [`WSL_KEEPALIVE_RETRY_AFTER`] ago.
    TooSoon,
}

/// The keepalive this app started, if any, and when it last tried to start one.
#[cfg(any(test, windows))]
pub(crate) struct WslKeepalive<P> {
    process: Option<P>,
    last_attempt: Option<Instant>,
}

#[cfg(any(test, windows))]
impl<P> WslKeepalive<P> {
    pub(crate) const fn new() -> Self {
        Self {
            process: None,
            last_attempt: None,
        }
    }
}

#[cfg(any(test, windows))]
impl<P: KeepaliveProcess> WslKeepalive<P> {
    /// Starts a keepalive with `spawn` unless the one this app started still runs. Within
    /// [`WSL_KEEPALIVE_RETRY_AFTER`] of the last attempt it waits instead, unless `force`.
    pub(crate) fn ensure(
        &mut self,
        now: Instant,
        force: bool,
        spawn: impl FnOnce() -> Result<P, String>,
    ) -> Result<KeepaliveStart, String> {
        if self.state() == Some(KeepaliveState::Running) {
            return Ok(KeepaliveStart::AlreadyRunning);
        }
        let recent = self
            .last_attempt
            .is_some_and(|at| now.saturating_duration_since(at) < WSL_KEEPALIVE_RETRY_AFTER);
        if recent && !force {
            return Ok(KeepaliveStart::TooSoon);
        }
        self.last_attempt = Some(now);
        self.process = Some(spawn()?);
        Ok(KeepaliveStart::Started)
    }

    /// The state of the keepalive this app started, or `None` when it never started one.
    pub(crate) fn state(&mut self) -> Option<KeepaliveState> {
        self.process.as_mut().map(KeepaliveProcess::state)
    }
}

#[cfg(windows)]
static WSL_KEEPALIVE: Mutex<WslKeepalive<std::process::Child>> = Mutex::new(WslKeepalive::new());

/// Starts the WSL engine's distro with the keepalive, unless the one this app started still
/// runs. `force` skips the wait between attempts.
#[cfg(windows)]
fn start_wsl_keepalive(data_dir: &Path, force: bool) -> Result<KeepaliveStart, String> {
    let mut started_distro = None;
    let outcome = lock_recovering(&WSL_KEEPALIVE).ensure(Instant::now(), force, || {
        // A unit test must never start WSL on the machine running it.
        if cfg!(test) {
            return Err("Unit tests don't start WSL.".to_string());
        }
        let distro = find_wsl_distro().ok_or_else(|| {
            "No Ubuntu or Debian WSL distro was found for the Docker engine.".to_string()
        })?;
        let mut command = Command::new("wsl.exe");
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .args(wsl_keepalive_args(&distro))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let child = command
            .spawn()
            .map_err(|error| format!("Couldn't start WSL distro {distro}: {error}"))?;
        started_distro = Some(distro);
        Ok(child)
    });
    if let (Ok(KeepaliveStart::Started), Some(distro)) = (&outcome, started_distro) {
        let _ = append_desktop_log_for(
            data_dir,
            "wsl.engine",
            &format!(
                "Docker in WSL didn't answer, so the app started WSL distro {distro} again (wsl.exe {}).",
                wsl_keepalive_args(&distro).join(" ")
            ),
        );
    }
    outcome
}

/// When the Hub runs on the WSL engine and Docker doesn't answer, start the engine's distro again.
/// The status polls call this, so it never waits: they see Docker once it answers. A failure is
/// left to Start engine to report, rather than logged every 30 seconds.
#[cfg(windows)]
pub(crate) fn revive_wsl_engine(data_dir: &Path) {
    if wsl_engine_should_revive(
        hub_docker_engine(data_dir).as_ref(),
        is_user_stopped(data_dir),
    ) {
        let _ = start_wsl_keepalive(data_dir, false);
    }
}

/// Start the WSL engine now and wait until Docker answers, for Start engine and for a Hub start
/// that finds the engine stopped.
#[cfg(windows)]
fn start_wsl_engine_and_wait(
    data_dir: &Path,
    engine: &crate::docker_engine::PinnedDockerEngine,
) -> Result<(), String> {
    if crate::docker_engine::probe_docker_host_reachable(&engine.docker_host) {
        forget_docker_access_check();
        return Ok(());
    }
    start_wsl_keepalive(data_dir, true)?;
    let deadline = Instant::now() + WSL_ENGINE_START_TIMEOUT;
    loop {
        if crate::docker_engine::probe_docker_host_reachable(&engine.docker_host) {
            forget_docker_access_check();
            let _ = append_desktop_log_for(data_dir, "wsl.engine", "Docker in WSL answers again.");
            record_update_listener_host(data_dir);
            return Ok(());
        }
        if let Some(KeepaliveState::Exited(code)) = lock_recovering(&WSL_KEEPALIVE).state() {
            let ended = code.map_or_else(
                || "wsl.exe ended".to_string(),
                |code| format!("wsl.exe ended with exit code {code}"),
            );
            return Err(format!(
                "The engine's WSL distro stopped again right away ({ended})."
            ));
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "WSL is running, but Docker inside it didn't answer within {} seconds.",
                WSL_ENGINE_START_TIMEOUT.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// For a Hub start: when the Hub runs on the WSL engine and Docker doesn't answer, start the
/// engine and wait for it. `Ok` when there was nothing to do too.
#[cfg(windows)]
pub(crate) fn wake_wsl_engine_for_start(data_dir: &Path) -> Result<(), String> {
    let Some(engine) = hub_docker_engine(data_dir)
        .filter(|engine| engine.kind == crate::docker_engine::DockerEngineKind::WslEngine)
    else {
        return Ok(());
    };
    if crate::docker_engine::probe_docker_host_reachable(&engine.docker_host) {
        return Ok(());
    }
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Docker in WSL doesn't answer, so the app is starting it before the Hub.",
    );
    start_wsl_engine_and_wait(data_dir, &engine)
}

/// Start engine on the startup screens: start the WSL engine and wait until Docker answers.
pub fn start_wsl_engine(data_dir: &Path) -> Result<String, String> {
    #[cfg(windows)]
    {
        let engine = hub_docker_engine(data_dir)
            .filter(|engine| engine.kind == crate::docker_engine::DockerEngineKind::WslEngine)
            .ok_or_else(|| "This Hub doesn't run on the Docker engine inside WSL.".to_string())?;
        start_wsl_engine_and_wait(data_dir, &engine).map_err(|error| {
            let _ =
                append_desktop_log_for(data_dir, "wsl.engine", &format!("Start engine: {error}"));
            error
        })?;
        Ok("Docker in WSL is running.".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
        Err("Only a Windows Hub runs on the Docker engine inside WSL.".to_string())
    }
}

/// Whether Docker answers for the auto-start at launch. A Hub on the WSL engine whose engine
/// stopped gets it started first, and waited for.
pub fn docker_available_for_launch(data_dir: &Path) -> bool {
    if is_docker_available() {
        return true;
    }
    #[cfg(windows)]
    match wake_wsl_engine_for_start(data_dir) {
        Ok(()) => return is_docker_available(),
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                "setup",
                &format!("The Docker engine in WSL didn't start: {error}"),
            );
        }
    }
    let _ = data_dir;
    false
}

// ─── Where the Hub reaches the update listener ────────────────────────────────
//
// The Hub calls the desktop app's update listener (port 17400) at host.docker.internal. On the
// WSL engine that name is the WSL VM, where nothing listens on that port, while the listener runs
// on Windows. The distro's default gateway is the Windows host's address on the WSL adapter, and
// the Hub's container reaches it through the VM, so the app records that address for the Hub.

/// The file in `state/` the Hub reads the listener's address from (`UPDATE_LISTENER_HOST_FILENAME`
/// in the backend's `common/constants.ts`).
#[cfg(any(test, windows))]
pub(crate) const UPDATE_LISTENER_HOST_FILENAME: &str = "update-listener.host";

/// The default route's gateway in a `/proc/net/route` table. The table prints addresses as hex in
/// host byte order, little-endian on the x86 and arm64 machines WSL runs on.
#[cfg(any(test, windows))]
pub(crate) fn default_gateway_from_route_table(table: &str) -> Option<std::net::Ipv4Addr> {
    table.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (destination, gateway, mask) = (fields.get(1)?, fields.get(2)?, fields.get(7)?);
        if *destination != "00000000" || *mask != "00000000" {
            return None;
        }
        let gateway = u32::from_str_radix(gateway, 16)
            .ok()
            .filter(|gateway| *gateway != 0)?;
        Some(std::net::Ipv4Addr::from(gateway.to_le_bytes()))
    })
}

/// Whether `address` is one of this computer's own addresses: a socket binds to it only then.
/// With WSL's mirrored networking the distro's default gateway is the router, and the Hub must not
/// send the listener token there.
#[cfg(any(test, windows))]
pub(crate) fn is_own_address(address: std::net::Ipv4Addr) -> bool {
    std::net::TcpListener::bind((address, 0)).is_ok()
}

/// Writes the listener address for the Hub to read, or removes the file for `None`, and says
/// whether that changed anything. Written whole through a temporary file, so the Hub never reads
/// half of it.
#[cfg(any(test, windows))]
pub(crate) fn write_update_listener_host(
    data_dir: &Path,
    address: Option<std::net::Ipv4Addr>,
) -> Result<bool, String> {
    use std::io::Write as _;

    let state_dir = data_dir.join("state");
    let path = state_dir.join(UPDATE_LISTENER_HOST_FILENAME);
    let wanted = address.map(|address| format!("{address}\n"));
    if std::fs::read_to_string(&path).ok() == wanted {
        return Ok(false);
    }
    let Some(content) = wanted else {
        return std::fs::remove_file(&path)
            .map(|()| true)
            .map_err(|error| format!("Couldn't remove {}: {error}", path.display()));
    };
    std::fs::create_dir_all(&state_dir)
        .map_err(|error| format!("Couldn't create {}: {error}", state_dir.display()))?;
    let mut file = tempfile::Builder::new()
        .prefix(".update-listener.host.")
        .tempfile_in(&state_dir)
        .map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
    file.write_all(content.as_bytes())
        .map_err(|error| format!("Couldn't write {}: {error}", path.display()))?;
    file.persist(&path)
        .map_err(|error| format!("Couldn't write {}: {}", path.display(), error.error))?;
    Ok(true)
}

/// Records where the Hub reaches the update listener from inside its container: the Windows host's
/// address on the WSL adapter on the WSL engine, and nothing (so host.docker.internal) on any
/// other. Called only while Docker answers, so asking the distro never starts WSL.
pub fn record_update_listener_host(data_dir: &Path) {
    #[cfg(windows)]
    {
        let on_wsl_engine = hub_docker_engine(data_dir)
            .is_some_and(|engine| engine.kind == crate::docker_engine::DockerEngineKind::WslEngine);
        let address = if on_wsl_engine {
            let Some(table) = find_wsl_distro()
                .and_then(|distro| run_wsl_root_script_capture(&distro, "cat /proc/net/route"))
            else {
                // The distro didn't answer this time: keep what an earlier start recorded.
                return;
            };
            default_gateway_from_route_table(&table).filter(|address| is_own_address(*address))
        } else {
            None
        };
        let message = match write_update_listener_host(data_dir, address) {
            Ok(false) => return,
            Ok(true) => match address {
                Some(address) => format!(
                    "The Hub reaches the update listener at {address}, this PC's address on the WSL adapter."
                ),
                None => "The Hub reaches the update listener at host.docker.internal.".to_string(),
            },
            Err(error) => error,
        };
        let _ = append_desktop_log_for(data_dir, "updater.listener", &message);
    }
    #[cfg(not(windows))]
    let _ = data_dir;
}
