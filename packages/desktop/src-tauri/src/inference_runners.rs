//! Native inference-runner installation and startup.
//!
//! The Hub itself runs in Docker, but several useful inference servers must run
//! on the host (especially MLX/Metal servers).  Keep this orchestration in the
//! desktop shell so the web UI never shells out and so every runner gets an
//! independent, truthful result.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::hub_manager;

const RUNNER_STATE_DIR: &str = "state/inference-runners";
const RUNNER_INSTALL_DIR: &str = "runners";
const RUNNER_LOG_DIR: &str = "logs/inference";
const RUNNER_STATE_FILE: &str = "state/inference-runners.json";
const STARTUP_WAIT: Duration = Duration::from_secs(45);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const API_KEY_BYTES: usize = 32;
const MACOS_LAUNCH_AGENT_PREFIX: &str = "computer.ci.companion-hub.inference";
#[cfg(any(test, target_os = "linux"))]
const LINUX_SYSTEMD_SERVICE_PREFIX: &str = "computer.ci.companion-hub.inference";

const DSPARK_PORT: u16 = 8080;
const MTPLX_PORT: u16 = 8000;
// Keep vLLM separate from MTPLX. Both otherwise default to port 8000.
const VLLM_PORT: u16 = 8002;
const OLLAMA_PORT: u16 = 11434;
const LUCEBOX_PORT: u16 = 8000;

const DSPARK_ENDPOINT: &str = "http://host.docker.internal:8080";
const MTPLX_ENDPOINT: &str = "http://host.docker.internal:8000";
const VLLM_ENDPOINT: &str = "http://host.docker.internal:8002";
const OLLAMA_ENDPOINT: &str = "http://host.docker.internal:11434";
const LUCEBOX_ENDPOINT: &str = "http://host.docker.internal:8000";

const LUCEBOX_IMAGE_CUDA: &str = "ghcr.io/luce-org/lucebox-hub:cuda12";
const LUCEBOX_IMAGE_ROCM: &str = "ghcr.io/luce-org/lucebox-hub:rocm";
const LUCEBOX_CONTAINER_NAME: &str = "ci-hub-inference-lucebox";
const VLLM_METAL_INSTALL_URL: &str =
    "https://raw.githubusercontent.com/vllm-project/vllm-metal/main/install.sh";

/// The complete automatic setup set. The frontend sends this list explicitly,
/// but the native layer also has a safe default for future callers.
pub const DEFAULT_AUTOMATIC_RUNNERS: &[&str] = &["ollama", "omlx", "vllm"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InferenceRunnerState {
    AlreadyRunning,
    InstalledAndStarted,
    Installed,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InferenceRunnerResult {
    pub runner: String,
    pub state: InferenceRunnerState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Normalize the user-facing typo and legacy aliases without exposing the
/// internal container runner name in UI copy.
pub fn canonical_runner_name(name: &str) -> Option<&'static str> {
    match name.trim().to_ascii_lowercase().as_str() {
        "omlx" => Some("omlx"),
        "vllm" => Some("vllm"),
        "ollama" => Some("ollama"),
        _ => None,
    }
}

pub fn automatic_runner_names(requested: &[String]) -> Vec<String> {
    let source = if requested.is_empty() {
        DEFAULT_AUTOMATIC_RUNNERS
            .iter()
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>()
    } else {
        requested.to_vec()
    };

    let mut seen = HashSet::new();
    source
        .iter()
        .filter_map(|name| canonical_runner_name(name))
        .filter(|name| seen.insert(*name))
        .map(ToString::to_string)
        .collect()
}

/// Install and start every requested runner independently.
///
/// A failed or unsupported runner never prevents the remaining runners from
/// being attempted. This matters on mixed fleets: MLX runners belong on Apple
/// Silicon, while the container GPU runner belongs on Linux/Windows GPU hosts.
pub fn install_and_start_inference_runners(
    data_dir: &Path,
    requested: &[String],
) -> Vec<InferenceRunnerResult> {
    let runners = automatic_runner_names(requested);
    let mut results = Vec::with_capacity(runners.len());

    reconcile_macos_launch_agents(data_dir, &runners);
    reconcile_linux_systemd_services(data_dir, &runners);

    for runner in runners {
        let result = run_runner(data_dir, &runner);
        append_runner_log(
            data_dir,
            &runner,
            &format!(
                "completed state={:?} detail={:?}",
                result.state, result.detail
            ),
        );
        results.push(result);
        persist_results(data_dir, &results);
    }

    results
}

fn run_runner(data_dir: &Path, runner: &str) -> InferenceRunnerResult {
    match runner {
        "omlx" => install_and_start_omlx(data_dir),
        "vllm" => install_and_start_vllm(data_dir),
        "ollama" => install_and_start_ollama(data_dir),
        _ => failed(runner, "Unknown inference runner.".to_string()),
    }
}

fn already_running(runner: &str, endpoint: &str) -> InferenceRunnerResult {
    success(
        runner,
        InferenceRunnerState::AlreadyRunning,
        Some(endpoint.to_string()),
        Some("The runner is already reachable.".to_string()),
    )
}

fn success(
    runner: &str,
    state: InferenceRunnerState,
    endpoint_url: Option<String>,
    detail: Option<String>,
) -> InferenceRunnerResult {
    InferenceRunnerResult {
        runner: runner.to_string(),
        state,
        endpoint_url,
        detail,
    }
}

fn failed(runner: &str, detail: String) -> InferenceRunnerResult {
    success(runner, InferenceRunnerState::Failed, None, Some(detail))
}

fn skipped(runner: &str, detail: impl Into<String>) -> InferenceRunnerResult {
    success(
        runner,
        InferenceRunnerState::Skipped,
        None,
        Some(detail.into()),
    )
}

fn platform_is_apple_silicon() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
}

const OMLX_PORT: u16 = 8000;
const OMLX_ENDPOINT: &str = "http://host.docker.internal:8000";

fn install_and_start_omlx(data_dir: &Path) -> InferenceRunnerResult {
    if !platform_is_apple_silicon() {
        return skipped("omlx", "oMLX runs only on Apple Silicon.");
    }
    if probe_http(OMLX_PORT, "/v1/models") {
        return already_running("omlx", OMLX_ENDPOINT);
    }
    append_runner_log(
        data_dir,
        "omlx",
        "Installing oMLX with Homebrew: brew tap jundot/omlx && brew install jundot/omlx/omlx && omlx start",
    );
    let status = Command::new("brew")
        .args(["tap", "jundot/omlx", "https://github.com/jundot/omlx"])
        .status();
    if status.map(|code| !code.success()).unwrap_or(true) {
        return failed("omlx", "brew tap jundot/omlx failed.".to_string());
    }
    let install = Command::new("brew")
        .args(["install", "jundot/omlx/omlx"])
        .status();
    if install.map(|code| !code.success()).unwrap_or(true) {
        return failed(
            "omlx",
            "brew install jundot/omlx/omlx failed. See https://github.com/jundot/omlx.".to_string(),
        );
    }
    let _ = Command::new("omlx").arg("start").status();
    if wait_for_http(OMLX_PORT, "/v1/models", STARTUP_WAIT) {
        success(
            "omlx",
            InferenceRunnerState::InstalledAndStarted,
            Some(OMLX_ENDPOINT.to_string()),
            Some("oMLX was installed and started.".to_string()),
        )
    } else {
        success(
            "omlx",
            InferenceRunnerState::Installed,
            Some(OMLX_ENDPOINT.to_string()),
            Some("oMLX was installed; its API is still starting. Foreground form: omlx serve --model-dir ~/models".to_string()),
        )
    }
}

#[allow(dead_code)]
fn install_and_start_dspark(data_dir: &Path) -> InferenceRunnerResult {
    if !platform_is_apple_silicon() {
        return skipped(
            "dspark",
            "This native Metal runner is supported only on Apple Silicon.",
        );
    }

    if probe_http(DSPARK_PORT, "/health") {
        return already_running("dspark", DSPARK_ENDPOINT);
    }

    let executable = match ensure_python_cli(data_dir, "dspark", "mlx-dspark", "mlx-dspark", 10) {
        Ok(path) => path,
        Err(error) => return failed("dspark", error),
    };
    let api_key = match ensure_runner_api_key(data_dir, "dspark") {
        Ok(key) => key,
        Err(error) => return failed("dspark", error),
    };

    // Keep this command exact: --no-model is the managed-server mode that lets
    // the Hub load and swap models through mlx-dspark's common HTTP API.
    let args = vec![
        "serve".to_string(),
        "--no-model".to_string(),
        "--host".to_string(),
        "0.0.0.0".to_string(),
        "--port".to_string(),
        DSPARK_PORT.to_string(),
        "--api-key".to_string(),
        api_key.clone(),
    ];
    start_host_process(
        data_dir,
        "dspark",
        &executable,
        &args,
        DSPARK_PORT,
        "/health",
        DSPARK_ENDPOINT,
        Some(&api_key),
    )
}

#[allow(dead_code)]
fn install_and_start_mtplx(data_dir: &Path) -> InferenceRunnerResult {
    if !platform_is_apple_silicon() {
        return skipped(
            "mtplx",
            "This native MLX runner is supported only on Apple Silicon.",
        );
    }

    // MTPLX may have moved off 8000 when another service occupied the
    // preferred port on its first run. Reuse the persisted endpoint before
    // allocating another port, otherwise every FTUE retry can launch a second
    // MTPLX process on a new port.
    let existing_api_key = read_runner_api_key(data_dir, "mtplx");
    if let Some(endpoint) = persisted_runner_endpoint(data_dir, "mtplx") {
        if let Some(port) = endpoint_port(&endpoint) {
            if probe_http_authenticated(port, "/v1/models", existing_api_key.as_deref()) {
                return already_running("mtplx", &endpoint);
            }
        }
    }

    if probe_http_authenticated(MTPLX_PORT, "/v1/models", existing_api_key.as_deref()) {
        return already_running("mtplx", MTPLX_ENDPOINT);
    }

    let port = match available_host_port(MTPLX_PORT) {
        Some(port) => port,
        None => {
            return failed(
                "mtplx",
                "No local port was available for MTPLX.".to_string(),
            )
        }
    };
    let endpoint = host_endpoint(port);

    let executable = match ensure_python_cli(data_dir, "mtplx", "mtplx", "mtplx", 11) {
        Ok(path) => path,
        Err(error) => return failed("mtplx", error),
    };
    let api_key = match ensure_runner_api_key(data_dir, "mtplx") {
        Ok(key) => key,
        Err(error) => return failed("mtplx", error),
    };
    let api_key_path = runner_api_key_path(data_dir, "mtplx");
    let args = vec![
        "serve".to_string(),
        "--host".to_string(),
        "0.0.0.0".to_string(),
        "--port".to_string(),
        port.to_string(),
        "--api-key-file".to_string(),
        api_key_path.display().to_string(),
    ];
    start_host_process(
        data_dir,
        "mtplx",
        &executable,
        &args,
        port,
        "/v1/models",
        &endpoint,
        Some(&api_key),
    )
}

fn install_and_start_vllm(data_dir: &Path) -> InferenceRunnerResult {
    if cfg!(target_os = "windows") {
        return skipped(
            "vllm",
            "The native Windows path is not supported; use the WSL2/Linux GPU path.",
        );
    }

    if probe_http(VLLM_PORT, "/v1/models") {
        return already_running("vllm", VLLM_ENDPOINT);
    }

    let port = match available_host_port(VLLM_PORT) {
        Some(port) => port,
        None => return failed("vllm", "No local port was available for vLLM.".to_string()),
    };
    let endpoint = host_endpoint(port);

    if platform_is_apple_silicon() {
        return skipped("vllm", "Apple Silicon uses oMLX. vLLM is the NVIDIA path.");
    }

    let (executable, model, extra_args) = {
        if !nvidia_smi_works() {
            return skipped(
                "vllm",
                "Automatic Linux vLLM setup requires a working NVIDIA GPU.",
            );
        }
        let path = match ensure_python_cli(data_dir, "vllm", "vllm", "vllm", 10) {
            Ok(path) => path,
            Err(error) => return failed("vllm", error),
        };
        (
            path,
            "Qwen/Qwen3-4B-Instruct-2507".to_string(),
            Vec::<String>::new(),
        )
    };

    let mut args = vec![
        "serve".to_string(),
        model,
        "--host".to_string(),
        "0.0.0.0".to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    args.extend(extra_args);
    start_host_process(
        data_dir,
        "vllm",
        &executable,
        &args,
        port,
        "/v1/models",
        &endpoint,
        None,
    )
}

fn install_and_start_ollama(data_dir: &Path) -> InferenceRunnerResult {
    if probe_http(OLLAMA_PORT, "/api/tags") {
        return already_running("ollama", OLLAMA_ENDPOINT);
    }

    append_runner_log(
        data_dir,
        "ollama",
        "Ollama is not reachable; invoking the platform installer.",
    );
    if let Err(error) = hub_manager::install_ollama() {
        return failed("ollama", error);
    }

    if wait_for_http(OLLAMA_PORT, "/api/tags", STARTUP_WAIT) {
        success(
            "ollama",
            InferenceRunnerState::InstalledAndStarted,
            Some(OLLAMA_ENDPOINT.to_string()),
            Some("Ollama was installed and started.".to_string()),
        )
    } else {
        success(
            "ollama",
            InferenceRunnerState::Installed,
            Some(OLLAMA_ENDPOINT.to_string()),
            Some("Ollama was installed; its API is still starting.".to_string()),
        )
    }
}

#[allow(dead_code)]
fn install_and_start_lucebox(data_dir: &Path) -> InferenceRunnerResult {
    if cfg!(target_os = "macos") {
        return skipped(
            "lucebox",
            "Docker cannot pass Apple Silicon Metal through to this GPU runner.",
        );
    }

    if probe_http(LUCEBOX_PORT, "/health") || probe_http(LUCEBOX_PORT, "/v1/models") {
        return already_running("lucebox", LUCEBOX_ENDPOINT);
    }

    if !hub_manager::is_docker_available() {
        return skipped(
            "lucebox",
            "A working Docker engine is required for this GPU runner.",
        );
    }

    let existing = docker_container_exists(data_dir, LUCEBOX_CONTAINER_NAME);
    let port = if existing {
        // A stopped container retains the host port it was created with. The
        // managed container always uses the default port, so keep that mapping
        // when restarting it instead of probing a new port and waiting there.
        LUCEBOX_PORT
    } else {
        match available_host_port(LUCEBOX_PORT) {
            Some(port) => port,
            None => {
                return failed(
                    "lucebox",
                    "No local port was available for the GPU runner.".to_string(),
                )
            }
        }
    };
    let endpoint = host_endpoint(port);

    let image = if nvidia_smi_works() {
        LUCEBOX_IMAGE_CUDA
    } else if cfg!(target_os = "linux")
        && Path::new("/dev/kfd").exists()
        && Path::new("/dev/dri").exists()
    {
        LUCEBOX_IMAGE_ROCM
    } else {
        return skipped(
            "lucebox",
            "Automatic setup requires a supported NVIDIA or Linux AMD GPU.",
        );
    };

    let models_dir = data_dir
        .join(RUNNER_INSTALL_DIR)
        .join("lucebox")
        .join("models");
    if let Err(error) = fs::create_dir_all(&models_dir) {
        return failed(
            "lucebox",
            format!("Could not create the runner model directory: {error}"),
        );
    }

    let pull = run_docker(
        data_dir,
        "lucebox",
        &["pull".to_string(), image.to_string()],
    );
    if let Err(error) = pull {
        return failed("lucebox", error);
    }

    let run_result = if existing && !docker_container_running(data_dir, LUCEBOX_CONTAINER_NAME) {
        run_docker(
            data_dir,
            "lucebox",
            &["start".to_string(), LUCEBOX_CONTAINER_NAME.to_string()],
        )
    } else if existing {
        Ok("The existing GPU container is already running.".to_string())
    } else {
        let mut args = vec![
            "run".to_string(),
            "-d".to_string(),
            "--name".to_string(),
            LUCEBOX_CONTAINER_NAME.to_string(),
            "--restart".to_string(),
            "unless-stopped".to_string(),
            "-p".to_string(),
            format!("{port}:8080"),
            "-v".to_string(),
            format!("{}:/opt/lucebox-hub/server/models", models_dir.display()),
        ];
        if image == LUCEBOX_IMAGE_CUDA {
            args.extend(["--gpus".to_string(), "all".to_string()]);
        } else {
            args.extend([
                "--device".to_string(),
                "/dev/kfd".to_string(),
                "--device".to_string(),
                "/dev/dri".to_string(),
                "--security-opt".to_string(),
                "seccomp=unconfined".to_string(),
            ]);
        }
        args.push(image.to_string());
        run_docker(data_dir, "lucebox", &args)
    };

    if let Err(error) = run_result {
        return failed("lucebox", error);
    }

    if wait_for_http(port, "/health", STARTUP_WAIT)
        || wait_for_http(port, "/v1/models", STARTUP_WAIT)
    {
        success(
            "lucebox",
            InferenceRunnerState::InstalledAndStarted,
            Some(endpoint.clone()),
            Some("The GPU container was installed and started.".to_string()),
        )
    } else {
        success(
            "lucebox",
            InferenceRunnerState::Installed,
            Some(endpoint),
            Some("The GPU container was installed; its model server is still starting or needs a model file.".to_string()),
        )
    }
}

fn ensure_python_cli(
    data_dir: &Path,
    runner: &str,
    package: &str,
    executable_name: &str,
    minimum_minor: u8,
) -> Result<PathBuf, String> {
    let runner_dir = data_dir.join(RUNNER_INSTALL_DIR).join(runner);
    let venv_dir = runner_dir.join("venv");
    let venv_python = if cfg!(target_os = "windows") {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python")
    };
    let venv_executable = if cfg!(target_os = "windows") {
        venv_dir.join("Scripts").join(executable_name)
    } else {
        venv_dir.join("bin").join(executable_name)
    };

    if venv_python.exists() && !python_is_compatible(&venv_python, minimum_minor) {
        append_runner_log(
            data_dir,
            runner,
            &format!(
                "rebuilding the managed environment because {package} requires Python 3.{minimum_minor}+"
            ),
        );
        fs::remove_dir_all(&venv_dir).map_err(|error| {
            format!("Could not replace the incompatible {runner} environment: {error}")
        })?;
    }

    if !venv_python.exists() {
        fs::create_dir_all(&runner_dir)
            .map_err(|error| format!("Could not create the {runner} runner directory: {error}"))?;
        let python = ensure_compatible_host_python(data_dir, runner, minimum_minor)?;
        run_command(
            data_dir,
            runner,
            &python,
            &[
                "-m".to_string(),
                "venv".to_string(),
                venv_dir.display().to_string(),
            ],
        )?;
    }

    let install_result = run_command(
        data_dir,
        runner,
        &venv_python,
        &[
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "--upgrade".to_string(),
            package.to_string(),
        ],
    );
    if let Err(error) = install_result {
        if !venv_executable.exists() {
            return Err(error);
        }
        append_runner_log(
            data_dir,
            runner,
            &format!("warning: could not check for a {package} update; using the installed command: {error}"),
        );
    }

    if venv_executable.exists() {
        Ok(venv_executable)
    } else {
        Err(format!(
            "The {package} installation completed without creating its {executable_name} command."
        ))
    }
}

fn ensure_compatible_host_python(
    data_dir: &Path,
    runner: &str,
    minimum_minor: u8,
) -> Result<PathBuf, String> {
    if let Some(python) = host_python(minimum_minor) {
        return Ok(python);
    }

    #[cfg(target_os = "macos")]
    {
        let brew = command_on_path("brew").ok_or_else(|| {
            format!(
                "Python 3.{minimum_minor}+ is required for {runner}. Install Python or Homebrew, then retry setup."
            )
        })?;
        append_runner_log(
            data_dir,
            runner,
            &format!("installing a compatible Python for {runner} with Homebrew"),
        );
        run_command(
            data_dir,
            runner,
            &brew,
            &["install".to_string(), "python@3.11".to_string()],
        )?;
        if let Some(python) = host_python(minimum_minor) {
            return Ok(python);
        }
    }

    Err(format!(
        "Python 3.{minimum_minor}+ is required to install {runner}, but no compatible Python was found."
    ))
}

fn ensure_vllm_metal(data_dir: &Path) -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "The current user's home directory could not be resolved.".to_string())?;
    let expected = home.join(".venv-vllm-metal").join("bin").join("vllm");
    if expected.exists() {
        return Ok(expected);
    }

    let runner_dir = data_dir.join(RUNNER_INSTALL_DIR).join("vllm");
    fs::create_dir_all(&runner_dir)
        .map_err(|error| format!("Could not create the vLLM runner directory: {error}"))?;
    let script_path = runner_dir.join("install-vllm-metal.sh");
    let curl = command_on_path("curl").ok_or_else(|| {
        "curl is required to install vLLM-Metal but was not found on PATH.".to_string()
    })?;
    let downloaded = run_command(
        data_dir,
        "vllm",
        &curl,
        &[
            "-fsSL".to_string(),
            VLLM_METAL_INSTALL_URL.to_string(),
            "-o".to_string(),
            script_path.display().to_string(),
        ],
    );
    if let Err(error) = downloaded {
        return Err(error);
    }

    #[cfg(unix)]
    fs::set_permissions(&script_path, fs::Permissions::from_mode(0o700))
        .map_err(|error| format!("Could not make the vLLM-Metal installer executable: {error}"))?;

    let bash = command_on_path("bash").ok_or_else(|| {
        "bash is required to install vLLM-Metal but was not found on PATH.".to_string()
    })?;
    run_command(
        data_dir,
        "vllm",
        &bash,
        &[script_path.display().to_string()],
    )?;

    if expected.exists() {
        Ok(expected)
    } else {
        command_on_path("vllm").ok_or_else(|| {
            "The vLLM-Metal installer completed without creating a vllm command.".to_string()
        })
    }
}

fn host_python(minimum_minor: u8) -> Option<PathBuf> {
    [
        "python3.13",
        "python3.12",
        "python3.11",
        "python3.10",
        "python3",
        "python",
    ]
    .iter()
    .filter_map(|candidate| command_on_path(candidate))
    .find(|candidate| python_is_compatible(candidate, minimum_minor))
}

fn python_is_compatible(python: &Path, minimum_minor: u8) -> bool {
    python_version(python)
        .map(|version| python_version_is_compatible(version, minimum_minor))
        .unwrap_or(false)
}

fn python_version_is_compatible((major, minor): (u8, u8), minimum_minor: u8) -> bool {
    major == 3 && minor >= minimum_minor
}

fn python_version(python: &Path) -> Option<(u8, u8)> {
    let output = Command::new(python)
        .args([
            "-c",
            "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_python_version(&String::from_utf8_lossy(&output.stdout))
}

fn parse_python_version(value: &str) -> Option<(u8, u8)> {
    let mut parts = value.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn command_on_path(binary: &str) -> Option<PathBuf> {
    let locator = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    let mut command = Command::new(locator);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let resolved = command
        .arg(binary)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(PathBuf::from)
        });

    if resolved.is_some() {
        return resolved;
    }

    // Tauri apps launched from Finder/the desktop often inherit a reduced PATH.
    // Keep the native installer usable in that launch mode without changing the
    // user's shell configuration.
    #[cfg(unix)]
    for directory in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        let candidate = Path::new(directory).join(binary);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn available_host_port(preferred: u16) -> Option<u16> {
    for offset in 0..64u16 {
        let Some(port) = preferred.checked_add(offset) else {
            break;
        };
        if TcpListener::bind(("0.0.0.0", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

fn host_endpoint(port: u16) -> String {
    format!("http://host.docker.internal:{port}")
}

fn endpoint_port(endpoint: &str) -> Option<u16> {
    let authority = endpoint.split_once("://")?.1.split('/').next()?;
    authority.rsplit_once(':')?.1.parse().ok()
}

fn nvidia_smi_works() -> bool {
    let Some(nvidia_smi) = command_on_path("nvidia-smi") else {
        return false;
    };
    Command::new(nvidia_smi)
        .arg("--query-gpu=name")
        .arg("--format=csv,noheader")
        .output()
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false)
}

fn runner_api_key_path(data_dir: &Path, runner: &str) -> PathBuf {
    runner_state_dir(data_dir).join(format!("{runner}.api-key"))
}

fn read_runner_api_key(data_dir: &Path, runner: &str) -> Option<String> {
    let value = fs::read_to_string(runner_api_key_path(data_dir, runner)).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn ensure_runner_api_key(data_dir: &Path, runner: &str) -> Result<String, String> {
    if let Some(key) = read_runner_api_key(data_dir, runner) {
        return Ok(key);
    }

    fs::create_dir_all(runner_state_dir(data_dir)).map_err(|error| {
        format!("Could not create the {runner} runner state directory: {error}")
    })?;

    let mut bytes = [0u8; API_KEY_BYTES];
    OsRng.fill_bytes(&mut bytes);
    let key = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = runner_api_key_path(data_dir, runner);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);

    match options.open(&path) {
        Ok(mut file) => {
            if let Err(error) = file
                .write_all(key.as_bytes())
                .and_then(|_| file.write_all(b"\n"))
            {
                drop(file);
                let _ = fs::remove_file(&path);
                return Err(format!("Could not write the {runner} API key: {error}"));
            }
            #[cfg(unix)]
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("Could not protect the {runner} API key: {error}"))?;
            Ok(key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_runner_api_key(data_dir, runner)
                .ok_or_else(|| format!("The existing {runner} API key is empty or unreadable."))
        }
        Err(error) => Err(format!("Could not create the {runner} API key: {error}")),
    }
}

fn reconcile_macos_launch_agents(data_dir: &Path, requested: &[String]) {
    #[cfg(target_os = "macos")]
    for runner in unselected_persistent_runners(requested) {
        if let Err(error) = disable_macos_launch_agent(runner) {
            append_runner_log(
                data_dir,
                runner,
                &format!("warning: could not disable the unselected login service: {error}"),
            );
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (data_dir, requested);
}

fn reconcile_linux_systemd_services(data_dir: &Path, requested: &[String]) {
    #[cfg(target_os = "linux")]
    for runner in unselected_persistent_runners(requested) {
        if let Err(error) = disable_linux_systemd_service(runner) {
            append_runner_log(
                data_dir,
                runner,
                &format!("warning: could not disable the unselected user service: {error}"),
            );
        }
    }

    #[cfg(not(target_os = "linux"))]
    let _ = (data_dir, requested);
}

fn unselected_persistent_runners(requested: &[String]) -> Vec<&'static str> {
    ["dspark", "mtplx"]
        .into_iter()
        .filter(|runner| !requested.iter().any(|requested| requested == runner))
        .collect()
}

#[cfg(target_os = "macos")]
fn launch_agent_label(runner: &str) -> String {
    format!("{MACOS_LAUNCH_AGENT_PREFIX}.{runner}")
}

#[cfg(target_os = "macos")]
fn launch_agent_path(runner: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "The current user's home directory could not be resolved.".to_string())?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{}.plist", launch_agent_label(runner))))
}

#[cfg(target_os = "macos")]
fn launchctl_target() -> String {
    let uid = unsafe { libc::geteuid() };
    format!("gui/{uid}")
}

#[cfg(target_os = "macos")]
fn disable_macos_launch_agent(runner: &str) -> Result<(), String> {
    let path = launch_agent_path(runner)?;
    if !path.exists() {
        return Ok(());
    }

    let target = format!("{}/{}", launchctl_target(), launch_agent_label(runner));
    let _ = Command::new("/bin/launchctl")
        .args(["bootout", target.as_str()])
        .output();
    fs::remove_file(&path).map_err(|error| format!("Could not remove {}: {error}", path.display()))
}

#[cfg(target_os = "macos")]
fn start_macos_launch_agent(
    runner: &str,
    executable: &Path,
    args: &[String],
    log_path: &Path,
) -> Result<(), String> {
    let path = launch_agent_path(runner)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve the LaunchAgents directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;

    let label = launch_agent_label(runner);
    let plist = render_launch_agent_plist(&label, executable, args, log_path);
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true).mode(0o600);
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    file.write_all(plist.as_bytes())
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not protect {}: {error}", path.display()))?;

    let target = launchctl_target();
    let service_target = format!("{target}/{label}");
    let _ = Command::new("/bin/launchctl")
        .args(["bootout", service_target.as_str()])
        .output();
    if let Err(error) = run_launchctl(&[
        "bootstrap",
        target.as_str(),
        path.to_string_lossy().as_ref(),
    ]) {
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    if let Err(error) = run_launchctl(&["kickstart", "-k", service_target.as_str()]) {
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", service_target.as_str()])
            .output();
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn run_launchctl(args: &[&str]) -> Result<(), String> {
    let output = Command::new("/bin/launchctl")
        .args(args)
        .output()
        .map_err(|error| format!("Could not run launchctl: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!(
            "launchctl {} exited with {}",
            args.join(" "),
            output.status
        ))
    } else {
        Err(format!("launchctl {} failed: {stderr}", args.join(" ")))
    }
}

fn render_launch_agent_plist(
    label: &str,
    executable: &Path,
    args: &[String],
    log_path: &Path,
) -> String {
    let mut program_arguments = Vec::with_capacity(args.len() + 1);
    program_arguments.push(executable.display().to_string());
    program_arguments.extend(args.iter().cloned());
    let arguments = program_arguments
        .iter()
        .map(|argument| format!("    <string>{}</string>", xml_escape(argument)))
        .collect::<Vec<_>>()
        .join("\n");
    let log_path = xml_escape(&log_path.display().to_string());

    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\">\n\
<dict>\n\
  <key>Label</key>\n\
  <string>{}</string>\n\
  <key>ProgramArguments</key>\n\
  <array>\n{}\n  </array>\n\
  <key>EnvironmentVariables</key>\n\
  <dict>\n\
    <key>PATH</key>\n\
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>\n\
  </dict>\n\
  <key>RunAtLoad</key>\n\
  <true/>\n\
  <key>KeepAlive</key>\n\
  <dict>\n\
    <key>SuccessfulExit</key>\n\
    <false/>\n\
  </dict>\n\
  <key>ThrottleInterval</key>\n\
  <integer>10</integer>\n\
  <key>StandardOutPath</key>\n\
  <string>{}</string>\n\
  <key>StandardErrorPath</key>\n\
  <string>{}</string>\n\
</dict>\n\
</plist>\n",
        xml_escape(label),
        arguments,
        log_path,
        log_path,
    )
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(any(test, target_os = "linux"))]
fn systemd_service_name(runner: &str) -> String {
    format!("{LINUX_SYSTEMD_SERVICE_PREFIX}.{runner}.service")
}

#[cfg(any(test, target_os = "linux"))]
fn systemd_user_service_path(runner: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir()
        .ok_or_else(|| "The current user's home directory could not be resolved.".to_string())?;
    let config_dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    Ok(config_dir
        .join("systemd")
        .join("user")
        .join(systemd_service_name(runner)))
}

#[cfg(any(test, target_os = "linux"))]
fn systemd_escape_arg(value: &str) -> String {
    let escaped = value
        .replace('%', "%%")
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    if escaped.is_empty()
        || escaped.contains(|c: char| {
            c.is_whitespace() || c == '"' || c == '\'' || c == '\\' || c == '=' || c == ';'
        })
    {
        format!("\"{escaped}\"")
    } else {
        escaped
    }
}

#[cfg(any(test, target_os = "linux"))]
fn render_systemd_user_service(
    runner: &str,
    executable: &Path,
    args: &[String],
    log_path: &Path,
) -> String {
    let mut command_parts = Vec::with_capacity(args.len() + 1);
    command_parts.push(systemd_escape_arg(&executable.display().to_string()));
    command_parts.extend(args.iter().map(|arg| systemd_escape_arg(arg)));
    let exec_start = command_parts.join(" ");

    let log_path_str = log_path.display().to_string().replace('%', "%%");

    format!(
        "[Unit]\n\
Description=Companion Hub inference runner ({runner})\n\
After=network.target\n\n\
[Service]\n\
Type=simple\n\
ExecStart={exec_start}\n\
Restart=on-failure\n\
RestartSec=10\n\
Environment=\"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin\"\n\
StandardOutput=append:{log_path_str}\n\
StandardError=append:{log_path_str}\n\n\
[Install]\n\
WantedBy=default.target\n"
    )
}

#[cfg(target_os = "linux")]
fn run_systemctl(args: &[&str]) -> Result<(), String> {
    let output = Command::new("systemctl")
        .args(args)
        .output()
        .map_err(|error| format!("Could not run systemctl: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        Err(format!(
            "systemctl {} exited with {}",
            args.join(" "),
            output.status
        ))
    } else {
        Err(format!("systemctl {} failed: {stderr}", args.join(" ")))
    }
}

#[cfg(target_os = "linux")]
fn disable_linux_systemd_service(runner: &str) -> Result<(), String> {
    let path = systemd_user_service_path(runner)?;
    if !path.exists() {
        return Ok(());
    }

    let service_name = systemd_service_name(runner);
    let _ = run_systemctl(&["--user", "disable", "--now", &service_name]);
    let remove_result = fs::remove_file(&path)
        .map_err(|error| format!("Could not remove {}: {error}", path.display()));
    let _ = run_systemctl(&["--user", "daemon-reload"]);
    let _ = run_systemctl(&["--user", "reset-failed", &service_name]);
    remove_result
}

#[cfg(target_os = "linux")]
fn start_linux_systemd_service(
    runner: &str,
    executable: &Path,
    args: &[String],
    log_path: &Path,
) -> Result<(), String> {
    let path = systemd_user_service_path(runner)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve the systemd user service directory.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;

    let service = render_systemd_user_service(runner, executable, args, log_path);
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true).mode(0o644);
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Could not open {}: {error}", path.display()))?;
    file.write_all(service.as_bytes())
        .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
        .map_err(|error| format!("Could not protect {}: {error}", path.display()))?;

    let service_name = systemd_service_name(runner);
    let _ = run_systemctl(&["--user", "stop", &service_name]);
    let _ = run_systemctl(&["--user", "daemon-reload"]);
    if let Err(error) = run_systemctl(&["--user", "enable", "--now", &service_name]) {
        let _ = fs::remove_file(&path);
        let _ = run_systemctl(&["--user", "daemon-reload"]);
        return Err(error);
    }

    Ok(())
}

fn start_host_process(
    data_dir: &Path,
    runner: &str,
    executable: &Path,
    args: &[String],
    port: u16,
    health_path: &str,
    endpoint: &str,
    api_key: Option<&str>,
) -> InferenceRunnerResult {
    if probe_http_authenticated(port, health_path, api_key) {
        return already_running(runner, endpoint);
    }

    if let Some(pid) = existing_runner_pid(data_dir, runner) {
        if wait_for_http_authenticated(port, health_path, api_key, STARTUP_WAIT) {
            return already_running(runner, endpoint);
        }
        return failed(
            runner,
            format!("A previous {runner} process (pid {pid}) is still running but did not become ready."),
        );
    }

    let log_path = runner_log_path(data_dir, runner);
    let Some(parent) = log_path.parent() else {
        return failed(
            runner,
            "Could not resolve the runner log directory.".to_string(),
        );
    };
    if let Err(error) = fs::create_dir_all(parent) {
        return failed(
            runner,
            format!("Could not create the runner log directory: {error}"),
        );
    }
    let log_file = match OpenOptions::new().create(true).append(true).open(&log_path) {
        Ok(file) => file,
        Err(error) => return failed(runner, format!("Could not open the runner log: {error}")),
    };
    let log_clone = match log_file.try_clone() {
        Ok(file) => file,
        Err(error) => {
            return failed(
                runner,
                format!("Could not duplicate the runner log: {error}"),
            )
        }
    };

    append_runner_log(
        data_dir,
        runner,
        &format!(
            "starting {} {}",
            executable.display(),
            redact_args(args, api_key).join(" ")
        ),
    );

    #[cfg(target_os = "macos")]
    if matches!(runner, "dspark" | "mtplx") {
        match start_macos_launch_agent(runner, executable, args, &log_path) {
            Ok(()) => {
                if wait_for_http_authenticated(port, health_path, api_key, STARTUP_WAIT) {
                    return success(
                        runner,
                        InferenceRunnerState::InstalledAndStarted,
                        Some(endpoint.to_string()),
                        Some(format!(
                            "{runner} was installed and will restart automatically at login or after a crash."
                        )),
                    );
                }
                return success(
                    runner,
                    InferenceRunnerState::Installed,
                    Some(endpoint.to_string()),
                    Some(format!(
                        "{runner} was installed as a login service; its API is still starting."
                    )),
                );
            }
            Err(error) => append_runner_log(
                data_dir,
                runner,
                &format!(
                    "warning: login service setup failed; falling back to this session: {error}"
                ),
            ),
        }
    }

    #[cfg(target_os = "linux")]
    if matches!(runner, "dspark" | "mtplx") {
        match start_linux_systemd_service(runner, executable, args, &log_path) {
            Ok(()) => {
                if wait_for_http_authenticated(port, health_path, api_key, STARTUP_WAIT) {
                    return success(
                        runner,
                        InferenceRunnerState::InstalledAndStarted,
                        Some(endpoint.to_string()),
                        Some(format!(
                            "{runner} was installed and will restart automatically at login or after a crash."
                        )),
                    );
                }
                return success(
                    runner,
                    InferenceRunnerState::Installed,
                    Some(endpoint.to_string()),
                    Some(format!(
                        "{runner} was installed as a user service; its API is still starting."
                    )),
                );
            }
            Err(error) => append_runner_log(
                data_dir,
                runner,
                &format!(
                    "warning: user service setup failed; falling back to this session: {error}"
                ),
            ),
        }
    }

    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log_clone))
        .stderr(Stdio::from(log_file));
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return failed(runner, format!("Could not start {runner}: {error}")),
    };
    let pid = child.id();
    if let Err(error) = write_runner_pid(data_dir, runner, pid) {
        append_runner_log(
            data_dir,
            runner,
            &format!("warning: could not persist process id {pid}: {error}"),
        );
    }

    if wait_for_http_authenticated(port, health_path, api_key, STARTUP_WAIT) {
        success(
            runner,
            InferenceRunnerState::InstalledAndStarted,
            Some(endpoint.to_string()),
            Some(format!("{runner} was installed and started.")),
        )
    } else {
        success(
            runner,
            InferenceRunnerState::Installed,
            Some(endpoint.to_string()),
            Some(format!(
                "{runner} was installed and launched; its API is still starting. See the desktop logs if it does not become ready."
            )),
        )
    }
}

fn redact_args(args: &[String], secret: Option<&str>) -> Vec<String> {
    args.iter()
        .map(|argument| {
            if secret.is_some_and(|secret| argument == secret) {
                "<redacted>".to_string()
            } else {
                argument.clone()
            }
        })
        .collect()
}

fn probe_http(port: u16, path: &str) -> bool {
    probe_http_authenticated(port, path, None)
}

fn probe_http_authenticated(port: u16, path: &str, api_key: Option<&str>) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(750))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    let mut request = client.get(format!("http://127.0.0.1:{port}{path}"));
    if let Some(api_key) = api_key {
        request = request.bearer_auth(api_key);
    }
    request
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn wait_for_http(port: u16, path: &str, timeout: Duration) -> bool {
    wait_for_http_authenticated(port, path, None, timeout)
}

fn wait_for_http_authenticated(
    port: u16,
    path: &str,
    api_key: Option<&str>,
    timeout: Duration,
) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if probe_http_authenticated(port, path, api_key) {
            return true;
        }
        thread::sleep(POLL_INTERVAL);
    }
    false
}

fn run_command(
    data_dir: &Path,
    runner: &str,
    executable: &Path,
    args: &[String],
) -> Result<String, String> {
    append_runner_log(
        data_dir,
        runner,
        &format!("running {} {}", executable.display(), args.join(" ")),
    );
    let output = Command::new(executable)
        .args(args)
        .output()
        .map_err(|error| format!("Could not run {}: {error}", executable.display()))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format_command_output(&stdout, &stderr);
    append_runner_log(data_dir, runner, &combined);
    if output.status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!(
            "{} exited with {}.",
            executable.display(),
            output.status
        ))
    } else {
        Err(format!("{} failed: {}", executable.display(), combined))
    }
}

fn run_docker(data_dir: &Path, runner: &str, args: &[String]) -> Result<String, String> {
    append_runner_log(
        data_dir,
        runner,
        &format!("running docker {}", args.join(" ")),
    );
    let output = hub_manager::docker_command()
        .args(args)
        .output()
        .map_err(|error| format!("Could not run Docker: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format_command_output(&stdout, &stderr);
    append_runner_log(data_dir, runner, &combined);
    if output.status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!("Docker exited with {}.", output.status))
    } else {
        Err(format!("Docker failed: {combined}"))
    }
}

fn docker_container_exists(data_dir: &Path, name: &str) -> bool {
    let output = hub_manager::docker_command()
        .args([
            "ps",
            "-a",
            "--filter",
            &format!("name=^{name}$"),
            "--format",
            "{{.Names}}",
        ])
        .output();
    let exists = output
        .map(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .any(|line| line.trim() == name)
        })
        .unwrap_or(false);
    if exists {
        append_runner_log(
            data_dir,
            "lucebox",
            &format!("found existing Docker container {name}"),
        );
    }
    exists
}

fn docker_container_running(data_dir: &Path, name: &str) -> bool {
    let output = hub_manager::docker_command()
        .args([
            "ps",
            "--filter",
            "status=running",
            "--filter",
            &format!("name=^{name}$"),
            "--format",
            "{{.Names}}",
        ])
        .output();
    let running = output
        .map(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .any(|line| line.trim() == name)
        })
        .unwrap_or(false);
    if running {
        append_runner_log(
            data_dir,
            "lucebox",
            &format!("existing Docker container {name} is running"),
        );
    }
    running
}

fn runner_state_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(RUNNER_STATE_DIR)
}

fn runner_pid_path(data_dir: &Path, runner: &str) -> PathBuf {
    runner_state_dir(data_dir).join(format!("{runner}.pid"))
}

fn runner_log_path(data_dir: &Path, runner: &str) -> PathBuf {
    data_dir.join(RUNNER_LOG_DIR).join(format!("{runner}.log"))
}

fn existing_runner_pid(data_dir: &Path, runner: &str) -> Option<u32> {
    let path = runner_pid_path(data_dir, runner);
    let pid = fs::read_to_string(&path).ok()?.trim().parse::<u32>().ok()?;
    if process_is_alive(pid) {
        Some(pid)
    } else {
        let _ = fs::remove_file(path);
        None
    }
}

fn process_is_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        return result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    }

    #[cfg(target_os = "windows")]
    {
        let filter = format!("PID eq {pid}");
        return Command::new("tasklist")
            .args(["/FI", filter.as_str()])
            .creation_flags(0x08000000)
            .output()
            .map(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
            })
            .unwrap_or(false);
    }

    #[allow(unreachable_code)]
    false
}

fn write_runner_pid(data_dir: &Path, runner: &str, pid: u32) -> std::io::Result<()> {
    fs::create_dir_all(runner_state_dir(data_dir))?;
    fs::write(runner_pid_path(data_dir, runner), pid.to_string())
}

fn append_runner_log(data_dir: &Path, runner: &str, message: &str) {
    let path = runner_log_path(data_dir, runner);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", message.trim_end());
    }
    let _ = hub_manager::append_desktop_log_for(data_dir, &format!("inference.{runner}"), message);
}

fn persist_results(data_dir: &Path, results: &[InferenceRunnerResult]) {
    let path = data_dir.join(RUNNER_STATE_FILE);
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_vec_pretty(results) {
        let _ = fs::write(path, serialized);
    }
}

fn persisted_runner_endpoint(data_dir: &Path, runner: &str) -> Option<String> {
    let path = data_dir.join(RUNNER_STATE_FILE);
    let contents = fs::read_to_string(path).ok()?;
    let results = serde_json::from_str::<Vec<InferenceRunnerResult>>(&contents).ok()?;
    results
        .into_iter()
        .rev()
        .find(|result| result.runner == runner)
        .and_then(|result| result.endpoint_url)
}

fn format_command_output(stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim();
    let stderr = stderr.trim();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_runner_names_are_not_installed() {
        assert_eq!(canonical_runner_name("lunabox"), None);
        assert_eq!(canonical_runner_name("lucebox"), None);
        assert_eq!(canonical_runner_name("mlx-dspark"), None);
        assert_eq!(canonical_runner_name("dspark"), None);
        assert_eq!(canonical_runner_name("mtplx"), None);
        assert_eq!(canonical_runner_name("llamacpp"), None);
        assert_eq!(canonical_runner_name("lmstudio"), None);
        assert_eq!(
            automatic_runner_names(&[
                "lunabox".to_string(),
                "omlx".to_string(),
                "ollama".to_string(),
                "dspark".to_string(),
            ]),
            vec!["omlx".to_string(), "ollama".to_string()]
        );
    }

    #[test]
    fn empty_request_uses_the_complete_automatic_set() {
        assert_eq!(
            automatic_runner_names(&[]),
            DEFAULT_AUTOMATIC_RUNNERS
                .iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn result_serializes_for_the_frontend_contract() {
        let json = serde_json::to_value(success(
            "dspark",
            InferenceRunnerState::InstalledAndStarted,
            Some(DSPARK_ENDPOINT.to_string()),
            Some("started".to_string()),
        ))
        .expect("result should serialize");
        assert_eq!(json["runner"], "dspark");
        assert_eq!(json["state"], "installed_and_started");
        assert_eq!(json["endpointUrl"], DSPARK_ENDPOINT);
        assert_eq!(json["detail"], "started");
    }

    #[test]
    fn dspark_command_is_the_managed_no_model_command() {
        let args = [
            "serve",
            "--no-model",
            "--host",
            "0.0.0.0",
            "--port",
            "8080",
            "--api-key",
            "secret",
        ];
        assert_eq!(
            args.join(" "),
            "serve --no-model --host 0.0.0.0 --port 8080 --api-key secret"
        );
        assert_eq!(
            redact_args(&args.map(ToString::to_string), Some("secret")).join(" "),
            "serve --no-model --host 0.0.0.0 --port 8080 --api-key <redacted>"
        );
    }

    #[test]
    fn parses_and_enforces_backend_python_versions() {
        assert_eq!(parse_python_version("3.11\n"), Some((3, 11)));
        assert_eq!(parse_python_version("Python 3.11.9"), None);
        assert!(python_version_is_compatible((3, 11), 11));
        assert!(!python_version_is_compatible((3, 10), 11));
        assert!(!python_version_is_compatible((2, 17), 11));
    }

    #[test]
    fn creates_and_reuses_private_runner_api_keys() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let first = ensure_runner_api_key(tempdir.path(), "dspark").expect("create key");
        let second = ensure_runner_api_key(tempdir.path(), "dspark").expect("reuse key");

        assert_eq!(first, second);
        assert_eq!(first.len(), API_KEY_BYTES * 2);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(runner_api_key_path(tempdir.path(), "dspark"))
                .expect("key metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn launch_agent_restarts_and_escapes_program_arguments() {
        let plist = render_launch_agent_plist(
            "computer.ci.test",
            Path::new("/tmp/runner & helper"),
            &["serve".to_string(), "model<one>".to_string()],
            Path::new("/tmp/runner.log"),
        );

        assert!(plist.contains("<string>/tmp/runner &amp; helper</string>"));
        assert!(plist.contains("<string>model&lt;one&gt;</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<key>SuccessfulExit</key>"));
    }

    #[test]
    fn systemd_user_service_restarts_and_escapes_program_arguments() {
        let service = render_systemd_user_service(
            "dspark",
            Path::new("/tmp/runner & helper"),
            &[
                "serve".to_string(),
                "--host".to_string(),
                "0.0.0.0".to_string(),
                "--port".to_string(),
                "8080".to_string(),
                "model<one>".to_string(),
            ],
            Path::new("/tmp/runner.log"),
        );

        assert!(service.contains("Description=Companion Hub inference runner (dspark)"));
        assert!(service.contains(
            "ExecStart=\"/tmp/runner & helper\" serve --host 0.0.0.0 --port 8080 model<one>"
        ));
        assert!(service.contains("Restart=on-failure"));
        assert!(service.contains("RestartSec=10"));
        assert!(service.contains("StandardOutput=append:/tmp/runner.log"));
        assert!(service.contains("StandardError=append:/tmp/runner.log"));
        assert!(service.contains("WantedBy=default.target"));
    }

    #[test]
    fn systemd_service_name_and_path_match_convention() {
        assert_eq!(
            systemd_service_name("dspark"),
            "computer.ci.companion-hub.inference.dspark.service"
        );
        assert_eq!(
            systemd_service_name("mtplx"),
            "computer.ci.companion-hub.inference.mtplx.service"
        );

        let path = systemd_user_service_path("dspark").expect("resolve path");
        assert!(path
            .ends_with(".config/systemd/user/computer.ci.companion-hub.inference.dspark.service"));
    }

    #[test]
    fn selecting_one_backend_disables_only_the_other_persistent_runner() {
        assert_eq!(
            unselected_persistent_runners(&["dspark".to_string(), "ollama".to_string()]),
            vec!["mtplx"]
        );
        assert_eq!(
            unselected_persistent_runners(&["ollama".to_string()]),
            vec!["dspark", "mtplx"]
        );
    }

    #[test]
    fn selects_a_free_port_when_the_preferred_port_is_busy() {
        let listener = TcpListener::bind(("0.0.0.0", 0)).expect("test port should bind");
        let preferred = listener
            .local_addr()
            .expect("test listener should have an address")
            .port();
        let selected = available_host_port(preferred).expect("a nearby test port should be free");
        assert_ne!(selected, preferred);
    }

    #[test]
    fn recovers_the_port_from_a_persisted_runner_endpoint() {
        assert_eq!(
            endpoint_port("http://host.docker.internal:8001"),
            Some(8001)
        );
        assert_eq!(
            endpoint_port("http://host.docker.internal:8001/v1"),
            Some(8001)
        );
        assert_eq!(endpoint_port("not-a-url"), None);

        let tempdir = tempfile::tempdir().expect("tempdir");
        let results = vec![success(
            "mtplx",
            InferenceRunnerState::Installed,
            Some("http://host.docker.internal:8001".to_string()),
            None,
        )];
        persist_results(tempdir.path(), &results);
        assert_eq!(
            persisted_runner_endpoint(tempdir.path(), "mtplx"),
            Some("http://host.docker.internal:8001".to_string())
        );
    }

    #[test]
    fn platform_gate_keeps_mlx_runners_off_non_apple_builds() {
        if !platform_is_apple_silicon() {
            let result = install_and_start_dspark(Path::new("/tmp/ci-hub-inference-runner-test"));
            assert_eq!(result.state, InferenceRunnerState::Skipped);
        }
    }
}
