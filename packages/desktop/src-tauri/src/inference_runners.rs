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
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{Deserialize, Serialize};

use crate::hub_manager;

const RUNNER_STATE_DIR: &str = "state/inference-runners";
const RUNNER_INSTALL_DIR: &str = "runners";
const RUNNER_LOG_DIR: &str = "logs/inference";
const RUNNER_STATE_FILE: &str = "state/inference-runners.json";
const STARTUP_WAIT: Duration = Duration::from_secs(45);
const POLL_INTERVAL: Duration = Duration::from_millis(500);

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
pub const DEFAULT_AUTOMATIC_RUNNERS: &[&str] = &["dspark", "mtplx", "lucebox", "vllm", "ollama"];

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
        "dspark" | "mlx-dspark" => Some("dspark"),
        "mtplx" => Some("mtplx"),
        "lucebox" | "lunabox" => Some("lucebox"),
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
        "dspark" => install_and_start_dspark(data_dir),
        "mtplx" => install_and_start_mtplx(data_dir),
        "lucebox" => install_and_start_lucebox(data_dir),
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

    let executable = match ensure_python_cli(data_dir, "dspark", "mlx-dspark", "mlx-dspark") {
        Ok(path) => path,
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
    ];
    start_host_process(
        data_dir,
        "dspark",
        &executable,
        &args,
        DSPARK_PORT,
        "/health",
        DSPARK_ENDPOINT,
    )
}

fn install_and_start_mtplx(data_dir: &Path) -> InferenceRunnerResult {
    if !platform_is_apple_silicon() {
        return skipped(
            "mtplx",
            "This native MLX runner is supported only on Apple Silicon.",
        );
    }

    if probe_http(MTPLX_PORT, "/v1/models") {
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

    let executable = match ensure_python_cli(data_dir, "mtplx", "mtplx", "mtplx") {
        Ok(path) => path,
        Err(error) => return failed("mtplx", error),
    };
    let args = vec![
        "serve".to_string(),
        "--host".to_string(),
        "0.0.0.0".to_string(),
        "--port".to_string(),
        port.to_string(),
    ];
    start_host_process(
        data_dir,
        "mtplx",
        &executable,
        &args,
        port,
        "/v1/models",
        &endpoint,
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

    let (executable, model, extra_args) = if platform_is_apple_silicon() {
        match ensure_vllm_metal(data_dir) {
            Ok(path) => (
                path,
                "mlx-community/Qwen3-8B-4bit".to_string(),
                vec!["--max-model-len".to_string(), "8192".to_string()],
            ),
            Err(error) => return failed("vllm", error),
        }
    } else {
        if !nvidia_smi_works() {
            return skipped(
                "vllm",
                "Automatic Linux vLLM setup requires a working NVIDIA GPU.",
            );
        }
        let path = match ensure_python_cli(data_dir, "vllm", "vllm", "vllm") {
            Ok(path) => path,
            Err(error) => return failed("vllm", error),
        };
        (
            path,
            "Qwen/Qwen3-4B-Instruct-2507".to_string(),
            vec![
                "--quantization".to_string(),
                "bitsandbytes".to_string(),
                "--max-model-len".to_string(),
                "8192".to_string(),
                "--gpu-memory-utilization".to_string(),
                "0.85".to_string(),
            ],
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
) -> Result<PathBuf, String> {
    let runner_dir = data_dir.join(RUNNER_INSTALL_DIR).join(runner);
    let venv_dir = runner_dir.join("venv");
    let python = host_python().ok_or_else(|| {
        "Python 3 is required to install this runner, but python3 was not found on PATH."
            .to_string()
    })?;

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

    if !venv_python.exists() {
        fs::create_dir_all(&runner_dir)
            .map_err(|error| format!("Could not create the {runner} runner directory: {error}"))?;
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

    if !venv_executable.exists() {
        run_command(
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
        )?;
    }

    if venv_executable.exists() {
        Ok(venv_executable)
    } else {
        Err(format!(
            "The {package} installation completed without creating its {executable_name} command."
        ))
    }
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

fn host_python() -> Option<PathBuf> {
    ["python3", "python"]
        .iter()
        .find_map(|candidate| command_on_path(candidate))
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

fn start_host_process(
    data_dir: &Path,
    runner: &str,
    executable: &Path,
    args: &[String],
    port: u16,
    health_path: &str,
    endpoint: &str,
) -> InferenceRunnerResult {
    if probe_http(port, health_path) {
        return already_running(runner, endpoint);
    }

    if let Some(pid) = existing_runner_pid(data_dir, runner) {
        if wait_for_http(port, health_path, STARTUP_WAIT) {
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
        &format!("starting {} {}", executable.display(), args.join(" ")),
    );

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

    if wait_for_http(port, health_path, STARTUP_WAIT) {
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

fn probe_http(port: u16, path: &str) -> bool {
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(750))
        .build()
    {
        Ok(client) => client,
        Err(_) => return false,
    };
    client
        .get(format!("http://127.0.0.1:{port}{path}"))
        .send()
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

fn wait_for_http(port: u16, path: &str, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if probe_http(port, path) {
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
    fn canonicalizes_lunabox_without_exposing_it_as_a_second_runner() {
        assert_eq!(canonical_runner_name("lunabox"), Some("lucebox"));
        assert_eq!(canonical_runner_name("lucebox"), Some("lucebox"));
        assert_eq!(
            automatic_runner_names(&[
                "lunabox".to_string(),
                "lucebox".to_string(),
                "mlx-dspark".to_string(),
                "dspark".to_string(),
            ]),
            vec!["lucebox".to_string(), "dspark".to_string()]
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
        let args = ["serve", "--no-model", "--host", "0.0.0.0", "--port", "8080"];
        assert_eq!(
            args.join(" "),
            "serve --no-model --host 0.0.0.0 --port 8080"
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
    fn platform_gate_keeps_mlx_runners_off_non_apple_builds() {
        if !platform_is_apple_silicon() {
            let result = install_and_start_dspark(Path::new("/tmp/ci-hub-inference-runner-test"));
            assert_eq!(result.state, InferenceRunnerState::Skipped);
        }
    }
}
