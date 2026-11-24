//! Native inference-runner installation and startup.
//!
//! The Hub itself runs in Docker, but several useful inference servers must run
//! on the host (especially MLX/Metal servers).  Keep this orchestration in the
//! desktop shell so the web UI never shells out and so every runner gets an
//! independent, truthful result.

use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
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

use serde::{Deserialize, Serialize};

use crate::hub_manager;

const RUNNER_STATE_DIR: &str = "state/inference-runners";
const RUNNER_INSTALL_DIR: &str = "runners";
const RUNNER_LOG_DIR: &str = "logs/inference";
const RUNNER_STATE_FILE: &str = "state/inference-runners.json";
const STARTUP_WAIT: Duration = Duration::from_secs(45);
const POLL_INTERVAL: Duration = Duration::from_millis(500);
const MACOS_LAUNCH_AGENT_PREFIX: &str = "computer.ci.companion-hub.inference";
#[cfg(any(test, target_os = "linux"))]
const LINUX_SYSTEMD_SERVICE_PREFIX: &str = "computer.ci.companion-hub.inference";

const VLLM_PORT: u16 = 8002;
const OLLAMA_PORT: u16 = 11434;

const VLLM_ENDPOINT: &str = "http://host.docker.internal:8002";
const OLLAMA_ENDPOINT: &str = "http://host.docker.internal:11434";

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
    /// A runner's API key. For oMLX, its main key: the Hub needs it for oMLX's admin API (model
    /// downloads). For vLLM, the key the runner was started with, which the Hub must send. Only the
    /// frontend gets it: it is left out of the persisted results and out of `Debug`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<RunnerApiKey>,
    /// What the person needs to know about a runner that otherwise works, such as an oMLX the Hub
    /// could not give a key. Setup shows `detail` only for a runner that failed or was skipped, so
    /// this is said apart from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// A runner's API key. `Debug` prints a placeholder, so a logged result never carries the key.
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct RunnerApiKey(String);

impl std::fmt::Debug for RunnerApiKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("<redacted>")
    }
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
        api_key: None,
        warning: None,
    }
}

/// `result` with the API key the runner was started with, unless it failed or was skipped.
fn with_api_key(
    mut result: InferenceRunnerResult,
    api_key: Option<String>,
) -> InferenceRunnerResult {
    if !matches!(
        result.state,
        InferenceRunnerState::Failed | InferenceRunnerState::Skipped
    ) {
        result.api_key = api_key.map(RunnerApiKey);
    }
    result
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
const OMLX_TAP_URL: &str = "https://github.com/jundot/omlx";
const OMLX_NO_HOMEBREW: &str = "The Hub can't find Homebrew on this Mac, so it can't install oMLX. \
Install Homebrew from https://brew.sh and try again, or install the oMLX app from https://github.com/jundot/omlx/releases.";
/// The CLI inside the oMLX app. `omlx start` through it opens the app and starts its server.
const OMLX_APP_CLI: &str = "/Applications/oMLX.app/Contents/MacOS/omlx-cli";

/// Homebrew's bin directories: Apple Silicon first, then Intel. A Mac app opened from Finder or
/// the Dock gets PATH `/usr/bin:/bin:/usr/sbin:/sbin`, which has neither.
const HOMEBREW_BIN_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// The longest tail of a failed command's output that goes into a result's detail.
const OUTPUT_TAIL_MAX_CHARS: usize = 240;

fn install_and_start_omlx(data_dir: &Path) -> InferenceRunnerResult {
    if !platform_is_apple_silicon() {
        return skipped("omlx", "oMLX runs only on Apple Silicon.");
    }
    let settings_path = dirs::home_dir().map(|home| omlx_settings_path(&home));
    // The key oMLX already has, if any. A keyed oMLX wants it on `/v1/models` unless it allows
    // inference without one, and the Hub needs it for the admin API either way.
    let existing_key = settings_path.as_deref().and_then(read_omlx_api_key);
    if probe_http_authenticated(OMLX_PORT, "/v1/models", existing_key.as_deref()) {
        return with_api_key(already_running("omlx", OMLX_ENDPOINT), existing_key);
    }

    let homebrew_dirs = homebrew_bin_dirs();
    let inherited_path = std::env::var_os("PATH");
    let brew = find_executable("brew", inherited_path.as_deref(), &homebrew_dirs);
    // `omlx start` on a Homebrew install runs `brew services start omlx` and finds brew on its own
    // PATH, so every child gets Homebrew's directories, not only the commands started here.
    let brew_dir = brew.as_deref().and_then(Path::parent);
    let child_path = homebrew_child_path(brew_dir, &homebrew_dirs, inherited_path.as_deref());
    // A Finder launch has neither the app's ~/.omlx/bin nor an unlinked keg on PATH. Without
    // these the Hub would build a second copy with Homebrew, or ask for the app it already has.
    let omlx_fallbacks =
        omlx_fallback_commands(brew_dir, &homebrew_dirs, dirs::home_dir().as_deref());
    let find_omlx = || {
        find_executable("omlx", Some(&child_path), &[]).or_else(|| {
            omlx_fallbacks
                .iter()
                .find(|candidate| is_executable_file(candidate))
                .cloned()
        })
    };

    let (omlx, installed_now) = match find_omlx() {
        Some(omlx) => {
            append_runner_log(
                data_dir,
                "omlx",
                &format!(
                    "oMLX is already installed at {}; starting it",
                    omlx.display()
                ),
            );
            (omlx, false)
        }
        None => {
            let Some(brew) = brew else {
                return failed("omlx", OMLX_NO_HOMEBREW.to_string());
            };
            if let Err(error) = install_omlx_with_homebrew(data_dir, &brew, &child_path) {
                return failed("omlx", error);
            }
            match find_omlx() {
                Some(omlx) => (omlx, true),
                None => return failed(
                    "omlx",
                    "brew install jundot/omlx/omlx finished, but the omlx command was not found."
                        .to_string(),
                ),
            }
        }
    };

    if let Err(error) = start_omlx(data_dir, &omlx, &child_path) {
        return failed("omlx", error);
    }

    let started = if installed_now {
        "oMLX was installed and started."
    } else {
        "oMLX was started."
    };
    if !wait_for_http_authenticated(
        OMLX_PORT,
        "/v1/models",
        existing_key.as_deref(),
        STARTUP_WAIT,
    ) {
        // A new oMLX that has not answered yet has not been given a key either.
        let warning = (installed_now && existing_key.is_none()).then(|| {
            "oMLX did not answer in time, so the Hub could not give it an API key and cannot download models through it yet. Set a key from the oMLX card in Settings > AI once oMLX answers.".to_string()
        });
        let mut result = with_api_key(
            success(
                "omlx",
                InferenceRunnerState::Installed,
                Some(OMLX_ENDPOINT.to_string()),
                Some("oMLX is installed, but its API is still starting. Foreground form: omlx serve --model-dir ~/models".to_string()),
            ),
            existing_key,
        );
        result.warning = warning;
        return result;
    }

    // An oMLX installed here gets a main key once it answers, so the Hub can download models
    // through its admin API. One that was already here is left as its owner set it: other tools
    // of theirs may use its `/v1` without a key, and the Hub asks before it sets one.
    if existing_key.is_some() || !installed_now {
        return with_api_key(
            success(
                "omlx",
                InferenceRunnerState::InstalledAndStarted,
                Some(OMLX_ENDPOINT.to_string()),
                Some(started.to_string()),
            ),
            existing_key,
        );
    }
    let (api_key, warning) = match setup_omlx_admin_key(data_dir) {
        Ok(setup) => (Some(setup.api_key.0), setup.warning),
        Err(error) => (
            None,
            Some(format!("The Hub could not give oMLX an API key, so it cannot download models through it yet: {error}")),
        ),
    };
    let detail = match &warning {
        Some(warning) => format!("{started} {warning}"),
        None => started.to_string(),
    };
    let mut result = with_api_key(
        success(
            "omlx",
            InferenceRunnerState::InstalledAndStarted,
            Some(OMLX_ENDPOINT.to_string()),
            Some(detail),
        ),
        api_key,
    );
    result.warning = warning;
    result
}

/// oMLX on this Mac, as its own loopback checks see a request: `setup-api-key` answers only a
/// loopback peer, which `host.docker.internal` from the Hub's container is not.
const OMLX_LOOPBACK_URL: &str = "http://127.0.0.1:8000";

/// What [`setup_omlx_admin_key`] hands the frontend: the key it set, and a warning when oMLX took
/// the key but did not leave `/v1` open without one.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OmlxAdminKeySetup {
    pub api_key: RunnerApiKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Whether oMLX's settings file holds a main key. The key itself stays in this process.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OmlxAdminKeyStatus {
    pub key_set: bool,
}

pub fn omlx_admin_key_status() -> OmlxAdminKeyStatus {
    let key_set = dirs::home_dir()
        .map(|home| read_omlx_api_key(&omlx_settings_path(&home)).is_some())
        .unwrap_or(false);
    OmlxAdminKeyStatus { key_set }
}

/// Give an oMLX that has no main key one, through its own first-key setup
/// (`POST /admin/api/setup-api-key` in jundot/omlx omlx/admin/routes.py), then keep `/v1` open
/// without a key as it was (`allow_unauthenticated_inference` through
/// `POST /admin/api/global-settings`). oMLX applies both at once and saves them to its settings.
/// It takes a first key only while it listens on loopback alone and the request comes from this
/// Mac, and only while it has none.
pub fn setup_omlx_admin_key(data_dir: &Path) -> Result<OmlxAdminKeySetup, String> {
    if !platform_is_apple_silicon() {
        return Err("oMLX runs only on Apple Silicon.".to_string());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Could not prepare the request to oMLX: {error}"))?;
    let key = generate_omlx_api_key();

    let response = client
        .post(format!("{OMLX_LOOPBACK_URL}/admin/api/setup-api-key"))
        .json(&omlx_setup_api_key_body(&key))
        .send()
        .map_err(|error| format!("Could not reach oMLX at {OMLX_LOOPBACK_URL}: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        let refusal = omlx_setup_refusal(status.as_u16(), &body);
        append_runner_log(
            data_dir,
            "omlx",
            &format!("oMLX did not take an API key: {refusal}"),
        );
        return Err(refusal);
    }
    append_runner_log(data_dir, "omlx", "set a main API key for oMLX");

    let warning = match client
        .post(format!("{OMLX_LOOPBACK_URL}/admin/api/global-settings"))
        .bearer_auth(&key)
        .json(&omlx_open_inference_body())
        .send()
    {
        Ok(response) if response.status().is_success() => None,
        Ok(response) => {
            let status = response.status().as_u16();
            Some(omlx_open_inference_failure(
                Some(status),
                &response.text().unwrap_or_default(),
            ))
        }
        Err(error) => Some(omlx_open_inference_failure(None, &error.to_string())),
    };
    if let Some(warning) = &warning {
        append_runner_log(data_dir, "omlx", &format!("warning: {warning}"));
    }
    Ok(OmlxAdminKeySetup {
        api_key: RunnerApiKey(key),
        warning,
    })
}

/// `SetupApiKeyRequest` in jundot/omlx omlx/admin/routes.py: the key twice, as its setup form sends it.
fn omlx_setup_api_key_body(key: &str) -> serde_json::Value {
    serde_json::json!({ "api_key": key, "api_key_confirm": key })
}

/// The one global setting the Hub changes: `/v1` stays open without a key, as it was before oMLX had one.
fn omlx_open_inference_body() -> serde_json::Value {
    serde_json::json!({ "allow_unauthenticated_inference": true })
}

/// oMLX's `detail` from an error body (`{"detail": "..."}`), else the body itself, shortened.
fn omlx_error_detail(body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("detail")
                .and_then(|detail| detail.as_str())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| body.trim().to_string());
    command_output_tail("", &detail).unwrap_or_default()
}

/// Why oMLX refused its first key, said so the person knows what to do instead.
fn omlx_setup_refusal(status: u16, body: &str) -> String {
    let detail = omlx_error_detail(body);
    match status {
        400 if detail.contains("already configured") => {
            "oMLX already has an API key, so the Hub cannot set one. Enter oMLX's key in Settings > AI. It is in ~/.omlx/settings.json, or set it again on oMLX's page at http://localhost:8000/admin.".to_string()
        }
        400 => format!("oMLX refused the new API key: {detail}"),
        403 => "oMLX sets its first API key only while it listens on this Mac alone (127.0.0.1) and the request comes from this Mac. Set a key in oMLX's own settings, then enter it in Settings > AI.".to_string(),
        _ if detail.is_empty() => format!("oMLX answered HTTP {status} when the Hub set its API key."),
        _ => format!("oMLX answered HTTP {status} when the Hub set its API key: {detail}"),
    }
}

/// The warning when oMLX took the key but not the setting that keeps `/v1` open. `status` is absent
/// when the request itself failed.
fn omlx_open_inference_failure(status: Option<u16>, body: &str) -> String {
    let detail = omlx_error_detail(body);
    let cause = match (status, detail.is_empty()) {
        (Some(status), true) => format!("HTTP {status}"),
        (Some(status), false) => format!("HTTP {status}: {detail}"),
        (None, _) => detail,
    };
    format!(
        "oMLX now has an API key, but it did not keep /v1 open without one ({cause}). Apps that talk to oMLX directly need the key until \"Allow inference without API key\" is on in oMLX's settings."
    )
}

/// oMLX's settings file, from its base path: the one the oMLX app saved in
/// `~/Library/Application Support/oMLX/base-path`, else `~/.omlx` (`resolve_default_base_path` in
/// jundot/omlx omlx/settings.py). Its `OMLX_BASE_PATH` override is left out: `brew services` does
/// not pass this app's environment to the server, so the server never sees it either.
fn omlx_settings_path(home: &Path) -> PathBuf {
    let bootstrap = home
        .join("Library")
        .join("Application Support")
        .join("oMLX")
        .join("base-path");
    let base = fs::read_to_string(bootstrap)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .map(|raw| match raw.strip_prefix("~/") {
            Some(rest) => home.join(rest),
            None if raw == "~" => home.to_path_buf(),
            None => PathBuf::from(raw),
        })
        .unwrap_or_else(|| home.join(".omlx"));
    base.join("settings.json")
}

/// `auth.api_key` from oMLX's settings file, when one is set.
fn read_omlx_api_key(path: &Path) -> Option<String> {
    let settings: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    settings
        .get("auth")?
        .get("api_key")?
        .as_str()
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(ToString::to_string)
}

/// A main key oMLX accepts: at least 4 printable ASCII characters and no whitespace
/// (`validate_api_key` in jundot/omlx omlx/admin/auth.py).
fn generate_omlx_api_key() -> String {
    // rand 0.10: `rng()` is the OS-seeded CSPRNG.
    use rand::RngExt;
    let random: String = rand::rng()
        .sample_iter(rand::distr::Alphanumeric)
        .take(40)
        .map(char::from)
        .collect();
    format!("ci-hub-{random}")
}

fn install_omlx_with_homebrew(data_dir: &Path, brew: &Path, path: &OsStr) -> Result<(), String> {
    run_with_path(
        data_dir,
        "omlx",
        brew,
        &["tap", "jundot/omlx", OMLX_TAP_URL],
        path,
        "brew tap jundot/omlx",
    )?;
    run_with_path(
        data_dir,
        "omlx",
        brew,
        &["install", "jundot/omlx/omlx"],
        path,
        "brew install jundot/omlx/omlx",
    )
}

/// Run one setup command with `path` as its PATH. Its output goes to the runner log. A failure
/// says which command failed and why, in the command's own words.
fn run_with_path(
    data_dir: &Path,
    runner: &str,
    executable: &Path,
    args: &[&str],
    path: &OsStr,
    label: &str,
) -> Result<(), String> {
    let output = run_logged(data_dir, runner, executable, args, Some(path))
        .map_err(|error| format!("{label} could not run: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_failure_detail(
            label,
            &output.status.to_string(),
            &output.stdout,
            &output.stderr,
        ))
    }
}

struct LoggedOutput {
    status: std::process::ExitStatus,
    stdout: String,
    stderr: String,
    combined: String,
}

/// Run a setup command, with `path` as its PATH when one is given, and copy the command line and
/// its output to the runner log.
fn run_logged(
    data_dir: &Path,
    runner: &str,
    executable: &Path,
    args: &[&str],
    path: Option<&OsStr>,
) -> std::io::Result<LoggedOutput> {
    append_runner_log(
        data_dir,
        runner,
        &format!("running {} {}", executable.display(), args.join(" ")),
    );
    let mut command = Command::new(executable);
    command.args(args);
    if let Some(path) = path {
        command.env("PATH", path);
    }
    let output = command.output()?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let combined = format_command_output(&stdout, &stderr);
    if !combined.is_empty() {
        append_runner_log(data_dir, runner, &combined);
    }
    Ok(LoggedOutput {
        status: output.status,
        stdout,
        stderr,
        combined,
    })
}

fn homebrew_bin_dirs() -> Vec<PathBuf> {
    HOMEBREW_BIN_DIRS.iter().map(PathBuf::from).collect()
}

/// Where an `omlx` command can be when PATH has none: an installed Homebrew keg that isn't
/// linked, then the oMLX app's CLI (the shim it puts in ~/.omlx/bin, else the one in its bundle).
fn omlx_fallback_commands(
    brew_dir: Option<&Path>,
    homebrew_dirs: &[PathBuf],
    home: Option<&Path>,
) -> Vec<PathBuf> {
    brew_dir
        .into_iter()
        .chain(homebrew_dirs.iter().map(PathBuf::as_path))
        .filter_map(Path::parent)
        .map(|prefix| prefix.join("opt/omlx/bin/omlx"))
        .chain(home.map(|home| home.join(".omlx/bin/omlx")))
        .chain([PathBuf::from(OMLX_APP_CLI)])
        .collect()
}

/// `name` in the directories of `path_var`, in order, then in `fallback_dirs`.
fn find_executable(
    name: &str,
    path_var: Option<&OsStr>,
    fallback_dirs: &[PathBuf],
) -> Option<PathBuf> {
    path_var
        .into_iter()
        .flat_map(std::env::split_paths)
        .chain(fallback_dirs.iter().cloned())
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable_file(candidate))
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(unix)]
    {
        path.metadata()
            .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// PATH for Homebrew's children: brew's own directory, then both Homebrew prefixes, then the
/// inherited PATH, each directory once.
fn homebrew_child_path(
    brew_dir: Option<&Path>,
    homebrew_dirs: &[PathBuf],
    inherited: Option<&OsStr>,
) -> OsString {
    let mut seen = HashSet::new();
    let dirs = brew_dir
        .map(Path::to_path_buf)
        .into_iter()
        .chain(homebrew_dirs.iter().cloned())
        .chain(inherited.into_iter().flat_map(std::env::split_paths))
        .filter(|dir| !dir.as_os_str().is_empty() && seen.insert(dir.clone()))
        .collect::<Vec<_>>();
    std::env::join_paths(dirs)
        .unwrap_or_else(|_| inherited.map(OsStr::to_os_string).unwrap_or_default())
}

/// The most useful line of a failed setup command's output: the last error line on stderr, then
/// on stdout (oMLX's CLI prints its errors there), else stderr's last line, else stdout's.
/// Homebrew reports a failed subcommand as "Error: Failure while executing; `git clone ...`
/// exited with 128." after the subcommand's own error, so a `fatal:` or "Could not resolve host"
/// line wins over that wrapper.
fn command_output_tail(stdout: &str, stderr: &str) -> Option<String> {
    let stderr = output_lines(stderr);
    let stdout = output_lines(stdout);
    fn last_matching<'a>(lines: &[&'a str], matches: fn(&str) -> bool) -> Option<&'a str> {
        lines.iter().rev().copied().find(|line| matches(line))
    }
    let chosen = last_matching(&stderr, is_error_line)
        .or_else(|| last_matching(&stdout, is_error_line))
        .or_else(|| stderr.last().copied())
        .or_else(|| stdout.last().copied())?;
    let line = if is_exit_status_wrapper(chosen) {
        last_matching(&stderr, is_specific_cause)
            .or_else(|| last_matching(&stdout, is_specific_cause))
            .unwrap_or(chosen)
    } else {
        chosen
    };
    if line.chars().count() <= OUTPUT_TAIL_MAX_CHARS {
        return Some(line.to_string());
    }
    let mut shortened = line
        .chars()
        .take(OUTPUT_TAIL_MAX_CHARS - 1)
        .collect::<String>();
    shortened.push('…');
    Some(shortened)
}

fn output_lines(text: &str) -> Vec<&str> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect()
}

/// git's `fatal:`, Homebrew's `Error:` and the `error:` most other tools print.
fn is_error_line(line: &str) -> bool {
    ["fatal:", "Error:", "error:"]
        .iter()
        .any(|prefix| line.starts_with(prefix))
}

/// Homebrew's line for a subcommand that failed: "Failure while executing; `...` exited with N."
fn is_exit_status_wrapper(line: &str) -> bool {
    line.contains("exited with")
}

fn is_specific_cause(line: &str) -> bool {
    !is_exit_status_wrapper(line)
        && (line.starts_with("fatal:") || line.contains("Could not resolve host"))
}

fn command_failure_detail(label: &str, status: &str, stdout: &str, stderr: &str) -> String {
    match command_output_tail(stdout, stderr) {
        Some(tail) => format!("{label} failed: {tail}"),
        None => format!("{label} failed ({status})."),
    }
}

/// Run `omlx start`, which starts oMLX in the background through the app or `brew services`.
fn start_omlx(data_dir: &Path, omlx: &Path, path: &OsStr) -> Result<(), String> {
    let output = run_logged(data_dir, "omlx", omlx, &["start"], Some(path))
        .map_err(|error| format!("omlx start could not run: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(omlx_start_failure_detail(
            omlx,
            &output.status.to_string(),
            &output.stdout,
            &output.stderr,
        ))
    }
}

/// A pip install has no background service: its `omlx start` exits 1 and says "For this install,
/// run foreground server mode with: omlx serve". Say what the user can do about that instead.
fn omlx_start_failure_detail(omlx: &Path, status: &str, stdout: &str, stderr: &str) -> String {
    let wants_foreground = |text: &str| text.contains("foreground") && text.contains("omlx serve");
    if wants_foreground(stdout) || wants_foreground(stderr) {
        format!(
            "oMLX at {} is installed with pip, so it can't run as a background service here. \
Install it with Homebrew (brew install jundot/omlx/omlx) or the oMLX app, or run omlx serve yourself and keep it running.",
            omlx.display()
        )
    } else {
        command_failure_detail("omlx start", status, stdout, stderr)
    }
}

/// vLLM listens on every interface so the Hub container can reach it over the Docker bridge, which
/// put it on the network too; it serves to whoever sends its API key, and nobody else. Ollama has no
/// key to set, so the network guard drops its port instead (`hub_manager::inference_guard`).
fn install_and_start_vllm(data_dir: &Path) -> InferenceRunnerResult {
    if cfg!(target_os = "windows") {
        return skipped(
            "vllm",
            "The native Windows path is not supported; use the WSL2/Linux GPU path.",
        );
    }

    if platform_is_apple_silicon() {
        return skipped("vllm", "Apple Silicon uses oMLX. vLLM is the NVIDIA path.");
    }

    let api_key = match vllm_api_key(data_dir) {
        Ok(key) => key,
        Err(error) => return failed("vllm", error),
    };

    // Answers with no key at all: a vLLM started without one, by an earlier version of this app or
    // by someone else. Ours is restarted with the key. Another one is left as it is, and said so.
    if probe_http(VLLM_PORT, "/v1/models") {
        match existing_runner_pid(data_dir, "vllm") {
            Some(pid) => {
                append_runner_log(
                    data_dir,
                    "vllm",
                    &format!(
                        "restarting vLLM (pid {pid}) with an API key: it answered without one"
                    ),
                );
                if let Err(error) = stop_runner_process(data_dir, "vllm", pid) {
                    return failed("vllm", error);
                }
            }
            None => {
                return success(
                    "vllm",
                    InferenceRunnerState::AlreadyRunning,
                    Some(VLLM_ENDPOINT.to_string()),
                    Some(format!(
                        "A vLLM this app did not start is answering on port {VLLM_PORT} without an API key, so anyone on your network can use it. Restart it with --api-key."
                    )),
                );
            }
        }
    } else if probe_http_authenticated(VLLM_PORT, "/v1/models", Some(&api_key)) {
        return with_api_key(already_running("vllm", VLLM_ENDPOINT), Some(api_key));
    }

    let port = match available_host_port(VLLM_PORT) {
        Some(port) => port,
        None => return failed("vllm", "No local port was available for vLLM.".to_string()),
    };
    let endpoint = host_endpoint(port);

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
        "--api-key".to_string(),
        api_key.clone(),
    ];
    args.extend(extra_args);
    let result = start_host_process(
        data_dir,
        "vllm",
        &executable,
        &args,
        port,
        "/v1/models",
        &endpoint,
        Some(&api_key),
    );
    with_api_key(result, Some(api_key))
}

/// vLLM's API key: made once, kept in the runner state directory where only this user can read it,
/// so a restarted vLLM takes the key the Hub already has.
fn vllm_api_key(data_dir: &Path) -> Result<String, String> {
    let path = runner_state_dir(data_dir).join("vllm.api-key");
    if let Ok(existing) = fs::read_to_string(&path) {
        let existing = existing.trim();
        if existing.len() == 64 && existing.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Ok(existing.to_string());
        }
    }
    let key = random_hex_key()?;
    fs::create_dir_all(runner_state_dir(data_dir))
        .map_err(|error| format!("Could not create the runner state directory: {error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&path)
        .map_err(|error| format!("Could not save the vLLM API key: {error}"))?;
    #[cfg(unix)]
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not protect the vLLM API key: {error}"))?;
    file.write_all(format!("{key}\n").as_bytes())
        .map_err(|error| format!("Could not save the vLLM API key: {error}"))?;
    Ok(key)
}

/// 32 random bytes as hex. vLLM is set up only on Linux, where `/dev/urandom` always exists.
fn random_hex_key() -> Result<String, String> {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    fs::File::open("/dev/urandom")
        .and_then(|mut source| source.read_exact(&mut bytes))
        .map_err(|error| format!("Could not make an API key: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Stop a runner this app started, and forget its pid: SIGTERM, then SIGKILL after 30 s.
fn stop_runner_process(data_dir: &Path, runner: &str, pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(30);
        while process_is_alive(pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));
        }
        if process_is_alive(pid) {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
            thread::sleep(Duration::from_millis(500));
        }
        if process_is_alive(pid) {
            return Err(format!(
                "{runner} (pid {pid}) did not stop, so it could not be restarted with an API key."
            ));
        }
        let _ = fs::remove_file(runner_pid_path(data_dir, runner));
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = (data_dir, pid);
        Err(format!(
            "Restarting {runner} is not supported on this platform."
        ))
    }
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
    for directory in HOMEBREW_BIN_DIRS.iter().chain(&["/usr/bin", "/bin"]) {
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
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    let LoggedOutput {
        status, combined, ..
    } = run_logged(data_dir, runner, executable, &args, None)
        .map_err(|error| format!("Could not run {}: {error}", executable.display()))?;
    if status.success() {
        Ok(combined)
    } else if combined.is_empty() {
        Err(format!("{} exited with {status}.", executable.display()))
    } else {
        Err(format!("{} failed: {}", executable.display(), combined))
    }
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
    // The key lives in its own file, readable by this user alone (`vllm_api_key`).
    let without_keys = results
        .iter()
        .cloned()
        .map(|result| with_api_key(result, None))
        .collect::<Vec<_>>();
    if let Ok(serialized) = serde_json::to_vec_pretty(&without_keys) {
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

    #[cfg(unix)]
    #[test]
    fn the_vllm_key_is_made_once_and_readable_by_this_user_alone() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let key = vllm_api_key(data_dir.path()).expect("key");
        assert_eq!(key.len(), 64);
        assert!(key.bytes().all(|byte| byte.is_ascii_hexdigit()));
        let path = runner_state_dir(data_dir.path()).join("vllm.api-key");
        assert_eq!(
            fs::metadata(&path).expect("stat").permissions().mode() & 0o777,
            0o600
        );
        // A restarted vLLM takes the key the Hub already has.
        assert_eq!(vllm_api_key(data_dir.path()).expect("again"), key);
        // A damaged file is replaced, not trusted.
        fs::write(&path, "not a key").expect("write");
        let replaced = vllm_api_key(data_dir.path()).expect("replaced");
        assert_ne!(replaced, key);
        assert_eq!(replaced.len(), 64);
    }

    #[test]
    fn the_key_goes_to_the_page_but_not_into_the_state_file() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let started = with_api_key(
            success(
                "vllm",
                InferenceRunnerState::InstalledAndStarted,
                Some(VLLM_ENDPOINT.to_string()),
                None,
            ),
            Some("k".repeat(64)),
        );
        let json = serde_json::to_value(&started).expect("json");
        assert_eq!(json["apiKey"], "k".repeat(64));

        persist_results(data_dir.path(), &[started]);
        let written =
            fs::read_to_string(data_dir.path().join(RUNNER_STATE_FILE)).expect("state file");
        assert!(!written.contains(&"k".repeat(64)));
        assert!(!written.contains("apiKey"));

        // No key on a runner that did not start.
        assert_eq!(
            with_api_key(failed("vllm", "no".to_string()), Some("k".repeat(64))).api_key,
            None
        );
        assert_eq!(
            with_api_key(skipped("vllm", "no"), Some("k".repeat(64))).api_key,
            None
        );
    }

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
            "omlx",
            InferenceRunnerState::InstalledAndStarted,
            Some(OMLX_ENDPOINT.to_string()),
            Some("started".to_string()),
        ))
        .expect("result should serialize");
        assert_eq!(json["runner"], "omlx");
        assert_eq!(json["state"], "installed_and_started");
        assert_eq!(json["endpointUrl"], OMLX_ENDPOINT);
        assert_eq!(json["detail"], "started");
    }

    #[test]
    fn redact_args_hides_sensitive_api_key() {
        let args = [
            "serve",
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
            "--api-key",
            "secret",
        ];
        assert_eq!(
            args.join(" "),
            "serve --host 0.0.0.0 --port 8000 --api-key secret"
        );
        assert_eq!(
            redact_args(&args.map(ToString::to_string), Some("secret")).join(" "),
            "serve --host 0.0.0.0 --port 8000 --api-key <redacted>"
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

    #[cfg(unix)]
    fn write_executable(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "#!/bin/sh\n").expect("write test executable");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
        path
    }

    #[cfg(unix)]
    #[test]
    fn finds_brew_on_path_before_the_homebrew_prefixes() {
        let on_path = tempfile::tempdir().expect("tempdir");
        let apple = tempfile::tempdir().expect("tempdir");
        let path_brew = write_executable(on_path.path(), "brew");
        write_executable(apple.path(), "brew");
        let path_var = std::env::join_paths([on_path.path()]).expect("join");

        assert_eq!(
            find_executable("brew", Some(&path_var), &[apple.path().to_path_buf()]),
            Some(path_brew)
        );
    }

    #[cfg(unix)]
    #[test]
    fn finds_brew_in_the_homebrew_prefixes_when_path_is_the_finder_default() {
        let empty = tempfile::tempdir().expect("tempdir");
        let apple = tempfile::tempdir().expect("tempdir");
        let intel = tempfile::tempdir().expect("tempdir");
        let intel_brew = write_executable(intel.path(), "brew");
        let finder_path = std::env::join_paths([empty.path()]).expect("join");
        let prefixes = [apple.path().to_path_buf(), intel.path().to_path_buf()];

        assert_eq!(
            find_executable("brew", Some(&finder_path), &prefixes),
            Some(intel_brew)
        );

        let apple_brew = write_executable(apple.path(), "brew");
        assert_eq!(
            find_executable("brew", Some(&finder_path), &prefixes),
            Some(apple_brew)
        );
    }

    #[cfg(unix)]
    #[test]
    fn missing_or_non_executable_brew_is_not_found() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            find_executable("brew", None, &[dir.path().to_path_buf()]),
            None
        );
        fs::write(dir.path().join("brew"), "not a program").expect("write");
        fs::set_permissions(dir.path().join("brew"), fs::Permissions::from_mode(0o644))
            .expect("chmod");
        assert_eq!(
            find_executable("brew", None, &[dir.path().to_path_buf()]),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn child_path_puts_homebrew_first_and_keeps_each_directory_once() {
        let homebrew = homebrew_bin_dirs();
        let finder_path = OsString::from("/usr/bin:/bin:/usr/sbin:/sbin");
        assert_eq!(
            homebrew_child_path(
                Some(Path::new("/opt/homebrew/bin")),
                &homebrew,
                Some(&finder_path)
            ),
            OsString::from("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
        );

        let shell_path = OsString::from("/usr/local/bin:/Users/me/bin::/usr/bin");
        assert_eq!(
            homebrew_child_path(
                Some(Path::new("/Users/me/brew/bin")),
                &homebrew,
                Some(&shell_path)
            ),
            OsString::from(
                "/Users/me/brew/bin:/opt/homebrew/bin:/usr/local/bin:/Users/me/bin:/usr/bin"
            )
        );

        assert_eq!(
            homebrew_child_path(None, &homebrew, None),
            OsString::from("/opt/homebrew/bin:/usr/local/bin")
        );
    }

    #[cfg(unix)]
    #[test]
    fn omlx_fallbacks_cover_unlinked_kegs_then_the_app_cli() {
        assert_eq!(
            omlx_fallback_commands(
                Some(Path::new("/Users/me/brew/bin")),
                &homebrew_bin_dirs(),
                Some(Path::new("/Users/me"))
            ),
            [
                "/Users/me/brew/opt/omlx/bin/omlx",
                "/opt/homebrew/opt/omlx/bin/omlx",
                "/usr/local/opt/omlx/bin/omlx",
                "/Users/me/.omlx/bin/omlx",
                OMLX_APP_CLI,
            ]
            .map(PathBuf::from)
        );
    }

    #[test]
    fn failure_detail_names_the_unresolved_host_when_a_tap_fails() {
        // Homebrew's order: git's own error first, then Homebrew's wrapper around it.
        let stderr = "==> Tapping jundot/omlx\nCloning into '/opt/homebrew/Library/Taps/jundot/homebrew-omlx'...\n\
fatal: unable to access 'https://github.com/jundot/omlx/': Could not resolve host: github.com\n\
Error: Failure while executing; `git clone https://github.com/jundot/omlx /opt/homebrew/Library/Taps/jundot/homebrew-omlx` exited with 128.\n";
        let expected = "brew tap jundot/omlx failed: fatal: unable to access 'https://github.com/jundot/omlx/': Could not resolve host: github.com";
        assert_eq!(
            command_failure_detail("brew tap jundot/omlx", "exit status: 1", "", stderr),
            expected
        );
        // The same lines the other way round.
        let reversed = stderr.lines().rev().collect::<Vec<_>>().join("\n");
        assert_eq!(
            command_failure_detail("brew tap jundot/omlx", "exit status: 1", "", &reversed),
            expected
        );
        // A download that can't resolve its host has no `fatal:` line.
        let curl = "curl: (6) Could not resolve host: ghcr.io\n\
Error: Failure while executing; `/usr/bin/env /opt/homebrew/Library/Homebrew/shims/shared/curl --location https://ghcr.io/v2/` exited with 6.\n";
        assert_eq!(
            command_failure_detail("brew install jundot/omlx/omlx", "exit status: 1", "", curl),
            "brew install jundot/omlx/omlx failed: curl: (6) Could not resolve host: ghcr.io"
        );
    }

    #[test]
    fn failure_detail_keeps_the_wrapper_when_nothing_more_specific_was_said() {
        let stderr = "==> Fetching jundot/omlx/omlx\n\
Error: Failure while executing; `git fetch origin` exited with 1.\n";
        assert_eq!(
            command_failure_detail("brew install jundot/omlx/omlx", "exit status: 1", "", stderr),
            "brew install jundot/omlx/omlx failed: Error: Failure while executing; `git fetch origin` exited with 1."
        );
    }

    #[test]
    fn failure_detail_prefers_error_lines_on_stderr_then_stdout() {
        assert_eq!(
            command_failure_detail(
                "brew install jundot/omlx/omlx",
                "exit status: 1",
                "error: from stdout\n",
                "Error: from stderr\nWarning: after it\n"
            ),
            "brew install jundot/omlx/omlx failed: Error: from stderr"
        );
        assert_eq!(
            command_failure_detail(
                "omlx start",
                "exit status: 1",
                "starting\nerror: port 8000 is in use\ndone\n",
                "UserWarning: something unrelated\n"
            ),
            "omlx start failed: error: port 8000 is in use"
        );
    }

    #[test]
    fn failure_detail_quotes_an_omlx_cli_error_on_stdout() {
        // oMLX's CLI prints its errors to stdout and leaves stderr empty.
        assert_eq!(
            command_failure_detail(
                "omlx start",
                "exit status: 1",
                "Failed to control oMLX.app: Could not reach oMLX.app control socket: [Errno 2] No such file or directory\n",
                ""
            ),
            "omlx start failed: Failed to control oMLX.app: Could not reach oMLX.app control socket: [Errno 2] No such file or directory"
        );
    }

    #[test]
    fn failure_detail_falls_back_to_the_last_line_then_stdout_then_status() {
        assert_eq!(
            command_failure_detail(
                "brew install jundot/omlx/omlx",
                "exit status: 1",
                "",
                "warning\nno space left\n\n"
            ),
            "brew install jundot/omlx/omlx failed: no space left"
        );
        assert_eq!(
            command_failure_detail(
                "omlx start",
                "exit status: 1",
                "Homebrew is not available on PATH.\n",
                ""
            ),
            "omlx start failed: Homebrew is not available on PATH."
        );
        assert_eq!(
            command_failure_detail("omlx start", "exit status: 1", " \n", ""),
            "omlx start failed (exit status: 1)."
        );
    }

    #[test]
    fn omlx_start_on_a_pip_install_says_how_to_get_a_background_service() {
        // oMLX's `omlx start` for an install that is neither the app nor Homebrew.
        let stdout = "Background start is available for the macOS app and Homebrew installs.\n\
For this install, run foreground server mode with: omlx serve\n";
        assert_eq!(
            omlx_start_failure_detail(
                Path::new("/Users/me/.venv/bin/omlx"),
                "exit status: 1",
                stdout,
                ""
            ),
            "oMLX at /Users/me/.venv/bin/omlx is installed with pip, so it can't run as a background service here. \
Install it with Homebrew (brew install jundot/omlx/omlx) or the oMLX app, or run omlx serve yourself and keep it running."
        );
        assert_eq!(
            omlx_start_failure_detail(
                Path::new("/opt/homebrew/bin/omlx"),
                "exit status: 1",
                "Homebrew is not available on PATH.\n",
                ""
            ),
            "omlx start failed: Homebrew is not available on PATH."
        );
    }

    #[test]
    fn failure_detail_shortens_a_long_line() {
        let long = "x".repeat(OUTPUT_TAIL_MAX_CHARS + 50);
        let tail = command_output_tail("", &long).expect("tail");
        assert_eq!(tail.chars().count(), OUTPUT_TAIL_MAX_CHARS);
        assert!(tail.ends_with('…'));
    }

    #[test]
    fn finds_omlx_settings_where_omlx_keeps_them() {
        let home = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            omlx_settings_path(home.path()),
            home.path().join(".omlx").join("settings.json")
        );

        let bootstrap_dir = home
            .path()
            .join("Library")
            .join("Application Support")
            .join("oMLX");
        fs::create_dir_all(&bootstrap_dir).expect("mkdir");
        fs::write(bootstrap_dir.join("base-path"), "~/Models/omlx\n").expect("write");
        assert_eq!(
            omlx_settings_path(home.path()),
            home.path()
                .join("Models")
                .join("omlx")
                .join("settings.json")
        );

        fs::write(bootstrap_dir.join("base-path"), "/Volumes/External/omlx").expect("write");
        assert_eq!(
            omlx_settings_path(home.path()),
            Path::new("/Volumes/External/omlx").join("settings.json")
        );
    }

    #[test]
    fn reads_the_key_omlx_has_and_nothing_else() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        assert_eq!(read_omlx_api_key(&path), None);

        fs::write(&path, r#"{"auth": {"api_key": null}}"#).expect("write");
        assert_eq!(read_omlx_api_key(&path), None);
        fs::write(&path, r#"{"auth": {"api_key": "   "}}"#).expect("write");
        assert_eq!(read_omlx_api_key(&path), None);
        fs::write(&path, "not json").expect("write");
        assert_eq!(read_omlx_api_key(&path), None);

        fs::write(&path, r#"{"auth": {"api_key": " their-key "}}"#).expect("write");
        assert_eq!(read_omlx_api_key(&path), Some("their-key".to_string()));
    }

    #[test]
    fn generated_keys_are_ones_omlx_accepts_and_never_repeat() {
        let first = generate_omlx_api_key();
        let second = generate_omlx_api_key();
        assert_ne!(first, second);
        assert!(first.len() >= 32);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_graphic() && !c.is_whitespace()));
    }

    #[test]
    fn sets_the_first_key_with_the_body_omlx_setup_expects() {
        assert_eq!(
            omlx_setup_api_key_body("ci-hub-abc"),
            serde_json::json!({"api_key": "ci-hub-abc", "api_key_confirm": "ci-hub-abc"})
        );
        assert_eq!(
            omlx_open_inference_body(),
            serde_json::json!({"allow_unauthenticated_inference": true})
        );
    }

    #[test]
    fn says_omlx_already_has_a_key_when_setup_answers_400_for_that() {
        let refusal = omlx_setup_refusal(
            400,
            r#"{"detail": "API key is already configured. Use settings to change it."}"#,
        );
        assert!(refusal.starts_with("oMLX already has an API key"));
        assert!(refusal.contains("Settings > AI"));
    }

    #[test]
    fn passes_on_other_400s_in_omlx_words() {
        assert_eq!(
            omlx_setup_refusal(
                400,
                r#"{"detail": "API key must be at least 4 characters"}"#
            ),
            "oMLX refused the new API key: API key must be at least 4 characters"
        );
    }

    #[test]
    fn says_setup_needs_loopback_when_omlx_answers_403() {
        let refusal = omlx_setup_refusal(
            403,
            r#"{"detail": "Initial API key setup is only available over loopback."}"#,
        );
        assert!(refusal.contains("127.0.0.1"));
        assert!(refusal.contains("Settings > AI"));
    }

    #[test]
    fn names_the_status_of_any_other_answer() {
        assert_eq!(
            omlx_setup_refusal(503, r#"{"detail": "Server not initialized"}"#),
            "oMLX answered HTTP 503 when the Hub set its API key: Server not initialized"
        );
        assert_eq!(
            omlx_setup_refusal(502, "  Bad Gateway \n"),
            "oMLX answered HTTP 502 when the Hub set its API key: Bad Gateway"
        );
        assert_eq!(
            omlx_setup_refusal(500, ""),
            "oMLX answered HTTP 500 when the Hub set its API key."
        );
    }

    #[test]
    fn warns_when_omlx_takes_the_key_but_not_the_open_v1_setting() {
        let refused = omlx_open_inference_failure(Some(401), r#"{"detail": "Invalid API key"}"#);
        assert!(refused.starts_with("oMLX now has an API key, but it did not keep /v1 open"));
        assert!(refused.contains("(HTTP 401: Invalid API key)"));
        assert!(refused.contains("Allow inference without API key"));

        let unreachable = omlx_open_inference_failure(None, "connection refused");
        assert!(unreachable.contains("(connection refused)"));
    }

    #[test]
    fn hands_a_set_up_key_to_the_frontend_and_keeps_it_out_of_debug() {
        let setup = OmlxAdminKeySetup {
            api_key: RunnerApiKey("ci-hub-secret".to_string()),
            warning: None,
        };
        assert_eq!(
            serde_json::to_value(&setup).expect("serialize"),
            serde_json::json!({"apiKey": "ci-hub-secret"})
        );
        assert!(!format!("{setup:?}").contains("ci-hub-secret"));
        assert_eq!(
            serde_json::to_value(OmlxAdminKeyStatus { key_set: true }).expect("serialize"),
            serde_json::json!({"keySet": true})
        );
    }

    #[test]
    fn sets_no_key_off_apple_silicon() {
        if !platform_is_apple_silicon() {
            let data_dir = tempfile::tempdir().expect("tempdir");
            assert_eq!(
                setup_omlx_admin_key(data_dir.path()),
                Err("oMLX runs only on Apple Silicon.".to_string())
            );
        }
    }

    #[test]
    fn hands_the_key_to_the_frontend_but_never_to_logs_or_the_state_file() {
        let result = with_api_key(
            success(
                "omlx",
                InferenceRunnerState::InstalledAndStarted,
                Some(OMLX_ENDPOINT.to_string()),
                Some("started".to_string()),
            ),
            Some("ci-hub-secret".to_string()),
        );

        let json = serde_json::to_value(&result).expect("serialize");
        assert_eq!(json["apiKey"], "ci-hub-secret");
        assert!(!format!("{result:?}").contains("ci-hub-secret"));

        let data_dir = tempfile::tempdir().expect("tempdir");
        persist_results(data_dir.path(), &[result]);
        let persisted =
            fs::read_to_string(data_dir.path().join(RUNNER_STATE_FILE)).expect("read state");
        assert!(!persisted.contains("ci-hub-secret"));
        assert!(!persisted.contains("apiKey"));
    }

    #[test]
    fn says_a_working_runner_warning_apart_from_its_detail() {
        let mut result = success(
            "omlx",
            InferenceRunnerState::InstalledAndStarted,
            Some(OMLX_ENDPOINT.to_string()),
            Some("oMLX was installed and started.".to_string()),
        );
        assert!(serde_json::to_value(&result)
            .expect("serialize")
            .get("warning")
            .is_none());

        result.warning = Some("The Hub could not give oMLX an API key".to_string());
        assert_eq!(
            serde_json::to_value(&result).expect("serialize")["warning"],
            "The Hub could not give oMLX an API key"
        );
    }

    #[test]
    fn platform_gate_keeps_mlx_runners_off_non_apple_builds() {
        if !platform_is_apple_silicon() {
            let result = install_and_start_omlx(Path::new("/tmp/ci-hub-inference-runner-test"));
            assert_eq!(result.state, InferenceRunnerState::Skipped);
        }
    }
}
