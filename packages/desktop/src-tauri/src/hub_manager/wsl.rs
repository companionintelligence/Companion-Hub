//! WSL2 Docker Engine backend: distro discovery, keeping the engine running, GPU runtime and
//! Ollama reachability. The files the app keeps for this engine are in `wsl_engine_files`.

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
///
/// The Hub's own engine decides first: a Hub on the WSL engine is on it whatever the Docker CLI's
/// context says. Docker Desktop sets that context back to `desktop-linux` when it starts, and the
/// app moves a Hub whose saved engine stopped answering to the WSL engine without touching it. Seen
/// on Windows: the Hub ran on the WSL engine with the context on `desktop-linux`, and this said
/// no, so Install Ollama would have put it on Windows, out of the Hub's reach, and the GPU runtime
/// and Ollama setup in the distro would be skipped. Not the other way round: Start Docker in WSL
/// and the TLS move rely on the context while the Hub is still saved on Docker Desktop.
#[cfg(windows)]
pub(crate) fn is_wsl_engine_docker_backend() -> bool {
    wsl_engine_backend_from(
        hub_docker_engine(&get_hub_data_dir()).map(|engine| engine.kind),
        current_docker_context_name(None).as_deref(),
        docker_server_os_and_kernel,
    )
}

/// [`is_wsl_engine_docker_backend`]'s answer from what it reads: the Hub's engine, the Docker CLI's
/// current context, and the daemon's own OS and kernel (asked only when the first two don't say).
#[cfg(any(test, windows))]
pub(crate) fn wsl_engine_backend_from(
    hub_engine: Option<crate::docker_engine::DockerEngineKind>,
    cli_context: Option<&str>,
    server_os_and_kernel: impl FnOnce() -> Option<(String, String)>,
) -> bool {
    if hub_engine == Some(crate::docker_engine::DockerEngineKind::WslEngine) {
        return true;
    }
    match cli_context {
        Some(crate::docker_engine::DOCKER_CONTEXT_WSL_ENGINE) => return true,
        Some("desktop-linux" | "desktop-windows") => return false,
        _ => {}
    }
    if let Some((os, kernel)) = server_os_and_kernel() {
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
    let listing = wsl_distro_listing()?;
    let distro = wsl_listing_names(&listing)
        .filter(|line| !line.is_empty())
        .find(|d| {
            let lower = d.to_ascii_lowercase();
            !lower.starts_with("docker-desktop")
                && (lower == "ubuntu"
                    || lower.starts_with("ubuntu-")
                    || lower == "debian"
                    || lower.starts_with("debian-"))
        })
        .map(str::to_string);
    distro
}

/// `wsl -l -q` as UTF-8, or `None` when it fails. Listing distros doesn't start WSL.
#[cfg(windows)]
fn wsl_distro_listing() -> Option<String> {
    let mut command = Command::new("wsl.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    command.env("WSL_UTF8", "1");
    let output = command.args(["-l", "-q"]).output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The distro names in a `wsl -l -q` listing, trimmed of spaces and of NULs at either end.
#[cfg(any(test, windows))]
fn wsl_listing_names(listing: &str) -> impl Iterator<Item = &str> {
    listing
        .lines()
        .map(|line| line.trim().trim_matches('\u{0}').trim())
}

/// Run a shell script as root inside a WSL2 distro (`wsl -d <distro> -u root -e sh -lc`).
/// Returns whether it exited 0. Shared by the GPU and Ollama in-distro setup steps.
#[cfg(windows)]
pub(crate) fn run_wsl_root_script(distro: &str, script: &str) -> bool {
    run_wsl_root_script_capture(distro, script).is_some()
}

/// Like `run_wsl_root_script` but returns the trimmed stdout on success (`None` on
/// failure), so callers can branch on a marker the script echoes.
#[cfg(windows)]
pub(crate) fn run_wsl_root_script_capture(distro: &str, script: &str) -> Option<String> {
    run_wsl_root_script_output(distro, script).ok()
}

/// Runs `script` as root in `distro` and returns its trimmed stdout, or why it failed: the exit code
/// and the end of stderr.
///
/// `-e` matters. After `--`, wsl.exe hands the rest of its command line to the distro's shell to
/// parse again, so a script's `$dir` became empty and its quotes were eaten before `sh` saw it (the
/// TLS script died with "mkdir: cannot create directory ''"). With `-e`, wsl.exe execs `sh` with the
/// arguments as Windows splits them, and Rust quotes them by those same rules, so the script arrives
/// byte for byte. Stdin stays free, so an `apt-get` in the script can't read the rest of it.
/// WSL_UTF8 keeps wsl.exe output UTF-8; CREATE_NO_WINDOW suppresses a console flash.
#[cfg(windows)]
pub(crate) fn run_wsl_root_script_output(distro: &str, script: &str) -> Result<String, String> {
    let mut command = Command::new("wsl.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    command.env("WSL_UTF8", "1");
    command.args(["-d", distro, "-u", "root", "-e", "sh", "-lc", script]);
    let output = command
        .output()
        .map_err(|error| format!("Couldn't run wsl.exe: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    Err(wsl_script_failure(
        output.status.code(),
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    ))
}

/// The last `max` characters of `text`, trimmed.
#[cfg(any(test, windows))]
fn text_tail(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.trim().chars().collect();
    chars[chars.len().saturating_sub(max)..].iter().collect()
}

/// Why a script run in WSL failed: its exit code and the ends of its stderr and stdout, which say
/// what failed (a long apt or openssl transcript before them is mostly noise). Stdout too, since
/// some scripts report their error there: Ollama's install.sh printed "This version requires zstd"
/// on stdout, and its stderr ended at the step before.
#[cfg(any(test, windows))]
pub(crate) fn wsl_script_failure(code: Option<i32>, stdout: &str, stderr: &str) -> String {
    let code = code.map_or_else(
        || "It ended without an exit code.".to_string(),
        |code| format!("It exited with code {code}."),
    );
    let stderr = text_tail(stderr, 600);
    let stdout = text_tail(stdout, 300);
    let mut message = if stderr.is_empty() {
        format!("{code} It printed nothing on stderr.")
    } else {
        format!("{code} stderr: {stderr}")
    };
    if !stdout.is_empty() {
        message.push_str(&format!(" stdout ends: {stdout}"));
    }
    message
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
    // database bootstrap (start_database_first) — reach over tcp://127.0.0.1:2376 (TLS).
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
#[cfg(any(windows, test))]
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
/// The root script [`ensure_ollama_listens_on_all_interfaces`] runs in the distro. With `guard`
/// false (the person turned the network guard off) it leaves the guard alone.
#[cfg(any(windows, test))]
pub(crate) fn wsl_ollama_bind_script(guard: bool) -> String {
    let guard_body = if guard {
        format!(
            "  ( set -e\n{}) 1>&2 || echo \"warning: could not keep Ollama off the network\" >&2\n",
            super::inference_guard_install_script()
        )
    } else {
        "  : # the network guard is off by the person's choice\n".to_string()
    };
    format!(
        r#"set -e
# Only configure a real ollama systemd service; installing Ollama is a separate step.
systemctl cat ollama >/dev/null 2>&1 || {{ echo no-service; exit 0; }}
# Keep Ollama off the network where our drop-in put it on every interface (see
# inference_guard.rs). Not for a bind the user chose. Its output goes to stderr, so the
# marker stays the last line on stdout; a failure leaves Ollama reachable as before.
guard() {{
{guard_body}}}
# Already reachable from containers (bound to a wildcard address)? — checks the live
# listener, so a prior failed restart (still on loopback) is retried below.
if ss -ltn 2>/dev/null | grep -qE '(\*|0\.0\.0\.0|\[::\]):11434'; then
  [ -f {path} ] && guard
  echo already; exit 0
fi
# Respect a deliberate OLLAMA_HOST the user set outside our own drop-in.
if [ ! -f {path} ] && systemctl show ollama -p Environment 2>/dev/null | grep -q 'OLLAMA_HOST='; then
  echo user-configured; exit 0
fi
mkdir -p /etc/systemd/system/ollama.service.d
printf '[Service]\nEnvironment="OLLAMA_HOST=0.0.0.0:11434"\n' > {path}
systemctl daemon-reload
systemctl restart ollama
guard
echo configured"#,
        path = OLLAMA_HOST_DROPIN_PATH,
    )
}

#[cfg(windows)]
pub(crate) fn ensure_ollama_listens_on_all_interfaces(distro: &str) -> Option<String> {
    let guard = !super::local_ai_guard_disabled(&get_hub_data_dir());
    let output = run_wsl_root_script_capture(distro, &wsl_ollama_bind_script(guard))?;
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

/// How many keepalives one start asks for. The keepalive it finds running can be one that
/// `wsl --terminate` just ended (wsl.exe takes a moment to exit), so a keepalive that ends while
/// it waits is replaced. Only one that keeps ending means WSL can't run the distro.
#[cfg(any(test, windows))]
const WSL_ENGINE_START_ATTEMPTS: u32 = 3;

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

/// The distro the WSL engine installer set Docker up in, from a `wsl -l -q` listing: the first
/// `Ubuntu` or `Ubuntu-*`, ignoring case, by the installer's own rule (`wsl2_engine_user_script`).
/// `find_wsl_distro` also takes a Debian listed first, which would be the wrong distro to start.
#[cfg(any(test, windows))]
pub(crate) fn engine_distro_from_listing(listing: &str) -> Option<String> {
    wsl_listing_names(listing)
        .find(|name| {
            let lower = name.to_ascii_lowercase();
            lower == "ubuntu" || lower.starts_with("ubuntu-")
        })
        .map(str::to_string)
}

/// The WSL engine's distro on this computer. Listing distros doesn't start WSL. Remembered once
/// found; a listing that fails is asked again next time.
#[cfg(windows)]
pub(crate) fn wsl_engine_distro() -> Option<String> {
    static FOUND: Mutex<Option<String>> = Mutex::new(None);
    let mut found = lock_recovering(&FOUND);
    if found.is_none() {
        *found = wsl_distro_listing().and_then(|listing| engine_distro_from_listing(&listing));
    }
    found.clone()
}

/// The engine the Hub runs on, when that is the Docker engine inside WSL.
#[cfg(windows)]
pub(crate) fn hub_wsl_engine(data_dir: &Path) -> Option<crate::docker_engine::PinnedDockerEngine> {
    hub_docker_engine(data_dir)
        .filter(|engine| engine.kind == crate::docker_engine::DockerEngineKind::WslEngine)
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
        let distro = wsl_engine_distro()
            .ok_or_else(|| "No Ubuntu WSL distro was found for the Docker engine.".to_string())?;
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
        // The distro boots again, and its gateway (the listener's address) can change with it.
        UPDATE_LISTENER_HOST_STALE.store(true, Ordering::SeqCst);
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
/// The status polls call this, so it never waits: they see Docker once it answers. Finding the
/// distro runs wsl.exe, which can hang while WSL itself starts or updates, so the start happens on
/// a thread of its own, one at a time. A failure is left to Start engine to report, rather than
/// logged every 30 seconds.
#[cfg(windows)]
pub(crate) fn revive_wsl_engine(data_dir: &Path) {
    static REVIVING: AtomicBool = AtomicBool::new(false);
    // No hypervisor, no distro to start: wsl.exe would fail at once, every poll.
    if !wsl_engine_should_revive(
        hub_docker_engine(data_dir).as_ref(),
        is_user_stopped(data_dir),
    ) || !hypervisor_running()
        || REVIVING.swap(true, Ordering::SeqCst)
    {
        return;
    }
    let data_dir = data_dir.to_path_buf();
    let spawned = std::thread::Builder::new()
        .name("wsl-engine-revive".to_string())
        .spawn(move || {
            let _ = start_wsl_keepalive(&data_dir, false);
            REVIVING.store(false, Ordering::SeqCst);
        });
    if spawned.is_err() {
        REVIVING.store(false, Ordering::SeqCst);
    }
}

/// Why the WSL engine can't start, when Windows' hypervisor isn't running: from whether the
/// processor reports virtualization on in the firmware (`None` when Windows couldn't say).
#[cfg(any(test, windows))]
pub(crate) fn wsl_cannot_start_reason(firmware_virtualization: Option<bool>) -> String {
    const FIRMWARE: &str = "virtualization is turned off in this PC's firmware (BIOS or UEFI settings). Turn on the setting called Virtualization Technology, VT-x or SVM there, restart, then try again.";
    const FEATURE: &str = "Turn on Virtual Machine Platform: run wsl.exe --install --no-distribution as administrator, then restart Windows.";
    match firmware_virtualization {
        Some(false) => format!("WSL can't start because {FIRMWARE}"),
        Some(true) => format!("WSL can't start because Windows' hypervisor isn't running. {FEATURE}"),
        None => format!(
            "WSL can't start because Windows' hypervisor isn't running. Either {FIRMWARE} Or: {FEATURE}"
        ),
    }
}

/// `VirtualizationFirmwareEnabled` for the processors, from Windows. Read while no hypervisor runs,
/// which is when Windows reports it (with one running, it reads as off). A PowerShell call, so only
/// on the way to a failure.
#[cfg(windows)]
fn firmware_virtualization_enabled() -> Option<bool> {
    let mut command = Command::new("powershell.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "(Get-CimInstance Win32_Processor).VirtualizationFirmwareEnabled",
        ])
        .output()
        .ok()
        .filter(|output| output.status.success())?;
    let text = String::from_utf8_lossy(&output.stdout);
    let answers: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    (!answers.is_empty()).then(|| {
        answers
            .iter()
            .any(|answer| answer.eq_ignore_ascii_case("True"))
    })
}

/// Why the WSL engine can't start right now, or `None` when Windows' hypervisor runs. A Hub on the
/// WSL engine whose PC lost virtualization (turned off in the BIOS, or reset by a BIOS update)
/// waited 90 seconds at every launch, Hub start and Start engine for an engine that couldn't
/// start, and was told only that Docker didn't answer. Cheap when it runs (one CPU instruction).
#[cfg(windows)]
pub(crate) fn wsl_engine_cannot_start() -> Option<String> {
    if hypervisor_running() {
        return None;
    }
    Some(wsl_cannot_start_reason(firmware_virtualization_enabled()))
}

/// [`wsl_engine_cannot_start`] for the startup screen's polls, for a Hub on the WSL engine only,
/// and remembered for 30 seconds: on the failing path it runs PowerShell, and the screen asks every
/// few seconds.
pub fn wsl_engine_cannot_start_for_screen(data_dir: &Path) -> Option<String> {
    #[cfg(windows)]
    {
        hub_wsl_engine(data_dir)?;
        static LAST: Mutex<Option<(Instant, Option<String>)>> = Mutex::new(None);
        let mut last = lock_recovering(&LAST);
        if let Some((asked_at, why)) = last.as_ref() {
            if asked_at.elapsed() < Duration::from_secs(30) {
                return why.clone();
            }
        }
        let why = wsl_engine_cannot_start();
        *last = Some((Instant::now(), why.clone()));
        why
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
        None
    }
}

/// How a start that waits for Docker in WSL ended.
#[cfg(any(test, windows))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EngineWait {
    Answered,
    /// Every keepalive ended, the last one with this exit code.
    KeepaliveEnded(Option<i32>),
    TimedOut,
}

/// Starts a keepalive and waits until `probe` says Docker answers, with `pause` between polls,
/// until `expired`. A keepalive that ends while it waits is started again, up to
/// [`WSL_ENGINE_START_ATTEMPTS`] in all.
#[cfg(any(test, windows))]
pub(crate) fn wait_for_wsl_engine(
    mut probe: impl FnMut() -> bool,
    mut start_keepalive: impl FnMut() -> Result<KeepaliveStart, String>,
    mut keepalive_state: impl FnMut() -> Option<KeepaliveState>,
    mut expired: impl FnMut() -> bool,
    mut pause: impl FnMut(),
) -> Result<EngineWait, String> {
    start_keepalive()?;
    let mut attempts = 1;
    loop {
        if probe() {
            return Ok(EngineWait::Answered);
        }
        if let Some(KeepaliveState::Exited(code)) = keepalive_state() {
            if attempts >= WSL_ENGINE_START_ATTEMPTS {
                return Ok(EngineWait::KeepaliveEnded(code));
            }
            start_keepalive()?;
            attempts += 1;
        }
        if expired() {
            return Ok(EngineWait::TimedOut);
        }
        pause();
    }
}

/// Start the WSL engine now and wait until Docker answers, for Start engine and for a Hub start
/// that finds the engine stopped.
#[cfg(windows)]
fn start_wsl_engine_and_wait(
    data_dir: &Path,
    engine: &crate::docker_engine::PinnedDockerEngine,
) -> Result<(), String> {
    let probe = || crate::docker_engine::probe_docker_host_reachable(&engine.docker_host);
    if probe() {
        forget_docker_access_check();
        return Ok(());
    }
    if let Some(why) = wsl_engine_cannot_start() {
        return Err(why);
    }
    let deadline = Instant::now() + WSL_ENGINE_START_TIMEOUT;
    let outcome = wait_for_wsl_engine(
        probe,
        || start_wsl_keepalive(data_dir, true),
        || lock_recovering(&WSL_KEEPALIVE).state(),
        || Instant::now() >= deadline,
        || std::thread::sleep(Duration::from_secs(1)),
    )?;
    match outcome {
        EngineWait::Answered => {
            forget_docker_access_check();
            let _ = append_desktop_log_for(data_dir, "wsl.engine", "Docker in WSL answers again.");
            Ok(())
        }
        EngineWait::KeepaliveEnded(code) => {
            let ended = code.map_or_else(
                || "wsl.exe ended".to_string(),
                |code| format!("wsl.exe ended with exit code {code}"),
            );
            Err(format!(
                "The engine's WSL distro stopped again right away ({ended})."
            ))
        }
        EngineWait::TimedOut => Err(format!(
            "WSL is running, but Docker inside it didn't answer within {} seconds.",
            WSL_ENGINE_START_TIMEOUT.as_secs()
        )),
    }
}

/// The WSL engine a start or launch wakes: the one the Hub is pinned to or saved, or else, while the
/// Docker CLI's current context is the WSL engine's, that engine at its TLS listener. The second is
/// a Hub whose saved engine is still Docker Desktop on a machine now pointed at the WSL engine, as
/// an engine install that stopped after Docker came up leaves it: nothing woke that engine, so
/// nothing answered, so no start ran to finish its move to TLS.
#[cfg(windows)]
fn wsl_engine_to_wake(data_dir: &Path) -> Option<crate::docker_engine::PinnedDockerEngine> {
    hub_wsl_engine(data_dir).or_else(|| {
        let context = crate::docker_engine::current_docker_context_name(None)?;
        (context == DOCKER_CONTEXT_WSL_ENGINE).then(|| crate::docker_engine::PinnedDockerEngine {
            docker_host: crate::docker_engine::WSL_ENGINE_TLS_HOST.to_string(),
            kind: crate::docker_engine::DockerEngineKind::WslEngine,
            context_name: Some(context),
            reason: "the Docker CLI's current context is the WSL engine".to_string(),
            selected_at: 0,
            path_style: Some("wsl-mnt".to_string()),
        })
    })
}

/// For a Hub start: when the Hub runs on the WSL engine and Docker doesn't answer, start the
/// engine and wait for it. `Ok` when there was nothing to do too.
#[cfg(windows)]
pub(crate) fn wake_wsl_engine_for_start(data_dir: &Path) -> Result<(), String> {
    let Some(engine) = wsl_engine_to_wake(data_dir) else {
        return Ok(());
    };
    if crate::docker_engine::probe_docker_host_reachable(&engine.docker_host) {
        // It may have come up seconds after a status poll cached "not running", which the start
        // (or the launch, asking again) would otherwise still read.
        forget_docker_access_check();
        return Ok(());
    }
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Docker in WSL doesn't answer, so the app is starting it before the Hub.",
    );
    start_wsl_engine_and_wait(data_dir, &engine)
}

/// Start Docker in WSL for a Hub still saved on another engine (Docker Desktop, stopped), when an
/// earlier install set the WSL engine up: points the Docker CLI's context at it, then moves it to
/// TLS if it isn't (which starts the distro, and needs the context first: it acts only for a WSL
/// engine Hub or context). Returns the engine to wake.
#[cfg(windows)]
fn choose_set_up_wsl_engine(
    data_dir: &Path,
) -> Result<crate::docker_engine::PinnedDockerEngine, String> {
    if !wsl_engine_set_up() {
        return Err(
            "This Hub doesn't run on the Docker engine inside WSL, and none is set up on this PC."
                .to_string(),
        );
    }
    let cert_dir = crate::docker_engine::wsl_engine_client_cert_dir().ok_or_else(|| {
        "There is no user profile with the WSL engine's client certificate.".to_string()
    })?;
    point_wsl_engine_context_at_tls(&cert_dir)?;
    let output = docker_command()
        .env_remove("DOCKER_HOST")
        .args(["context", "use", DOCKER_CONTEXT_WSL_ENGINE])
        .output()
        .map_err(|error| format!("Couldn't run docker context use: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "docker context use {DOCKER_CONTEXT_WSL_ENGINE} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let _ = append_desktop_log_for(
        data_dir,
        "wsl.engine",
        "Start Docker in WSL: the Docker CLI uses the WSL engine this PC has set up again.",
    );
    // Keepalive first. The TLS check boots the distro to run its script, and WSL stops a distro
    // nothing holds open a few seconds after: seen on Windows, the Hub came up on it, the distro
    // stopped nine seconds later, and the wait below had to start it again, restarting the Hub.
    start_wsl_keepalive(data_dir, true)?;
    ensure_wsl_engine_tls(data_dir)?;
    wsl_engine_to_wake(data_dir)
        .ok_or_else(|| "The Docker CLI didn't switch to the WSL engine.".to_string())
}

/// Start engine on the startup screens: start the WSL engine and wait until Docker answers. For a
/// Hub saved on another engine, the WSL engine this PC has set up (Start Docker in WSL).
pub fn start_wsl_engine(data_dir: &Path) -> Result<String, String> {
    #[cfg(windows)]
    {
        let engine = match hub_wsl_engine(data_dir) {
            Some(engine) => engine,
            None => choose_set_up_wsl_engine(data_dir).map_err(|error| {
                let _ = append_desktop_log_for(
                    data_dir,
                    "wsl.engine",
                    &format!("Start Docker in WSL: {error}"),
                );
                error
            })?,
        };
        start_wsl_engine_and_wait(data_dir, &engine).map_err(|error| {
            let _ =
                append_desktop_log_for(data_dir, "wsl.engine", &format!("Start engine: {error}"));
            error
        })?;
        // A Hub start and the launch record it themselves; nothing else follows Start engine.
        record_update_listener_host(data_dir);
        Ok("Docker in WSL is running.".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
        Err("Only a Windows Hub runs on the Docker engine inside WSL.".to_string())
    }
}

/// Whether Docker answers for the auto-start at launch, asking `docker_answers`. When it doesn't,
/// `wake` starts a stopped WSL engine and waits for it, and Docker is asked again. Not while the
/// user has the Hub stopped: the launch won't start that Hub, and like the status polls it leaves
/// the engine as `wsl --shutdown` left it.
#[cfg(any(test, windows))]
pub(crate) fn docker_answers_for_launch(
    mut docker_answers: impl FnMut() -> bool,
    user_stopped: bool,
    wake: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    if docker_answers() {
        return Ok(true);
    }
    if user_stopped {
        return Ok(false);
    }
    wake()?;
    Ok(docker_answers())
}

/// [`ensure_wsl_engine_tls`] at launch. Not fatal here; a Hub start runs it again and reports it.
#[cfg(windows)]
fn secure_wsl_engine_at_launch(data_dir: &Path) {
    match ensure_wsl_engine_tls(data_dir) {
        Ok(()) => forget_docker_access_check(),
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                "setup",
                &format!("Couldn't secure the Docker engine in WSL: {error}"),
            );
        }
    }
}

/// Whether Docker answers for the auto-start at launch. A Hub on the WSL engine whose engine
/// stopped gets it started first, and waited for, unless the user stopped the Hub.
pub fn docker_available_for_launch(data_dir: &Path) -> bool {
    #[cfg(windows)]
    {
        // An engine an earlier build set up still answers anyone on plain TCP. Its Hub is running,
        // so this launch starts nothing, and only a start moved it to TLS: without this it stayed
        // open (the logon keepalive brings it back on 2375 after every reboot). Seen on Windows.
        // Even with the Hub stopped by the user, since the engine answers anyway.
        if wsl_engine_to_wake(data_dir).is_some()
            && crate::docker_engine::probe_docker_host_reachable(
                crate::docker_engine::WSL_ENGINE_LEGACY_HOST,
            )
        {
            secure_wsl_engine_at_launch(data_dir);
        }
        docker_answers_for_launch(is_docker_available, is_user_stopped(data_dir), || {
            // Before the wake: an engine left half moved to TLS answers on neither port, and the
            // Hub start that would finish the move (it runs this too) never runs while nothing
            // answers.
            secure_wsl_engine_at_launch(data_dir);
            wake_wsl_engine_for_start(data_dir)
        })
        .unwrap_or_else(|error| {
            let _ = append_desktop_log_for(
                data_dir,
                "setup",
                &format!("The Docker engine in WSL didn't start: {error}"),
            );
            false
        })
    }
    #[cfg(not(windows))]
    {
        let _ = data_dir;
        is_docker_available()
    }
}
