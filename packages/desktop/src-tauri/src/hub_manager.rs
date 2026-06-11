use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Maximum number of start attempts (1 initial + 2 retries with exponential
/// backoff of 2 s then 4 s).  `start_hub` / `start_hub_inner` are blocking
/// functions — callers from async contexts should use `spawn_blocking`.
const MAX_START_RETRIES: u32 = 3;

/// Global guard: true while a `start_hub` call is in progress.
static START_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// `(hub .env mtime, is_private_vpn)` — avoids parsing the env file on every hub status poll (~3s).
static PRIVATE_VPN_ENV_CACHE: Mutex<Option<(Option<std::time::SystemTime>, bool)>> =
    Mutex::new(None);

/// After the hub container is healthy and the Tailscale sidecar has been verified once, keep inspecting it
/// until this grace elapses; then skip docker inspect on steady-state polls.
const VPN_SIDECARS_STATUS_POLL_GRACE: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Copy)]
enum VpnSidecarPollPhase {
    /// Hub reports healthy but `hub-tailscale` has not yet passed [`vpn_sidecars_ready`] in this cycle.
    PendingReady,
    /// Sidecar was ready at least once at `verified_at`.
    VerifiedSince(Instant),
}

static VPN_SIDECAR_STATUS_POLL_PHASE: Mutex<VpnSidecarPollPhase> =
    Mutex::new(VpnSidecarPollPhase::PendingReady);

/// Serialize rotation + append so concurrent callers cannot interleave
/// renames and writes to `desktop.log`.
static LOG_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Acquire a mutex guard, recovering the inner value if the lock was poisoned by
/// a panic in another thread. These mutexes guard short-lived cache/status/log
/// state where continuing with the existing value is safe and strictly better
/// than propagating a poison panic. This matters now that the release profile
/// unwinds panics (rather than aborting): a panic while a lock was held would
/// otherwise turn every later `.lock().unwrap()` on the hot status-polling path
/// into a fresh panic.
fn lock_recovering<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

const MAX_COMMAND_OUTPUT_CHARS: usize = 50_000;
const DESKTOP_LOG_FILENAME: &str = "desktop.log";
const DEFAULT_DEV_PUBLIC_DOMAIN: &str = "companionintelligence.com";
const DEFAULT_PROD_PUBLIC_DOMAIN: &str = "companionintelligence.org";
const DEFAULT_DEV_CI_CLOUD_URL: &str = "https://hub.companionintelligence.com";
const DEFAULT_PROD_CI_CLOUD_URL: &str = "https://hub.ci.computer";
#[cfg(target_os = "windows")]
const HUB_ENV_FILENAME: &str = ".env";
#[cfg(not(target_os = "windows"))]
const HUB_ENV_FILENAME: &str = ".env.dev";
#[cfg(target_os = "windows")]
const COMPAT_HUB_ENV_FILENAME: &str = ".env.dev";
#[cfg(not(target_os = "windows"))]
const COMPAT_HUB_ENV_FILENAME: &str = ".env";
pub const HUB_COMPOSE_FILENAME: &str = "docker-compose.prod.yml";
/// Maximum size of desktop.log before rotation (5 MB).
const MAX_LOG_SIZE_BYTES: u64 = 5 * 1024 * 1024;
/// Number of rotated log files to keep (desktop.log.1, desktop.log.2, ...).
const MAX_LOG_ROTATIONS: usize = 3;
const MANAGED_APP_CONTAINER_LABEL_FILTER: &str = "label=ci-os-hub.managed=true";
const MANAGED_APP_CONTAINER_URN_FILTER: &str = "label=ci-os-hub.appurn";
const DEFAULT_TRAEFIK_ACME_EMAIL: &str = "admin@example.com";
const TRAEFIK_ACME_DEFAULT_CONTENT: &str = "{}";
const TRAEFIK_CONFIG_SEED: &str = include_str!("../../../backend/assets/traefik/traefik.yml");
const TRAEFIK_DYNAMIC_CONFIG_SEED: &str =
    include_str!("../../../backend/assets/traefik/dynamic/dynamic.yml");
const TRAEFIK_RECREATE_MARKER_FILENAME: &str = ".traefik-recreate-required";
const TRAEFIK_STATE_DIR: &str = "state/traefik";
const TRAEFIK_CONFIG_DIR: &str = "state/traefik/config";
const TRAEFIK_DYNAMIC_DIR: &str = "state/traefik/dynamic";
const TRAEFIK_TLS_DIR: &str = "state/traefik/tls";
const TRAEFIK_CONFIG_FILE: &str = "state/traefik/config/traefik.yml";
const TRAEFIK_DYNAMIC_FILE: &str = "state/traefik/dynamic/dynamic.yml";
const TRAEFIK_ACME_FILE: &str = "state/traefik/acme_storage.json";
const HUB_DOCKER_CONFIG_FILE: &str = ".docker/config.json";
const LEGACY_DOCKER_CONFIG_PATHS: &[&str] = &["docker-config.json", ".internal/docker-config.json"];
const HUB_START_HEALTHY_TIMEOUT_SECS: u64 = 180;
const DB_START_HEALTHY_TIMEOUT_SECS: u64 = 180;

pub(crate) fn default_public_domain() -> &'static str {
    match option_env!("CI_HUB_ENVIRONMENT") {
        Some("production") => DEFAULT_PROD_PUBLIC_DOMAIN,
        _ => DEFAULT_DEV_PUBLIC_DOMAIN,
    }
}

pub(crate) fn default_ci_cloud_url() -> &'static str {
    match option_env!("CI_HUB_ENVIRONMENT") {
        Some("production") => DEFAULT_PROD_CI_CLOUD_URL,
        _ => DEFAULT_DEV_CI_CLOUD_URL,
    }
}

#[cfg(target_os = "windows")]
const DOCKER_DESKTOP_WINDOWS_INSTALLER_URL: &str =
    "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
#[cfg(target_os = "macos")]
const DOCKER_DESKTOP_MACOS_INTEL_URL: &str = "https://desktop.docker.com/mac/main/amd64/Docker.dmg";
#[cfg(target_os = "macos")]
const DOCKER_DESKTOP_MACOS_ARM_URL: &str = "https://desktop.docker.com/mac/main/arm64/Docker.dmg";

#[cfg(target_os = "windows")]
const OLLAMA_WINDOWS_INSTALLER_URL: &str = "https://ollama.com/download/OllamaSetup.exe";
// Universal binary (arm64 + x86_64) — one zip for all Macs.
#[cfg(target_os = "macos")]
const OLLAMA_MACOS_ZIP_URL: &str = "https://ollama.com/download/Ollama-darwin.zip";

fn base_docker_command() -> Command {
    let docker_path = find_docker_binary();
    let mut cmd = Command::new(docker_path);
    // Ensure common binary paths are in PATH for subprocesses (e.g. docker compose)
    if let Ok(current_path) = std::env::var("PATH") {
        let extra_paths = if cfg!(target_os = "macos") {
            "/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin"
        } else if cfg!(target_os = "windows") {
            ""
        } else {
            "/usr/local/bin:/usr/bin"
        };
        if !extra_paths.is_empty() {
            cmd.env("PATH", format!("{}:{}", extra_paths, current_path));
        }
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

pub fn docker_command() -> Command {
    let mut cmd = base_docker_command();
    if let Some(docker_host) = preferred_docker_host() {
        cmd.env("DOCKER_HOST", docker_host);
    }
    cmd
}

fn command_on_path(binary: &str) -> Option<PathBuf> {
    let locator = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let mut command = Command::new(locator);
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    command
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
        })
}

fn refresh_nvidia_host_probe_cache(data_dir: &Path) {
    let probe_path = data_dir.join("state/hardware/nvidia.json");
    if let Some(parent) = probe_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let clear_stale_probe = || {
        let _ = std::fs::remove_file(&probe_path);
    };

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("powershell.exe");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg("$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1 Name,AdapterRAM,DriverVersion; if ($null -eq $gpu) { exit 3 }; $gpu | ConvertTo-Json -Compress");

        let output = match command.output() {
            Ok(value) => value,
            Err(error) => {
                clear_stale_probe();
                let _ = append_desktop_log_for(
                    data_dir,
                    "gpu.probe",
                    &format!(
                        "Skipping Windows NVIDIA probe cache refresh (PowerShell unavailable): {}",
                        error
                    ),
                );
                return;
            }
        };

        if !output.status.success() {
            clear_stale_probe();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let details = if stderr.is_empty() {
                "No NVIDIA GPU found via Windows WMI; host NVIDIA probe cache cleared.".to_string()
            } else {
                format!("Windows NVIDIA probe command failed: {}", stderr)
            };
            let _ = append_desktop_log_for(data_dir, "gpu.probe", &details);
            return;
        }

        let raw_json = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let parsed: serde_json::Value = match serde_json::from_str(&raw_json) {
            Ok(value) => value,
            Err(error) => {
                clear_stale_probe();
                let _ = append_desktop_log_for(
                    data_dir,
                    "gpu.probe",
                    &format!("Failed to parse Windows NVIDIA probe output: {}", error),
                );
                return;
            }
        };

        let model = parsed
            .get("Name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if model.is_empty() {
            clear_stale_probe();
            let _ = append_desktop_log_for(
                data_dir,
                "gpu.probe",
                "Windows NVIDIA probe output missing adapter name; host cache not updated.",
            );
            return;
        }

        let vram_mb = parsed
            .get("AdapterRAM")
            .and_then(|value| value.as_u64())
            .map(|bytes| bytes / (1024 * 1024))
            .unwrap_or(0);
        let driver_version = parsed
            .get("DriverVersion")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        let payload = serde_json::json!({
            "model": model,
            "vramMb": vram_mb,
            "driverVersion": driver_version,
            "source": "desktop-host-windows-wmi"
        });

        let serialized = match serde_json::to_string_pretty(&payload) {
            Ok(value) => format!("{}\n", value),
            Err(error) => {
                clear_stale_probe();
                let _ = append_desktop_log_for(
                    data_dir,
                    "gpu.probe",
                    &format!("Failed to serialize Windows NVIDIA probe cache: {}", error),
                );
                return;
            }
        };

        match std::fs::write(&probe_path, serialized) {
            Ok(_) => {
                let _ = append_desktop_log_for(
                    data_dir,
                    "gpu.probe",
                    &format!(
                        "Updated Windows host NVIDIA probe cache at {}",
                        probe_path.display()
                    ),
                );
            }
            Err(error) => {
                let _ = append_desktop_log_for(
                    data_dir,
                    "gpu.probe",
                    &format!(
                        "Failed to write Windows host NVIDIA probe cache at {}: {}",
                        probe_path.display(),
                        error
                    ),
                );
            }
        }

        return;
    }

    #[cfg(target_os = "macos")]
    {
        clear_stale_probe();
        return;
    }

    #[cfg(target_os = "linux")]
    {
        let output = Command::new("sh")
        .arg("-lc")
        .arg("nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits | head -n 1")
        .output();

        let output = match output {
            Ok(value) => value,
            Err(error) => {
                clear_stale_probe();
                let _ = append_desktop_log_for(
                    data_dir,
                    "gpu.probe",
                    &format!(
                        "Skipping host NVIDIA probe cache refresh (nvidia-smi unavailable): {}",
                        error
                    ),
                );
                return;
            }
        };

        if !output.status.success() {
            clear_stale_probe();
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let details = if stderr.is_empty() {
                "nvidia-smi command failed".to_string()
            } else {
                format!("nvidia-smi command failed: {}", stderr)
            };
            let _ = append_desktop_log_for(data_dir, "gpu.probe", &details);
            return;
        }

        let first_line = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("")
            .to_string();
        if first_line.is_empty() {
            clear_stale_probe();
            let _ = append_desktop_log_for(
                data_dir,
                "gpu.probe",
                "nvidia-smi produced no GPU rows; host NVIDIA probe cache not updated.",
            );
            return;
        }

        let mut parts = first_line.split(',').map(str::trim);
        let model = parts.next().unwrap_or_default().to_string();
        let vram_mb = parts
            .next()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let driver_version = parts.next().unwrap_or_default().to_string();

        if model.is_empty() {
            clear_stale_probe();
            let _ = append_desktop_log_for(
                data_dir,
                "gpu.probe",
                "nvidia-smi probe row did not include a GPU model; host cache not updated.",
            );
            return;
        }

        let payload = serde_json::json!({
            "model": model,
            "vramMb": vram_mb,
            "driverVersion": driver_version,
            "source": "desktop-host-nvidia-smi"
        });

        let serialized = match serde_json::to_string_pretty(&payload) {
            Ok(value) => format!("{}\n", value),
            Err(error) => {
                let _ = append_desktop_log_for(
                    data_dir,
                    "gpu.probe",
                    &format!("Failed to serialize host NVIDIA probe cache: {}", error),
                );
                return;
            }
        };

        match std::fs::write(&probe_path, serialized) {
            Ok(_) => {
                let _ = append_desktop_log_for(
                    data_dir,
                    "gpu.probe",
                    &format!(
                        "Updated host NVIDIA probe cache at {}",
                        probe_path.display()
                    ),
                );
            }
            Err(error) => {
                let _ = append_desktop_log_for(
                    data_dir,
                    "gpu.probe",
                    &format!(
                        "Failed to write host NVIDIA probe cache at {}: {}",
                        probe_path.display(),
                        error
                    ),
                );
            }
        }
    }
}

/// Parse primary macOS system volume disk usage via `df -k /`.
#[cfg(target_os = "macos")]
const DARWIN_DATA_MOUNT: &str = "/System/Volumes/Data";

#[cfg(target_os = "macos")]
fn detect_macos_primary_disk_from_storage_profiler() -> Option<(u64, u64, String)> {
    let output = Command::new("system_profiler")
        .args(["SPStorageDataType", "-json"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let volumes = parsed.get("SPStorageDataType")?.as_array()?;

    let data_vol = volumes
        .iter()
        .find(|entry| entry.get("mount_point").and_then(|v| v.as_str()) == Some(DARWIN_DATA_MOUNT))
        .or_else(|| {
            volumes
                .iter()
                .find(|entry| entry.get("_name").and_then(|v| v.as_str()) == Some("Macintosh HD"))
        })
        .or_else(|| {
            volumes
                .iter()
                .find(|entry| entry.get("mount_point").and_then(|v| v.as_str()) == Some("/"))
        })?;

    let size_bytes = data_vol.get("size_in_bytes")?.as_u64()?;
    if size_bytes == 0 {
        return None;
    }
    let free_bytes = data_vol
        .get("free_space_in_bytes")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let used_bytes = size_bytes.saturating_sub(free_bytes);
    let mount = data_vol
        .get("mount_point")
        .and_then(|v| v.as_str())
        .unwrap_or(DARWIN_DATA_MOUNT)
        .to_string();

    Some((
        size_bytes / 1_000_000_000,
        used_bytes / 1_000_000_000,
        mount,
    ))
}

#[cfg(target_os = "macos")]
fn detect_macos_primary_disk_from_df(mount: &str) -> Option<(u64, u64, String)> {
    let output = Command::new("df").args(["-k", mount]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout)
        .lines()
        .nth(1)?
        .to_string();
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 6 {
        return None;
    }
    let total_kb: u64 = fields.get(1).and_then(|v| v.parse().ok())?;
    let used_kb: u64 = fields.get(2).and_then(|v| v.parse().ok())?;
    if total_kb == 0 {
        return None;
    }
    let mount_point = fields.last().copied().unwrap_or(mount).to_string();
    Some((total_kb / 1024 / 1024, used_kb / 1024 / 1024, mount_point))
}

#[cfg(target_os = "macos")]
fn detect_macos_primary_disk_gb() -> (u64, u64, String) {
    detect_macos_primary_disk_from_storage_profiler()
        .or_else(|| detect_macos_primary_disk_from_df(DARWIN_DATA_MOUNT))
        .or_else(|| detect_macos_primary_disk_from_df("/"))
        .unwrap_or((0, 0, "/".to_string()))
}

#[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
fn write_host_metrics_probe_file(data_dir: &Path, payload: serde_json::Value, log_tag: &str) {
    let probe_path = data_dir.join("state/hardware/host_metrics.json");
    if let Some(parent) = probe_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let serialized = match serde_json::to_string_pretty(&payload) {
        Ok(value) => format!("{}\n", value),
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                log_tag,
                &format!("Failed to serialize host_metrics.json: {}", error),
            );
            return;
        }
    };
    match std::fs::write(&probe_path, serialized) {
        Ok(_) => {
            let _ = append_desktop_log_for(
                data_dir,
                log_tag,
                &format!("Updated host metrics probe at {}", probe_path.display()),
            );
        }
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                log_tag,
                &format!(
                    "Failed to write host metrics probe at {}: {}",
                    probe_path.display(),
                    error
                ),
            );
        }
    }
}

/// Probe Windows host RAM and system disk via WMI and write host_metrics.json.
#[cfg(target_os = "windows")]
fn refresh_windows_host_metrics_probe_cache(data_dir: &Path) {
    let mut command = Command::new("powershell.exe");
    command
        .creation_flags(CREATE_NO_WINDOW)
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg("$os = Get-CimInstance Win32_OperatingSystem; $disk = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='C:'\"; $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1; [PSCustomObject]@{ TotalRamMb = [math]::Round($os.TotalVisibleMemorySize/1024); AvailableRamMb = [math]::Round($os.FreePhysicalMemory/1024); CpuCores = ($cpu.NumberOfLogicalProcessors); CpuModel = $cpu.Name; DiskTotalGb = [math]::Round($disk.Size/1GB); DiskFreeGb = [math]::Round($disk.FreeSpace/1GB); DiskMount = 'C:' } | ConvertTo-Json -Compress");

    let output = match command.output() {
        Ok(value) => value,
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                "hw.probe",
                &format!(
                    "Windows host metrics probe failed to start PowerShell: {}",
                    error
                ),
            );
            return;
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let _ = append_desktop_log_for(
            data_dir,
            "hw.probe",
            &format!("Windows host metrics probe command failed: {}", stderr),
        );
        return;
    }

    let parsed: serde_json::Value =
        match serde_json::from_str(String::from_utf8_lossy(&output.stdout).trim()) {
            Ok(value) => value,
            Err(error) => {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hw.probe",
                    &format!(
                        "Failed to parse Windows host metrics probe output: {}",
                        error
                    ),
                );
                return;
            }
        };

    let total_ram_mb = parsed
        .get("TotalRamMb")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if total_ram_mb == 0 {
        return;
    }

    let available_ram_mb = parsed
        .get("AvailableRamMb")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cpu_cores = parsed.get("CpuCores").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let cpu_model = parsed
        .get("CpuModel")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let disk_total_gb = parsed
        .get("DiskTotalGb")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let disk_free_gb = parsed
        .get("DiskFreeGb")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let disk_mount = parsed
        .get("DiskMount")
        .and_then(|v| v.as_str())
        .unwrap_or("C:")
        .to_string();
    let cpu_arch = if std::env::consts::ARCH == "aarch64" {
        "arm64"
    } else {
        "x86_64"
    };

    let payload = serde_json::json!({
        "schemaVersion": 1,
        "platform": "win32",
        "cpuArch": cpu_arch,
        "source": "desktop-host-windows",
        "probedAt": chrono::Utc::now().to_rfc3339(),
        "host": {
            "totalRamMb": total_ram_mb,
            "availableRamMb": available_ram_mb,
            "cpuCores": cpu_cores,
            "cpuModel": cpu_model,
            "diskTotalGb": disk_total_gb,
            "diskUsedGb": disk_total_gb.saturating_sub(disk_free_gb),
            "diskMount": disk_mount
        }
    });

    write_host_metrics_probe_file(data_dir, payload, "hw.probe");
}

#[cfg(not(target_os = "windows"))]
fn refresh_windows_host_metrics_probe_cache(_data_dir: &Path) {}

/// Parse a macOS memory string like "96 GB", "512 MB", or "2 TB" into megabytes.
#[cfg(target_os = "macos")]
fn parse_memory_str_to_mb(s: &str) -> u64 {
    let mut parts = s.trim().splitn(2, ' ');
    let amount: u64 = match parts.next().and_then(|p| p.parse().ok()) {
        Some(v) => v,
        None => return 0,
    };
    match parts.next().map(|p| p.trim().to_uppercase()).as_deref() {
        Some("TB") => amount * 1024 * 1024,
        Some("GB") => amount * 1024,
        Some("MB") => amount,
        _ => 0,
    }
}

/// Parse a macOS processor count string.
/// Handles "proc 24:16:8" (total:performance:efficiency) or plain "8".
#[cfg(target_os = "macos")]
fn parse_processor_count(s: &str) -> u32 {
    let s = s.trim();
    let numeric_part = s
        .strip_prefix("proc ")
        .and_then(|rest| rest.split(':').next())
        .unwrap_or(s);
    numeric_part.trim().parse().unwrap_or(0)
}

/// Get available RAM in MB on macOS by parsing vm_stat output.
#[cfg(target_os = "macos")]
fn detect_available_ram_mb_macos() -> u64 {
    let output = match Command::new("vm_stat").output() {
        Ok(o) => o,
        Err(_) => return 0,
    };
    let text = String::from_utf8_lossy(&output.stdout);

    // Extract page size from header line:
    // "Mach Virtual Memory Statistics: (page size of 16384 bytes)"
    let page_size: u64 = text
        .lines()
        .find(|l| l.contains("page size of"))
        .and_then(|l| {
            l.split_whitespace()
                .skip_while(|&w| w != "of")
                .nth(1)
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or(4096);

    let mut free_pages: u64 = 0;
    let mut inactive_pages: u64 = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("Pages free:") {
            free_pages = line
                .rsplit(':')
                .next()
                .map(|s| s.trim().trim_end_matches('.'))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        } else if line.starts_with("Pages inactive:") {
            inactive_pages = line
                .rsplit(':')
                .next()
                .map(|s| s.trim().trim_end_matches('.'))
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        }
    }

    (free_pages + inactive_pages) * page_size / (1024 * 1024)
}

/// Detect host macOS hardware (RAM, CPU) and write to state/hardware/host_system.json
/// so the backend container can read the true host hardware instead of Docker VM values.
/// On non-macOS platforms this is a no-op (the probe file is simply never created).
#[cfg(target_os = "macos")]
fn refresh_macos_host_probe_cache(data_dir: &Path) {
    let probe_path = data_dir.join("state/hardware/host_system.json");
    if let Some(parent) = probe_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Query hardware data via system_profiler
    let hw_output = Command::new("system_profiler")
        .args(["SPHardwareDataType", "-json"])
        .output();

    let hw_json = match hw_output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).to_string()
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let _ = append_desktop_log_for(
                data_dir,
                "hw.probe",
                &format!("system_profiler SPHardwareDataType failed: {}", stderr),
            );
            return;
        }
        Err(e) => {
            let _ = append_desktop_log_for(
                data_dir,
                "hw.probe",
                &format!("Failed to run system_profiler: {}", e),
            );
            return;
        }
    };

    let hw_data: serde_json::Value = match serde_json::from_str(&hw_json) {
        Ok(v) => v,
        Err(e) => {
            let _ = append_desktop_log_for(
                data_dir,
                "hw.probe",
                &format!(
                    "Failed to parse system_profiler SPHardwareDataType output: {}",
                    e
                ),
            );
            return;
        }
    };

    let hw_info = match hw_data
        .get("SPHardwareDataType")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
    {
        Some(v) => v.clone(),
        None => {
            let _ = append_desktop_log_for(
                data_dir,
                "hw.probe",
                "No hardware data found in system_profiler SPHardwareDataType output",
            );
            return;
        }
    };

    // Parse physical memory: "96 GB" → 98304 MB
    let ram_str = hw_info
        .get("physical_memory")
        .and_then(|v| v.as_str())
        .unwrap_or("0 GB");
    let total_ram_mb = parse_memory_str_to_mb(ram_str);

    if total_ram_mb == 0 {
        let _ = append_desktop_log_for(
            data_dir,
            "hw.probe",
            &format!(
                "macOS host probe: could not parse RAM from physical_memory='{}'",
                ram_str
            ),
        );
        return;
    }

    // Parse CPU model (Apple Silicon: "Apple M2 Ultra"; Intel: "Intel Core i9")
    let cpu_model = hw_info
        .get("cpu_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // Apple Silicon chips have "Apple" prefix in cpu_type
    let is_apple_silicon = cpu_model.starts_with("Apple");

    // CPU architecture: on Apple Silicon, the Tauri binary is native aarch64
    let cpu_arch = if std::env::consts::ARCH == "aarch64" {
        "arm64"
    } else {
        "x86_64"
    };

    // Parse total core count from "proc 24:16:8" or plain "8"
    let cpu_cores = hw_info
        .get("number_processors")
        .and_then(|v| v.as_str())
        .map(parse_processor_count)
        .unwrap_or(0);

    // Estimate available RAM via vm_stat (free + inactive pages)
    let available_ram_mb = detect_available_ram_mb_macos();
    let effective_available_mb = if available_ram_mb > 0 && available_ram_mb <= total_ram_mb {
        available_ram_mb
    } else {
        // Fallback: assume ~85 % available if vm_stat is unavailable
        total_ram_mb * 85 / 100
    };

    let mut payload = serde_json::json!({
        "platform": "darwin",
        "cpuArch": cpu_arch,
        "cpuModel": cpu_model,
        "cpuCores": cpu_cores,
        "totalRamMb": total_ram_mb,
        "availableRamMb": effective_available_mb,
        "isAppleSilicon": is_apple_silicon,
        "source": "desktop-host-macos-system-profiler"
    });

    let (disk_total_gb, disk_used_gb, disk_mount) = detect_macos_primary_disk_gb();
    if disk_total_gb > 0 {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("diskTotalGb".to_string(), serde_json::json!(disk_total_gb));
            obj.insert("diskUsedGb".to_string(), serde_json::json!(disk_used_gb));
            obj.insert("diskMount".to_string(), serde_json::json!(disk_mount));
        }
    }

    let serialized = match serde_json::to_string_pretty(&payload) {
        Ok(v) => format!("{}\n", v),
        Err(e) => {
            let _ = append_desktop_log_for(
                data_dir,
                "hw.probe",
                &format!("Failed to serialize macOS host probe: {}", e),
            );
            return;
        }
    };

    match std::fs::write(&probe_path, serialized) {
        Ok(_) => {
            let host_metrics = serde_json::json!({
                "schemaVersion": 1,
                "platform": "darwin",
                "cpuArch": cpu_arch,
                "source": "desktop-host-macos",
                "probedAt": chrono::Utc::now().to_rfc3339(),
                "host": {
                    "totalRamMb": total_ram_mb,
                    "availableRamMb": effective_available_mb,
                    "cpuCores": cpu_cores,
                    "cpuModel": cpu_model,
                    "diskTotalGb": disk_total_gb,
                    "diskUsedGb": disk_used_gb,
                    "diskMount": disk_mount
                }
            });
            write_host_metrics_probe_file(data_dir, host_metrics, "hw.probe");

            let _ = append_desktop_log_for(
                data_dir,
                "hw.probe",
                &format!(
                    "Updated macOS host probe at {} ({} MB RAM, {}, isAppleSilicon={})",
                    probe_path.display(),
                    total_ram_mb,
                    cpu_model,
                    is_apple_silicon
                ),
            );
        }
        Err(e) => {
            let _ = append_desktop_log_for(
                data_dir,
                "hw.probe",
                &format!(
                    "Failed to write macOS host probe at {}: {}",
                    probe_path.display(),
                    e
                ),
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn refresh_macos_host_probe_cache(_data_dir: &Path) {
    // No-op on non-macOS platforms.
}

/// On Linux the Tauri binary runs directly on the host, so `/proc/meminfo` and
/// `/proc/cpuinfo` reflect true host hardware (not Docker Desktop VM limits).
/// Write `host_metrics.json` so the backend container uses host RAM and CPU values.
#[cfg(target_os = "linux")]
fn refresh_linux_host_metrics_probe_cache(data_dir: &Path) {
    let total_ram_mb = read_proc_meminfo_kb("MemTotal").unwrap_or(0) / 1024;
    let available_ram_mb = read_proc_meminfo_kb("MemAvailable").unwrap_or(0) / 1024;

    if total_ram_mb == 0 {
        let _ = append_desktop_log_for(
            data_dir,
            "hw.probe",
            "Linux host probe: could not read MemTotal from /proc/meminfo",
        );
        return;
    }

    let (cpu_model, cpu_cores) = read_linux_cpu_info();
    let cpu_arch = if std::env::consts::ARCH == "aarch64" {
        "arm64"
    } else {
        "x86_64"
    };

    let (disk_total_gb, disk_used_gb, disk_mount) = linux_primary_disk_gb(data_dir);

    let probed_at = chrono::Utc::now().to_rfc3339();
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "platform": "linux",
        "cpuArch": cpu_arch,
        "source": "desktop-host-linux",
        "probedAt": probed_at,
        "host": {
            "totalRamMb": total_ram_mb,
            "availableRamMb": available_ram_mb,
            "cpuCores": cpu_cores,
            "cpuModel": cpu_model,
            "diskTotalGb": disk_total_gb,
            "diskUsedGb": disk_used_gb,
            "diskMount": disk_mount
        }
    });

    write_host_metrics_probe_file(data_dir, payload, "hw.probe");

    let _ = append_desktop_log_for(
        data_dir,
        "hw.probe",
        &format!(
            "Updated Linux host probe: {} MB RAM, {} cores, {} ({})",
            total_ram_mb, cpu_cores, cpu_model, cpu_arch
        ),
    );
}

#[cfg(not(target_os = "linux"))]
fn refresh_linux_host_metrics_probe_cache(_data_dir: &Path) {}

/// Parse a named field from `/proc/meminfo` and return its value in kB.
/// e.g. `MemTotal:      131891648 kB` → `131891648`
#[cfg(target_os = "linux")]
fn read_proc_meminfo_kb(field: &str) -> Option<u64> {
    let content = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in content.lines() {
        if line.starts_with(field) {
            return line.split_whitespace().nth(1).and_then(|v| v.parse().ok());
        }
    }
    None
}

/// Read CPU model name and logical core count from `/proc/cpuinfo`.
#[cfg(target_os = "linux")]
fn read_linux_cpu_info() -> (String, u32) {
    let content = match std::fs::read_to_string("/proc/cpuinfo") {
        Ok(c) => c,
        Err(_) => return (String::new(), 0),
    };
    let mut model = String::new();
    let mut core_count: u32 = 0;
    for line in content.lines() {
        if line.starts_with("model name") && model.is_empty() {
            if let Some(val) = line.splitn(2, ':').nth(1) {
                model = val.trim().to_string();
            }
        }
        if line.starts_with("processor") {
            core_count += 1;
        }
    }
    (model, core_count)
}

/// Determine total and used disk space (in GB) for the data directory's filesystem.
#[cfg(target_os = "linux")]
fn linux_primary_disk_gb(data_dir: &Path) -> (u64, u64, String) {
    use std::ffi::CString;
    use std::mem::MaybeUninit;

    let path = data_dir
        .to_str()
        .and_then(|s| CString::new(s).ok())
        .unwrap_or_else(|| CString::new("/").unwrap());

    let mut stat: MaybeUninit<libc::statvfs> = MaybeUninit::uninit();
    // SAFETY: statvfs writes into the provided buffer; path is a valid NUL-terminated string.
    let ret = unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) };
    if ret != 0 {
        return (0, 0, String::new());
    }
    let stat = unsafe { stat.assume_init() };

    let block_size = stat.f_frsize as u64;
    let total = stat.f_blocks * block_size / (1024 * 1024 * 1024);
    let free = stat.f_bavail * block_size / (1024 * 1024 * 1024);
    let used = total.saturating_sub(free);
    let mount = data_dir.to_string_lossy().into_owned();

    (total, used, mount)
}

#[cfg(target_os = "linux")]
const MIN_DOCKER_RAM_MB: u64 = 8192;
#[cfg(target_os = "linux")]
const DOCKER_OS_RESERVE_MB: u64 = 4096;

#[cfg(target_os = "linux")]
fn recommended_docker_ram_mb_linux(host_total_mb: u64) -> u64 {
    if host_total_mb == 0 {
        return MIN_DOCKER_RAM_MB;
    }
    let capped = ((host_total_mb as f64) * 0.75) as u64;
    let reserved = host_total_mb.saturating_sub(DOCKER_OS_RESERVE_MB);
    let target = std::cmp::min(capped, reserved);
    std::cmp::max(MIN_DOCKER_RAM_MB, std::cmp::min(target, host_total_mb))
}

#[cfg(target_os = "linux")]
fn docker_desktop_settings_path_linux() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".docker/desktop/settings-store.json"))
}

#[cfg(target_os = "linux")]
fn read_docker_desktop_memory_mib(settings: &serde_json::Value) -> u64 {
    settings
        .get("memoryMiB")
        .or_else(|| settings.get("MemoryMiB"))
        .and_then(|m| m.as_u64())
        .unwrap_or(MIN_DOCKER_RAM_MB)
}

#[cfg(target_os = "linux")]
fn write_docker_tuning_record(data_dir: &Path, record: serde_json::Value) {
    let path = data_dir.join("state/hardware/docker-tuning.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_string_pretty(&record) {
        let _ = std::fs::write(path, format!("{serialized}\n"));
    }
}

#[cfg(target_os = "linux")]
fn try_restart_docker_desktop_linux() {
    let docker = find_docker_binary();
    let _ = Command::new(&docker)
        .args(["desktop", "restart"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// On Linux with Docker Desktop, containers run in a linuxkit VM capped by `memoryMiB` in
/// `~/.docker/desktop/settings-store.json`. Best-effort: raise toward ~75% of host RAM, restart
/// Docker Desktop, and record outcome in `state/hardware/docker-tuning.json` (shown in Settings → System).
#[cfg(target_os = "linux")]
fn ensure_docker_desktop_memory_linux(data_dir: &Path) {
    let settings_path = match docker_desktop_settings_path_linux() {
        Some(path) if path.exists() => path,
        _ => return,
    };

    let host_total_mb = match read_proc_meminfo_kb("MemTotal") {
        Some(kb) => kb / 1024,
        None => return,
    };

    let recommended_mb = recommended_docker_ram_mb_linux(host_total_mb);
    let threshold_mb = (recommended_mb as f64 * 0.9) as u64;
    let attempted_at = chrono::Utc::now().to_rfc3339();

    let mut settings: serde_json::Value = match std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    {
        Some(value) if value.is_object() => value,
        _ => serde_json::json!({}),
    };

    let current_mib = read_docker_desktop_memory_mib(&settings);

    if current_mib >= threshold_mb {
        write_docker_tuning_record(
            data_dir,
            serde_json::json!({
                "attemptedAt": attempted_at,
                "platform": "linux",
                "action": "noop",
                "reason": "Docker Desktop VM memory already at or above recommended value",
                "previousMemoryMb": current_mib,
                "targetMemoryMb": recommended_mb,
                "appliedMemoryMb": current_mib,
            }),
        );
        return;
    }

    let Some(obj) = settings.as_object_mut() else {
        return;
    };
    obj.insert(
        "memoryMiB".to_string(),
        serde_json::Value::Number(serde_json::Number::from(recommended_mb)),
    );

    let serialized = match serde_json::to_string_pretty(&settings) {
        Ok(value) => format!("{value}\n"),
        Err(error) => {
            write_docker_tuning_record(
                data_dir,
                serde_json::json!({
                    "attemptedAt": attempted_at,
                    "platform": "linux",
                    "action": "failed",
                    "reason": format!("Could not serialize Docker Desktop settings: {error}"),
                    "previousMemoryMb": current_mib,
                    "targetMemoryMb": recommended_mb,
                }),
            );
            return;
        }
    };

    match std::fs::write(&settings_path, serialized) {
        Ok(_) => {
            try_restart_docker_desktop_linux();
            let _ = append_desktop_log_for(
                data_dir,
                "docker.mem",
                &format!(
                    "Raised Docker Desktop VM memory from {current_mib} MiB to {recommended_mb} MiB (host {host_total_mb} MB RAM); requested Docker Desktop restart.",
                ),
            );
            write_docker_tuning_record(
                data_dir,
                serde_json::json!({
                    "attemptedAt": attempted_at,
                    "platform": "linux",
                    "action": "updated",
                    "reason": "Increased Docker Desktop memoryMiB (restart Docker Desktop if memory still looks capped)",
                    "previousMemoryMb": current_mib,
                    "targetMemoryMb": recommended_mb,
                    "appliedMemoryMb": recommended_mb,
                }),
            );
        }
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                "docker.mem",
                &format!(
                    "Could not write Docker Desktop settings at {}: {error}. Raise memory manually under Docker Desktop → Settings → Resources.",
                    settings_path.display()
                ),
            );
            write_docker_tuning_record(
                data_dir,
                serde_json::json!({
                    "attemptedAt": attempted_at,
                    "platform": "linux",
                    "action": "failed",
                    "reason": format!("Could not write Docker Desktop settings: {error}"),
                    "previousMemoryMb": current_mib,
                    "targetMemoryMb": recommended_mb,
                }),
            );
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn ensure_docker_desktop_memory_linux(_data_dir: &Path) {}

fn find_docker_binary() -> PathBuf {
    if let Some(path) = command_on_path("docker") {
        return path;
    }

    #[cfg(target_os = "macos")]
    {
        let candidates = [
            "/usr/local/bin/docker",
            "/opt/homebrew/bin/docker",
            "/Applications/Docker.app/Contents/Resources/bin/docker",
        ];
        for candidate in candidates {
            if std::path::Path::new(candidate).exists() {
                return PathBuf::from(candidate);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        let candidates = [
            "/usr/local/bin/docker",
            "/usr/bin/docker",
            "/snap/bin/docker",
        ];
        for candidate in candidates {
            if std::path::Path::new(candidate).exists() {
                return PathBuf::from(candidate);
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<PathBuf> = Vec::new();
        for env_var in ["ProgramFiles", "ProgramW6432"] {
            if let Ok(root) = std::env::var(env_var) {
                candidates.push(
                    Path::new(&root)
                        .join("Docker")
                        .join("Docker")
                        .join("resources")
                        .join("bin")
                        .join("docker.exe"),
                );
            }
        }
        for candidate in candidates {
            if candidate.exists() {
                return candidate;
            }
        }
    }

    PathBuf::from(if cfg!(target_os = "windows") {
        "docker.exe"
    } else {
        "docker"
    })
}

/// Paths used by the Hub manager, stored in Tauri app state.
pub struct HubPaths {
    pub data_dir: PathBuf,
    pub compose_path: PathBuf,
    pub env_path: PathBuf,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TraefikRuntimePreflight {
    pub changed: bool,
    pub repaired_conflicting_paths: bool,
}

impl TraefikRuntimePreflight {
    fn merge(&mut self, other: Self) {
        self.changed |= other.changed;
        self.repaired_conflicting_paths |= other.repaired_conflicting_paths;
    }
}

#[derive(Debug)]
pub struct HubInitialization {
    pub data_dir: PathBuf,
    pub compose_path: PathBuf,
    pub env_path: PathBuf,
    pub traefik_preflight: TraefikRuntimePreflight,
}

#[derive(Clone, serde::Serialize)]
pub enum HubStatus {
    DockerNotAvailable,
    Stopped,
    Starting,
    Running,
    Error { message: String },
}

#[derive(Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DockerAccessState {
    Available,
    PermissionDenied,
    DaemonUnavailable,
    NotInstalled,
    Error,
}

#[derive(Clone, serde::Serialize)]
pub struct DockerAccessCheck {
    pub state: DockerAccessState,
    pub detail: Option<String>,
}

#[derive(Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DockerInstallState {
    Completed,
    NeedsRestart,
}

#[derive(Clone, serde::Serialize)]
pub struct DockerInstallResult {
    pub state: DockerInstallState,
    pub detail: Option<String>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OllamaInstallState {
    Completed,
}

#[derive(Clone, serde::Serialize)]
pub struct OllamaInstallResult {
    pub state: OllamaInstallState,
    pub detail: Option<String>,
}

/// A single service's startup state, reported to the frontend loading screen.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceState {
    /// Container does not exist yet (pull / create pending).
    Pending,
    /// Container exists but health-check has not passed yet.
    Starting,
    /// Container is running and healthy (or has no health-check and is running).
    Ready,
    /// Container exited or is in an error state.
    Failed,
}

/// Per-service startup info returned to the frontend.
#[derive(Clone, serde::Serialize)]
pub struct ServiceStatus {
    /// Short human-readable label, e.g. "Database".
    pub label: String,
    /// Docker container name, e.g. "ci-hub-db".
    pub container: String,
    pub state: ServiceState,
}

/// Aggregate startup progress across all core Hub services.
#[derive(Clone, serde::Serialize)]
pub struct StartupProgress {
    /// Per-service breakdown.
    pub services: Vec<ServiceStatus>,
    /// 0..=100 overall progress percentage (average of required service states).
    pub progress_pct: u8,
    /// Number of required startup images that are present locally.
    pub image_pulled: u8,
    /// Total number of required startup images.
    pub image_total: u8,
    /// 0..=100 image pull progress percentage.
    pub image_pull_pct: u8,
    /// True once every service is Ready.
    pub all_ready: bool,
}

fn list_local_images() -> std::collections::HashSet<String> {
    let output = docker_command()
        .args(["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.ends_with(":<none>"))
        .map(ToOwned::to_owned)
        .collect()
}

fn required_startup_images() -> Vec<String> {
    let env = parse_env_file(&hub_env_path());
    let domain = env
        .get("DOMAIN")
        .map(String::as_str)
        .unwrap_or(default_public_domain());
    let hub_image = env
        .get("CI_HUB_IMAGE")
        .cloned()
        .unwrap_or_else(|| image_for_domain(domain).to_string());

    let mut out = vec![
        hub_image,
        "postgres:14".to_string(),
        "rabbitmq:4-alpine".to_string(),
        "traefik:v3.6.7".to_string(),
    ];
    if private_vpn_enabled_from_map(&env) {
        out.push("tailscale/tailscale:v1.82.5".to_string());
    }
    out
}

/// Query Docker for a list of container states in one `docker inspect` call.
/// Returns a map of container_name → (state, health).
fn inspect_containers(names: &[&str]) -> std::collections::HashMap<String, (String, String)> {
    let mut map = std::collections::HashMap::new();
    if names.is_empty() {
        return map;
    }
    let format = "{{.Name}}:{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}";
    let output = docker_command()
        .arg("inspect")
        .arg("--format")
        .arg(format)
        .args(names)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();

    for line in output.lines() {
        // Docker prefixes the name with "/" in inspect output
        let line = line.trim().trim_start_matches('/');
        let parts: Vec<&str> = line.splitn(3, ':').collect();
        if parts.len() == 3 {
            map.insert(
                parts[0].to_string(),
                (parts[1].to_string(), parts[2].to_string()),
            );
        }
    }
    map
}

/// Derive a ServiceState from raw Docker state/health strings.
fn derive_service_state(state: &str, health: &str) -> ServiceState {
    match state {
        "running" => {
            if health == "healthy" || health == "none" {
                ServiceState::Ready
            } else {
                ServiceState::Starting
            }
        }
        "created" | "restarting" => ServiceState::Starting,
        "exited" | "dead" => ServiceState::Failed,
        _ => ServiceState::Pending,
    }
}

/// Translate a service state to a progress score used by averaged startup progress.
///
/// Pending means the container likely does not exist yet (pull/create still in progress),
/// so we keep a small non-zero floor to indicate startup has begun.
fn service_state_score(state: &ServiceState) -> u8 {
    match state {
        ServiceState::Pending => 15,
        ServiceState::Starting => 60,
        ServiceState::Ready => 100,
        ServiceState::Failed => 0,
    }
}

fn startup_service_definitions(
    vpn_on: bool,
) -> (
    Vec<(&'static str, &'static str, bool)>,
    Vec<(&'static str, &'static str, bool)>,
) {
    let core = vec![
        ("ci-hub-db", "Database", true),
        ("ci-os-hub-queue", "Message queue", true),
        ("ci-os-hub", "Hub backend", true),
        ("traefik", "Router", true),
    ];

    let mut optional = Vec::new();
    if vpn_on {
        optional.push(("hub-tailscale", "Private VPN", false));
    }
    optional.push(("cloudflared", "Tunnel", false));
    optional.push(("ci-hub-ollama", "Ollama", false));

    (core, optional)
}

/// Return per-service startup progress for the frontend loading screen.
pub fn get_startup_progress() -> StartupProgress {
    let vpn_on = is_private_vpn_enabled();

    // Core services in startup order. Optional ones are included for visibility but do not block
    // the "all_ready" gate. Private VPN improves remote access, but the desktop app should stay
    // usable even if the sidecar is still reconnecting.
    let (core, optional) = startup_service_definitions(vpn_on);

    let all_names: Vec<&str> = core
        .iter()
        .chain(optional.iter())
        .map(|(n, _, _)| *n)
        .collect();
    let states = inspect_containers(&all_names);

    let mut services: Vec<ServiceStatus> = Vec::new();
    let mut ready_core: usize = 0;
    let mut core_score_sum: usize = 0;

    for (container, label, _required) in core.iter().chain(optional.iter()) {
        let (state_str, health_str) = states
            .get(*container)
            .map(|(s, h)| (s.as_str(), h.as_str()))
            .unwrap_or(("", ""));
        let svc_state = if state_str.is_empty() {
            ServiceState::Pending
        } else {
            derive_service_state(state_str, health_str)
        };
        services.push(ServiceStatus {
            label: label.to_string(),
            container: container.to_string(),
            state: svc_state,
        });
    }

    // Count ready core services and compute average core score for progress %.
    for (i, (_, _, required)) in core.iter().chain(optional.iter()).enumerate() {
        if *required {
            core_score_sum += service_state_score(&services[i].state) as usize;
            if let ServiceState::Ready = services[i].state {
                ready_core += 1;
            }
        }
    }

    let core_count = core.len();
    let progress_pct = if core_count == 0 {
        0
    } else {
        (core_score_sum / core_count) as u8
    };

    let required_images = required_startup_images();
    let local_images = list_local_images();
    let image_total = required_images.len() as u8;
    let image_pulled = required_images
        .iter()
        .filter(|img| local_images.contains(img.as_str()))
        .count() as u8;
    let image_pull_pct = if image_total == 0 {
        100
    } else {
        ((image_pulled as usize * 100) / image_total as usize) as u8
    };

    let all_ready = ready_core == core_count;

    StartupProgress {
        services,
        progress_pct,
        image_pulled,
        image_total,
        image_pull_pct,
        all_ready,
    }
}

/// Get the current status of the Hub by inspecting the Docker container.
pub fn get_hub_status() -> HubStatus {
    // If a start operation is actively running (including first-time image pulls),
    // report Starting so the frontend shows progress instead of a false "Stopped" state.
    if START_IN_PROGRESS.load(Ordering::SeqCst) {
        reset_vpn_sidecar_status_poll_phase();
        return HubStatus::Starting;
    }

    if !is_docker_available() {
        reset_vpn_sidecar_status_poll_phase();
        return HubStatus::DockerNotAvailable;
    }

    // Check ci-os-hub container specifically
    let status = docker_command()
        .args([
            "inspect",
            "--format",
            "{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
            "ci-os-hub",
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    if status.is_empty() || status.contains("No such object") || status.contains("Error") {
        reset_vpn_sidecar_status_poll_phase();
        return HubStatus::Stopped;
    }

    let parts: Vec<&str> = status.split(':').collect();
    let state = parts.first().copied().unwrap_or("");
    let health = parts.get(1).copied().unwrap_or("");

    if !(state == "running" && health == "healthy") {
        reset_vpn_sidecar_status_poll_phase();
    }

    match (state, health) {
        ("running", "healthy") => {
            let vpn_on = is_private_vpn_enabled();
            if !vpn_on {
                reset_vpn_sidecar_status_poll_phase();
                HubStatus::Running
            } else {
                let skip_sidecar_inspect = {
                    let phase = lock_recovering(&VPN_SIDECAR_STATUS_POLL_PHASE);
                    matches!(
                        *phase,
                        VpnSidecarPollPhase::VerifiedSince(since)
                            if since.elapsed() >= VPN_SIDECARS_STATUS_POLL_GRACE
                    )
                };
                if skip_sidecar_inspect {
                    HubStatus::Running
                } else {
                    let ready = vpn_sidecars_ready();
                    let mut phase = lock_recovering(&VPN_SIDECAR_STATUS_POLL_PHASE);
                    match *phase {
                        VpnSidecarPollPhase::PendingReady => {
                            if ready {
                                *phase = VpnSidecarPollPhase::VerifiedSince(Instant::now());
                                HubStatus::Running
                            } else {
                                HubStatus::Starting
                            }
                        }
                        VpnSidecarPollPhase::VerifiedSince(since) => {
                            if since.elapsed() >= VPN_SIDECARS_STATUS_POLL_GRACE {
                                HubStatus::Running
                            } else if ready {
                                HubStatus::Running
                            } else {
                                *phase = VpnSidecarPollPhase::PendingReady;
                                HubStatus::Starting
                            }
                        }
                    }
                }
            }
        }
        ("running", _) => HubStatus::Starting,
        ("restarting", _) => {
            // Check if database is still starting — if so, Hub restart is expected
            let db_status = docker_command()
                .args([
                    "inspect",
                    "--format",
                    "{{.State.Health.Status}}",
                    "ci-hub-db",
                ])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();

            if db_status != "healthy" {
                HubStatus::Starting // DB not ready yet, Hub restart is expected
            } else {
                // DB is healthy but Hub is still restarting — might be a real error
                let restart_count = docker_command()
                    .args(["inspect", "--format", "{{.RestartCount}}", "ci-os-hub"])
                    .output()
                    .map(|o| {
                        String::from_utf8_lossy(&o.stdout)
                            .trim()
                            .parse::<u32>()
                            .unwrap_or(0)
                    })
                    .unwrap_or(0);

                if restart_count <= 3 {
                    HubStatus::Starting
                } else {
                    HubStatus::Error {
                        message: format!(
                            "Hub has restarted {} times. Open tray → View Logs for details.",
                            restart_count
                        ),
                    }
                }
            }
        }
        ("created", _) | ("exited", _) => HubStatus::Stopped,
        _ => HubStatus::Starting,
    }
}

/// Get the Hub data directory (platform-specific)
pub fn get_hub_data_dir() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("companion-hub")
}

pub fn hub_env_path_for(data_dir: &Path) -> PathBuf {
    data_dir.join(HUB_ENV_FILENAME)
}

pub fn hub_env_path() -> PathBuf {
    hub_env_path_for(&get_hub_data_dir())
}

fn compat_hub_env_path_for(data_dir: &Path) -> PathBuf {
    data_dir.join(COMPAT_HUB_ENV_FILENAME)
}

fn load_runtime_env_values(
    data_dir: &Path,
    env_path: &Path,
) -> std::collections::HashMap<String, String> {
    let compat_path = compat_hub_env_path_for(data_dir);
    let mut values = if compat_path != env_path {
        parse_env_file(&compat_path)
    } else {
        std::collections::HashMap::new()
    };
    values.extend(parse_env_file(env_path));
    values
}

pub(crate) fn logs_dir_for(data_dir: &Path) -> PathBuf {
    data_dir.join("logs")
}

pub fn logs_dir() -> PathBuf {
    logs_dir_for(&get_hub_data_dir())
}

pub(crate) fn desktop_log_path_for(data_dir: &Path) -> PathBuf {
    logs_dir_for(data_dir).join(DESKTOP_LOG_FILENAME)
}

pub fn desktop_log_path() -> PathBuf {
    desktop_log_path_for(&get_hub_data_dir())
}

pub(crate) fn logs_open_target_for(data_dir: &Path) -> PathBuf {
    logs_dir_for(data_dir)
}

pub fn logs_open_target() -> PathBuf {
    logs_open_target_for(&get_hub_data_dir())
}

// ─── User-stopped marker ──────────────────────────────────────────────────────
//
// When the user explicitly stops the Hub (via tray menu or the UI), we write a
// sentinel file so that the next desktop launch does NOT auto-restart the Hub.
// The marker is removed when the user explicitly starts the Hub again.

const USER_STOPPED_MARKER_FILENAME: &str = ".user-stopped";
const LAUNCH_MODE_FILENAME: &str = ".launch-mode";

/// How the Hub was last launched — used to relaunch in the same mode after an update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistedLaunchMode {
    Desktop,
    Detached,
}

impl PersistedLaunchMode {
    fn as_str(self) -> &'static str {
        match self {
            PersistedLaunchMode::Desktop => "desktop",
            PersistedLaunchMode::Detached => "detached",
        }
    }

    fn from_str(raw: &str) -> Self {
        if raw.trim() == "detached" {
            PersistedLaunchMode::Detached
        } else {
            PersistedLaunchMode::Desktop
        }
    }
}

pub fn persist_launch_mode(data_dir: &Path, mode: PersistedLaunchMode) {
    let _ = std::fs::write(
        data_dir.join(LAUNCH_MODE_FILENAME),
        format!("{}\n", mode.as_str()),
    );
}

pub fn read_launch_mode(data_dir: &Path) -> PersistedLaunchMode {
    std::fs::read_to_string(data_dir.join(LAUNCH_MODE_FILENAME))
        .map(|content| PersistedLaunchMode::from_str(content.trim()))
        .unwrap_or(PersistedLaunchMode::Desktop)
}

fn user_stopped_marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(USER_STOPPED_MARKER_FILENAME)
}

fn stack_dev_mode_enabled() -> bool {
    std::env::var("CI_HUB_STACK_DEV")
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// Record that the user intentionally stopped the Hub.
/// Called from `stop_hub()` so the next app launch skips auto-start.
pub fn mark_user_stopped(data_dir: &Path) {
    let _ = std::fs::write(
        user_stopped_marker_path(data_dir),
        b"Hub was intentionally stopped by the user.\n",
    );
}

/// Clear the user-stopped marker when the user explicitly starts the Hub.
/// Also called at the beginning of `start_hub()`.
pub fn clear_user_stopped(data_dir: &Path) {
    let _ = std::fs::remove_file(user_stopped_marker_path(data_dir));
}

/// Returns `true` if the user intentionally stopped the Hub on last use.
pub fn is_user_stopped(data_dir: &Path) -> bool {
    user_stopped_marker_path(data_dir).exists()
}

// ─── Desktop log reader ───────────────────────────────────────────────────────

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

pub(crate) fn tunnel_dir_for(data_dir: &Path) -> PathBuf {
    data_dir.join("tunnel")
}

pub(crate) fn tunnel_token_path_for(data_dir: &Path) -> PathBuf {
    tunnel_dir_for(data_dir).join("token")
}

/// Remove the Cloudflare tunnel token file (and its parent directory if empty).
/// Returns a human-readable summary of what was removed for logging. Errors only
/// when the filesystem refuses to delete an existing file — a missing token is a
/// no-op success since the post-condition (no token on disk) is already satisfied.
pub fn clear_tunnel_token(data_dir: &Path) -> Result<String, String> {
    let token_path = tunnel_token_path_for(data_dir);
    let tunnel_dir = tunnel_dir_for(data_dir);

    let token_existed = token_path.exists();
    if token_existed {
        std::fs::remove_file(&token_path).map_err(|e| {
            format!(
                "Failed to remove tunnel token at {}: {}",
                token_path.display(),
                e
            )
        })?;
    }

    let mut removed_dir = false;
    if tunnel_dir.exists() {
        match std::fs::read_dir(&tunnel_dir) {
            Ok(mut entries) => {
                if entries.next().is_none() {
                    if let Err(e) = std::fs::remove_dir(&tunnel_dir) {
                        return Err(format!(
                            "Removed tunnel token but failed to remove empty tunnel dir {}: {}",
                            tunnel_dir.display(),
                            e
                        ));
                    }
                    removed_dir = true;
                }
            }
            Err(e) => {
                return Err(format!(
                    "Removed tunnel token but failed to inspect {}: {}",
                    tunnel_dir.display(),
                    e
                ));
            }
        }
    }

    let summary = match (token_existed, removed_dir) {
        (true, true) => format!(
            "Tunnel token cleared ({} removed) and empty tunnel dir removed.",
            token_path.display()
        ),
        (true, false) => format!("Tunnel token cleared ({} removed).", token_path.display()),
        (false, _) => format!(
            "No tunnel token to clear at {} (already absent).",
            token_path.display()
        ),
    };
    Ok(summary)
}

pub(crate) fn managed_app_container_ps_args() -> [&'static str; 6] {
    [
        "ps",
        "-q",
        "--filter",
        MANAGED_APP_CONTAINER_LABEL_FILTER,
        "--filter",
        MANAGED_APP_CONTAINER_URN_FILTER,
    ]
}

fn parse_container_ids(output: &str) -> Vec<String> {
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
fn stderr_fallback(msg: &str) {
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
fn rotate_log_if_needed(log_path: &Path, logs_dir: &Path, max_size: u64) {
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

fn with_view_logs_hint(message: impl Into<String>) -> String {
    format!("{} Open tray → View Logs for details.", message.into())
}

/// Check if Docker is available
pub fn is_docker_available() -> bool {
    matches!(check_docker_access().state, DockerAccessState::Available)
}

fn should_defer_docker_bind_mount_probe(state: &DockerAccessState) -> bool {
    !matches!(state, DockerAccessState::Available)
}

pub fn check_docker_access() -> DockerAccessCheck {
    let output = match docker_command().arg("info").output() {
        Ok(output) => output,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return DockerAccessCheck {
                state: DockerAccessState::NotInstalled,
                detail: Some("Docker CLI was not found on PATH.".to_string()),
            };
        }
        Err(error) => {
            return DockerAccessCheck {
                state: DockerAccessState::Error,
                detail: Some(format!("Failed to run docker info: {}", error)),
            };
        }
    };

    if output.status.success() {
        return DockerAccessCheck {
            state: DockerAccessState::Available,
            detail: None,
        };
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let combined = if !stderr.is_empty() && !stdout.is_empty() {
        format!("{}\n{}", stderr, stdout)
    } else if !stderr.is_empty() {
        stderr.clone()
    } else {
        stdout.clone()
    };
    classify_docker_access_result(&combined, output.status.code())
}

fn classify_docker_access_result(combined: &str, exit_code: Option<i32>) -> DockerAccessCheck {
    let combined_lower = combined.to_lowercase();
    let references_windows_docker_pipe = combined_lower.contains("//./pipe/docker")
        || combined_lower.contains("\\\\.\\pipe\\docker")
        || combined_lower.contains("%2f%2f.%2fpipe%2fdocker");
    let windows_pipe_not_ready = references_windows_docker_pipe
        && (combined_lower.contains("the system cannot find the file specified")
            || combined_lower.contains("the pipe has been ended")
            || combined_lower.contains("the semaphore timeout period has expired"));

    if combined_lower.contains("cannot connect to the docker daemon")
        || combined_lower.contains("is the docker daemon running")
        || combined_lower.contains("error during connect")
        || combined_lower.contains("connection refused")
        || combined_lower.contains("context deadline exceeded")
        || combined_lower.contains("this error may indicate that the docker daemon is not running")
        || windows_pipe_not_ready
    {
        return DockerAccessCheck {
            state: DockerAccessState::DaemonUnavailable,
            detail: Some(if combined.is_empty() {
                "Docker is installed, but the daemon is not ready yet.".to_string()
            } else {
                combined.to_string()
            }),
        };
    }

    if combined_lower.contains("permission denied")
        || combined_lower.contains("got permission denied")
        || combined_lower.contains("permission denied while trying to connect")
        || combined_lower.contains("dial unix /var/run/docker.sock: connect: permission denied")
        || combined_lower.contains("access is denied")
        || combined_lower.contains("must be run with elevated privileges")
        || combined_lower.contains("requested operation requires elevation")
    {
        return DockerAccessCheck {
            state: DockerAccessState::PermissionDenied,
            detail: Some(if combined.is_empty() {
                "Docker is installed, but this user cannot access the Docker daemon yet."
                    .to_string()
            } else {
                combined.to_string()
            }),
        };
    }

    DockerAccessCheck {
        state: DockerAccessState::Error,
        detail: Some(if combined.is_empty() {
            format!("docker info failed with exit code {:?}", exit_code)
        } else {
            combined.to_string()
        }),
    }
}

/// Check if Hub containers exist (stopped or running)
pub fn hub_containers_exist() -> bool {
    docker_command()
        .args([
            "ps",
            "-a",
            "--filter",
            "name=ci-os-hub",
            "--format",
            "{{.Names}}",
        ])
        .output()
        .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false)
}

fn traefik_recreate_marker_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TRAEFIK_RECREATE_MARKER_FILENAME)
}

pub(crate) fn is_traefik_recreate_required(data_dir: &Path) -> bool {
    traefik_recreate_marker_path(data_dir).exists()
}

fn mark_traefik_recreate_required(data_dir: &Path) -> Result<(), String> {
    let marker_path = traefik_recreate_marker_path(data_dir);
    std::fs::write(
        &marker_path,
        b"Traefik container must be recreated before the next startup.\n",
    )
    .map_err(|error| {
        format!(
            "Failed to persist Traefik recreate marker at {}: {}",
            marker_path.display(),
            error
        )
    })
}

fn clear_traefik_recreate_required(data_dir: &Path) -> Result<(), String> {
    let marker_path = traefik_recreate_marker_path(data_dir);
    if !marker_path.exists() {
        return Ok(());
    }

    std::fs::remove_file(&marker_path).map_err(|error| {
        format!(
            "Failed to clear Traefik recreate marker at {}: {}",
            marker_path.display(),
            error
        )
    })
}

fn seeded_traefik_config_contents() -> String {
    let acme_email =
        std::env::var("ACME_EMAIL").unwrap_or_else(|_| DEFAULT_TRAEFIK_ACME_EMAIL.to_string());
    TRAEFIK_CONFIG_SEED.replace("{{ACME_EMAIL}}", &acme_email)
}

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

/// Files prior root-owned Hub containers commonly leave on bind mounts (block EACCES on rewrite).
const HUB_STALE_ROOT_OWNED_FILES: &[(&str, &str)] = &[
    ("state", ".env.resolved"),
    ("logs", "app.log"),
    ("logs", "error.log"),
];

/// Persistent state files the backend must be able to write to at runtime.
/// These are chmod 0o666 (not deleted) so the container can update them without
/// losing existing data even when they were previously written by a root-owned container.
const HUB_STATE_FILES_NEED_WRITE: &[(&str, &str)] =
    &[("state", "settings.json"), ("state", "seed")];

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

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[cfg(any(target_os = "linux", test))]
fn resolved_host_docker_dir(host_docker_dir: Option<&Path>) -> Option<PathBuf> {
    match host_docker_dir {
        Some(docker_dir) => Some(docker_dir.to_path_buf()),
        None => dirs::home_dir().map(|home| home.join(".docker")),
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[cfg(any(target_os = "linux", test))]
fn current_docker_context_name(host_docker_dir: Option<&Path>) -> Option<String> {
    let docker_dir = resolved_host_docker_dir(host_docker_dir)?;
    let raw = std::fs::read_to_string(docker_dir.join("config.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let context_name = parsed.get("currentContext")?.as_str()?.trim();
    if context_name.is_empty() || context_name == "default" {
        return None;
    }
    Some(context_name.to_string())
}

#[cfg(any(target_os = "linux", test))]
fn docker_context_host_from_inspect_output(raw: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let host = parsed
        .as_array()?
        .first()?
        .get("Endpoints")?
        .get("docker")?
        .get("Host")?
        .as_str()?
        .trim();
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

#[cfg(target_os = "linux")]
fn docker_context_host(context_name: &str) -> Option<String> {
    let output = base_docker_command()
        .args(["context", "inspect", context_name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    docker_context_host_from_inspect_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "linux")]
fn linux_docker_host_for_context_or_local_sockets<F>(
    context_host: Option<&str>,
    has_nondefault_context: bool,
    candidates: &[PathBuf],
    mut is_reachable: F,
) -> Option<String>
where
    F: FnMut(&Path) -> bool,
{
    if has_nondefault_context {
        return context_host.map(|host| host.to_string());
    }

    select_reachable_linux_docker_socket_path(candidates, |candidate| is_reachable(candidate))
        .map(|socket_path| format!("unix://{}", socket_path.display()))
}

fn preferred_docker_host() -> Option<String> {
    if let Ok(docker_host) = std::env::var("DOCKER_HOST") {
        let trimmed = docker_host.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    #[cfg(target_os = "linux")]
    {
        return active_linux_docker_host(None);
    }

    #[cfg(not(target_os = "linux"))]
    {
        None
    }
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
    }

    let mut deduped = Vec::new();
    for candidate in candidates {
        if !deduped.iter().any(|existing| existing == &candidate) {
            deduped.push(candidate);
        }
    }
    deduped
}

#[cfg(target_os = "linux")]
fn select_reachable_linux_docker_socket_path<F>(
    candidates: &[PathBuf],
    mut is_reachable: F,
) -> Option<PathBuf>
where
    F: FnMut(&Path) -> bool,
{
    candidates
        .iter()
        .find(|candidate| is_reachable(candidate))
        .cloned()
}

#[cfg(target_os = "linux")]
fn probe_linux_docker_socket(socket_path: &Path) -> bool {
    if !socket_path.exists() {
        return false;
    }

    let docker_host = format!("unix://{}", socket_path.display());
    base_docker_command()
        .env("DOCKER_HOST", docker_host)
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn active_linux_docker_host(host_docker_dir: Option<&Path>) -> Option<String> {
    // Respect a configured non-default Docker context even if it is currently
    // unavailable so the desktop app matches the user's CLI behavior. Only fall
    // back to local Engine sockets when there is no explicit context override.
    let context_name = current_docker_context_name(host_docker_dir);
    let context_host = context_name.as_deref().and_then(docker_context_host);

    linux_docker_host_for_context_or_local_sockets(
        context_host.as_deref(),
        context_name.is_some(),
        &linux_docker_socket_candidates(),
        probe_linux_docker_socket,
    )
}

fn host_docker_socket_path() -> PathBuf {
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

fn docker_socket_mount_arg() -> String {
    format!(
        "{}:/var/run/docker.sock:ro",
        host_docker_socket_path().display()
    )
}

/// Parse `stat -c "%u:%g"` output from a container probing the mounted Docker socket.
fn parse_docker_socket_uid_gid(raw: &str) -> Option<(u32, u32)> {
    let trimmed = raw.trim();
    let (uid_raw, gid_raw) = trimmed.split_once(':')?;
    Some((uid_raw.parse().ok()?, gid_raw.parse().ok()?))
}

/// How the mounted Docker socket appears *inside* a throwaway container (authoritative for compose `user:`).
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

fn likely_docker_desktop() -> bool {
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

#[cfg(windows)]
pub(crate) fn host_container_uid_gid() -> (u32, u32) {
    // Docker Desktop file shares typically map the Linux VM user to 1000:1000.
    (1000, 1000)
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
        std::fs::write(&settings_path, b"{}")
            .map_err(|error| format!("Failed to create {}: {}", settings_path.display(), error))?;
        #[cfg(unix)]
        let _ = std::fs::set_permissions(&settings_path, std::fs::Permissions::from_mode(0o666));
    }

    for (subdir, file) in HUB_STATE_FILES_NEED_WRITE {
        let path = data_dir.join(subdir).join(file);
        if path.exists() {
            #[cfg(unix)]
            if let Err(error) =
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))
            {
                eprintln!("warning: could not chmod 666 {}: {}", path.display(), error);
            }
        }
    }

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
        heal_bind_mount_permissions_via_docker(data_dir, "state", container_uid, container_gid)?;
    }

    if !verify_container_can_write_file(&settings_path, container_uid, container_gid) {
        remove_host_root_owned_state_files(data_dir);
        if !settings_path.exists() {
            std::fs::write(&settings_path, b"{}").map_err(|error| {
                format!("Failed to recreate {}: {}", settings_path.display(), error)
            })?;
            #[cfg(unix)]
            let _ =
                std::fs::set_permissions(&settings_path, std::fs::Permissions::from_mode(0o666));
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

    let mount_spec = format!("{}:/mnt:rw", host_dir.display());
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

fn verify_container_can_write_dir(host_dir: &Path, uid: u32, gid: u32) -> bool {
    if !host_dir.exists() {
        return false;
    }

    let mount_spec = format!("{}:/mnt:rw", host_dir.display());
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

    let mount_spec = format!("{}:/mnt:rw", host_subdir.display());
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
fn ensure_host_state_tree_writable(data_dir: &Path) -> Result<(), String> {
    ensure_host_bind_mounts_writable(data_dir)
}

/// Remove a project container that is not running but may still hold published host ports.
fn ensure_container_released_if_not_running(
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
        let combined_lower = combined.to_lowercase();
        if combined_lower.contains("no such object") || combined_lower.contains("no such container")
        {
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

fn prepare_traefik_runtime_state(data_dir: &Path) -> Result<TraefikRuntimePreflight, String> {
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

fn ensure_hub_docker_config_state(data_dir: &Path) -> Result<TraefikRuntimePreflight, String> {
    let docker_dir = data_dir.join(".docker");
    std::fs::create_dir_all(docker_dir.join("cli-plugins"))
        .map_err(|e| format!("Cannot create {}: {}", docker_dir.display(), e))?;
    ensure_runtime_file(&data_dir.join(HUB_DOCKER_CONFIG_FILE), "{}", None)
}

fn remove_existing_traefik_container(data_dir: &Path) -> Result<(), String> {
    let output = docker_command()
        .args(["rm", "-f", "traefik"])
        .output()
        .map_err(|error| {
            format!(
                "Failed to remove the existing Traefik container before recreate: {}",
                error
            )
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );
    let combined_lower = combined_output.to_lowercase();

    if output.status.success() {
        let message = if combined_output.is_empty() {
            "Removed existing Traefik container before recreate.".to_string()
        } else {
            format!(
                "Removed existing Traefik container before recreate. {}",
                combined_output
            )
        };
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        return Ok(());
    }

    if combined_lower.contains("no such container") || combined_lower.contains("no such object") {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            "Traefik recreate was requested, but no existing Traefik container was present.",
        );
        return Ok(());
    }

    if combined_output.is_empty() {
        Err(format!(
            "Failed to remove the existing Traefik container before recreate (exit code {:?}).",
            output.status.code()
        ))
    } else {
        Err(format!(
            "Failed to remove the existing Traefik container before recreate. {}",
            combined_output
        ))
    }
}

/// Remove a Traefik container that is not running but still holds 80/443 via docker-proxy.
///
/// Docker can leave a `created` (or exited) Traefik container with published ports while
/// `compose up` fails on the next start with "ports are not available".
fn ensure_traefik_container_released(data_dir: &Path) -> Result<(), String> {
    let output = docker_command()
        .args(["inspect", "traefik", "--format", "{{.State.Status}}"])
        .output()
        .map_err(|error| format!("Failed to inspect Traefik container state: {}", error))?;

    if !output.status.success() {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        let combined_lower = combined.to_lowercase();
        if combined_lower.contains("no such object") || combined_lower.contains("no such container")
        {
            return Ok(());
        }
        return Err(format!(
            "Failed to inspect Traefik container state. {}",
            combined
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
            "Removing non-running Traefik container (state={}) to release host ports 80/443.",
            status
        ),
    );
    remove_existing_traefik_container(data_dir)
}

/// Remove stale project containers left behind by a previous installation.
/// Runs `docker compose down --remove-orphans` to clean up before a fresh start.
pub fn cleanup_stale_project_containers(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.cleanup",
        "Cleaning up stale containers before start.",
    );

    let output = docker_command()
        .env("ENV_FILE", env_path)
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "down",
            "--remove-orphans",
        ])
        .output()
        .map_err(|e| {
            let message = format!("Failed to run cleanup compose down: {}", e);
            let _ = append_desktop_log_for(data_dir, "hub.cleanup", &message);
            message
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    // Log result but treat non-zero exit as non-fatal — the subsequent start
    // will surface any real problem.
    if output.status.success() {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.cleanup",
            &format!("Stale container cleanup succeeded. {}", combined_output),
        );
    } else {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.cleanup",
            &format!(
                "Stale container cleanup returned non-zero (non-fatal). {}",
                combined_output
            ),
        );
    }

    Ok(())
}

/// Returns `true` if the error output indicates a Docker container name conflict
/// ("is already in use by container").
fn is_container_name_conflict(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("is already in use by container")
}

/// Returns `true` if the error output indicates an OCI runtime creation failure.
fn is_oci_runtime_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("oci runtime create failed") || lower.contains("failed to create shim task")
}

fn is_docker_config_mount_path_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("docker-config.json")
        && (lower.contains("not a directory")
            || lower.contains("is a directory")
            || lower.contains("mount a directory onto a file"))
}

/// Returns `true` when Docker cannot publish Traefik's HTTP/HTTPS host ports.
fn is_host_port_bind_conflict(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("ports are not available")
        || lower.contains("address already in use")
        || lower.contains("bind: address already in use")
        || lower.contains("port is already allocated")
}

const HUB_STACK_CONTAINERS: &[&str] = &[
    "ci-os-hub",
    "ci-hub-db",
    "ci-os-hub-queue",
    "traefik",
    "cloudflared",
    "hub-tailscale",
];

/// Remove stopped Hub stack containers (and optionally Traefik) that still claim
/// a host port publish mapping. Running non-Hub containers are left alone so we
/// can reassign HTTP_PORT/HTTPS_PORT instead of killing unrelated services.
fn release_stale_port_publishers(
    port: u16,
    data_dir: &Path,
    force_traefik: bool,
) -> Result<(), String> {
    let filter = format!("publish={}", port);
    let output = docker_command()
        .args([
            "ps",
            "-a",
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.Status}}",
            "--filter",
            &filter,
        ])
        .output()
        .map_err(|error| {
            format!(
                "Failed to list containers publishing host port {}: {}",
                port, error
            )
        })?;

    if !output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let id = parts[0].trim();
        let names = parts[1].trim();
        let status = parts[2].trim();
        if id.is_empty() {
            continue;
        }

        let status_lower = status.to_lowercase();
        let is_running = status_lower.starts_with("up");
        let is_traefik = names
            .split(',')
            .any(|name| name.trim().eq_ignore_ascii_case("traefik"));
        let is_ours = names.split(',').any(|name| {
            HUB_STACK_CONTAINERS
                .iter()
                .any(|container| name.trim().eq_ignore_ascii_case(container))
        });

        let should_remove = if force_traefik && is_traefik {
            true
        } else if is_traefik && !is_running {
            true
        } else if is_ours && !is_running {
            true
        } else if !is_running {
            true
        } else {
            false
        };

        if !should_remove {
            continue;
        }

        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "Removing container {} ({}, {}) to release host port {}.",
                id, names, status, port
            ),
        );

        let rm_output = docker_command().args(["rm", "-f", id]).output();
        match rm_output {
            Ok(rm) if rm.status.success() => {}
            Ok(rm) => {
                let combined = format_command_output(
                    &String::from_utf8_lossy(&rm.stdout),
                    &String::from_utf8_lossy(&rm.stderr),
                );
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!(
                        "Failed to remove container {} publishing port {} (non-fatal). {}",
                        id, port, combined
                    ),
                );
            }
            Err(error) => {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!(
                        "Failed to remove container {} publishing port {} (non-fatal): {}",
                        id, port, error
                    ),
                );
            }
        }
    }

    Ok(())
}

/// Targeted self-heal for Traefik host port bind failures.
fn heal_host_port_bind_conflict(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
    error_output: &str,
) {
    let ports: Vec<u16> = crate::port_manager::parse_bind_conflict_port(error_output)
        .map(|port| vec![port])
        .unwrap_or_else(|| vec![80, 443]);

    for port in ports {
        let _ = release_stale_port_publishers(port, data_dir, true);
    }

    let _ = ensure_traefik_container_released(data_dir);
    let _ = ensure_container_released_if_not_running(data_dir, "ci-hub-db", "6543");
    let _ = ensure_container_released_if_not_running(data_dir, "ci-os-hub-queue", "5001");
    let _ = cleanup_stale_project_containers(compose_path, env_path, data_dir);
    let _ = release_orphaned_traefik_port_proxies(data_dir);

    match crate::port_manager::refresh_ports_if_needed(env_path) {
        Ok(resolution) => {
            let mut log_lines = vec!["Port re-resolution after bind conflict:".to_string()];
            for message in &resolution.info {
                log_lines.push(format!("  INFO: {}", message));
            }
            for message in &resolution.warnings {
                log_lines.push(format!("  WARN: {}", message));
            }
            for (var, port) in &resolution.env_vars {
                if var == "HTTP_PORT" || var == "HTTPS_PORT" {
                    log_lines.push(format!("  {}={}", var, port));
                }
            }
            let _ = append_desktop_log_for(data_dir, "hub.start", &log_lines.join("\n"));
        }
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Port re-resolution after bind conflict failed (non-fatal): {}",
                    error
                ),
            );
        }
    }
}

/// On Linux, find `docker-proxy` PIDs holding Traefik's target ports with no
/// corresponding *running* container (i.e. orphaned after Docker cleanup).
///
/// `/proc/<pid>/cmdline` is world-readable even for root-owned processes, so
/// this requires no elevated privileges.  Each returned tuple is `(pid, port)`.
#[cfg(target_os = "linux")]
fn find_orphaned_traefik_proxy_pids(target_ports: &[u16]) -> Vec<(u32, u16)> {
    let mut proxy_pids: Vec<(u32, u16)> = Vec::new();

    let proc_dir = match std::fs::read_dir("/proc") {
        Ok(d) => d,
        Err(_) => return proxy_pids,
    };

    for entry in proc_dir.flatten() {
        let name = entry.file_name();
        let pid = match name.to_string_lossy().parse::<u32>() {
            Ok(n) => n,
            Err(_) => continue,
        };

        let bytes = match std::fs::read(format!("/proc/{}/cmdline", pid)) {
            Ok(b) => b,
            Err(_) => continue,
        };

        // argv is NUL-separated; last element may be empty
        let args: Vec<&[u8]> = bytes.split(|&b| b == 0).collect();

        let is_docker_proxy = args
            .first()
            .and_then(|a| std::str::from_utf8(a).ok())
            .map(|s| s.ends_with("docker-proxy"))
            .unwrap_or(false);

        if !is_docker_proxy {
            continue;
        }

        for window in args.windows(2) {
            let key = std::str::from_utf8(window[0]).unwrap_or("");
            let val = std::str::from_utf8(window[1]).unwrap_or("");
            if key == "-host-port" {
                if let Ok(port) = val.parse::<u16>() {
                    if target_ports.contains(&port) {
                        proxy_pids.push((pid, port));
                    }
                }
            }
        }
    }

    if proxy_pids.is_empty() {
        return proxy_pids;
    }

    // Keep only proxies for ports not legitimately owned by a *running* container.
    proxy_pids
        .into_iter()
        .filter(|(_, port)| {
            let claimed = docker_command()
                .args(["ps", "-q", "--filter", &format!("publish={}", port)])
                .output()
                .map(|o| !String::from_utf8_lossy(&o.stdout).trim().is_empty())
                .unwrap_or(false);
            !claimed
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn find_orphaned_traefik_proxy_pids(_target_ports: &[u16]) -> Vec<(u32, u16)> {
    Vec::new()
}

/// Kill orphaned `docker-proxy` processes that may be preventing Traefik from
/// binding its host ports. Uses `sudo -n kill` when available; otherwise logs
/// remediation steps and continues startup (compose will surface a real bind error).
fn release_orphaned_traefik_port_proxies(data_dir: &Path) -> Result<(), String> {
    let target_ports: &[u16] = &[80, 443, 8080];
    let orphaned = find_orphaned_traefik_proxy_pids(target_ports);

    if orphaned.is_empty() {
        return Ok(());
    }

    let pids: Vec<String> = orphaned.iter().map(|(pid, _)| pid.to_string()).collect();
    let ports: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        orphaned
            .iter()
            .filter(|(_, p)| seen.insert(*p))
            .map(|(_, p)| p.to_string())
            .collect()
    };

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Orphaned docker-proxy processes detected on Traefik ports [{}] (PIDs: {}). Attempting cleanup.",
            ports.join(", "),
            pids.join(", ")
        ),
    );

    // Attempt: sudo -n kill <pids>
    let mut kill_args = vec!["kill"];
    kill_args.extend(pids.iter().map(String::as_str));

    let kill_ok = std::process::Command::new("sudo")
        .arg("-n")
        .args(&kill_args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if kill_ok {
        // Poll briefly for the processes to disappear (up to ~2 s).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            let still_alive = find_orphaned_traefik_proxy_pids(target_ports);
            if still_alive.is_empty() {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    "Orphaned docker-proxy processes cleared; Traefik ports are now available.",
                );
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }

    // Best-effort cleanup; do not block hub startup when sudo is unavailable.
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Could not clear orphaned docker-proxy on ports [{}] (PIDs: {}). \
             If Traefik fails to start, run `sudo systemctl restart docker` or restart Docker Desktop.",
            ports.join(", "),
            pids.join(", ")
        ),
    );
    Ok(())
}

fn inspect_container_state_health(container_name: &str) -> String {
    docker_command()
        .args([
            "inspect",
            "--format",
            "{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
            container_name,
        ])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

fn wait_for_container_healthy(
    container_name: &str,
    display_name: &str,
    timeout_secs: u64,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut last_status = String::new();

    while Instant::now() < deadline {
        let status = inspect_container_state_health(container_name);
        if !status.is_empty() {
            last_status = status.clone();
        }

        if status == "running:healthy" {
            return Ok(());
        }

        let state = status.split(':').next().unwrap_or("");
        if matches!(state, "exited" | "dead") {
            return Err(format!(
                "{} container exited during startup (status: {}).",
                display_name, status
            ));
        }

        std::thread::sleep(Duration::from_secs(1));
    }

    Err(format!(
        "Timed out waiting for {} to become healthy (last status: {}).",
        display_name,
        if last_status.is_empty() {
            "unknown"
        } else {
            &last_status
        }
    ))
}

fn wait_for_hub_healthy() -> Result<(), String> {
    wait_for_container_healthy("ci-os-hub", "Hub", HUB_START_HEALTHY_TIMEOUT_SECS)
}

const POSTGRES_DB_CONTAINER: &str = "ci-hub-db";
const POSTGRES_DOCKER_NETWORK: &str = "ci-os-hub_network";

fn escape_sql_literal(value: &str) -> String {
    value.replace('\'', "''")
}

fn escape_shell_single_quoted(value: &str) -> String {
    value.replace('\'', "'\\''")
}

fn postgres_tcp_auth_works(password: &str) -> bool {
    let pgpassword = escape_shell_single_quoted(password);
    let script = format!(
        "PGPASSWORD='{pgpassword}' psql -h {POSTGRES_DB_CONTAINER} -p 6543 -U companion -d companiondb -qt -c 'SELECT 1'"
    );
    matches!(
        docker_command()
            .args([
                "run",
                "--rm",
                "--network",
                POSTGRES_DOCKER_NETWORK,
                "postgres:14",
                "bash",
                "-lc",
                &script,
            ])
            .output(),
        Ok(out) if out.status.success()
    )
}

fn sync_postgres_password(password: &str, data_dir: &Path) -> Result<(), String> {
    let sql = format!(
        "ALTER USER companion WITH PASSWORD '{}';",
        escape_sql_literal(password)
    );
    let mut cmd = docker_command();
    cmd.args([
        "exec",
        POSTGRES_DB_CONTAINER,
        "psql",
        "-U",
        "companion",
        "-d",
        "companiondb",
        "-p",
        "6543",
        "-c",
        &sql,
    ]);
    let output = cmd
        .output()
        .map_err(|error| format!("Failed to sync Postgres password: {}", error))?;

    if !output.status.success() {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        return Err(format!("Postgres password sync failed. {}", combined));
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Synced Postgres role password to match env.",
    );
    Ok(())
}

fn ensure_postgres_password_matches_env(env_path: &Path, data_dir: &Path) -> Result<(), String> {
    let values = load_runtime_env_values(data_dir, env_path);
    let Some(password) = get_non_empty_env_value(&values, "POSTGRES_PASSWORD") else {
        return Ok(());
    };

    if postgres_tcp_auth_works(&password) {
        return Ok(());
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Postgres TCP auth failed for configured password; syncing role password.",
    );

    sync_postgres_password(&password, data_dir)?;

    if !postgres_tcp_auth_works(&password) {
        return Err(
            "Postgres password sync did not restore TCP authentication for user companion."
                .to_string(),
        );
    }

    Ok(())
}

fn start_database_first(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Starting database service first to ensure initialization before full stack startup.",
    );

    let output = docker_command()
        .env("ENV_FILE", env_path)
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "up",
            "-d",
            "ci-hub-db",
        ])
        .output()
        .map_err(|error| {
            let message = format!("Failed to start database service: {}", error);
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    if !output.status.success() {
        let failure = if combined_output.is_empty() {
            format!(
                "Database bootstrap failed with exit code {:?}.",
                output.status.code()
            )
        } else {
            format!("Database bootstrap failed. {}", combined_output)
        };
        let _ = append_desktop_log_for(data_dir, "hub.start", &failure);
        return Err(with_view_logs_hint(failure));
    }

    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Database bootstrap command succeeded. Waiting for ci-hub-db health.",
    );

    wait_for_container_healthy("ci-hub-db", "Database", DB_START_HEALTHY_TIMEOUT_SECS).map_err(
        |error| {
            let message = format!("Database did not become healthy after bootstrap: {}", error);
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        },
    )
}

/// Start Hub using docker compose up (with port conflict resolution).
///
/// Uses a global `AtomicBool` guard to prevent concurrent invocations.
/// A `Drop` guard ensures the flag is cleared even if the inner logic panics.
pub fn start_hub(compose_path: &Path, env_path: &Path, data_dir: &Path) -> Result<String, String> {
    // Clear the user-stopped marker: the user has explicitly requested a start.
    if !stack_dev_mode_enabled() {
        clear_user_stopped(data_dir);
    }

    // Prevent concurrent start attempts.
    if START_IN_PROGRESS
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        let message = "A Hub start operation is already in progress — skipping duplicate request.";
        let _ = append_desktop_log_for(data_dir, "hub.start", message);
        return Ok(message.to_string());
    }

    // RAII guard: always clear the flag when the function exits, including panics.
    struct StartGuard;
    impl Drop for StartGuard {
        fn drop(&mut self) {
            START_IN_PROGRESS.store(false, Ordering::SeqCst);
        }
    }
    let _guard = StartGuard;

    start_hub_inner(compose_path, env_path, data_dir)
}

/// Inner start logic, called under the `START_IN_PROGRESS` guard.
fn start_hub_inner(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<String, String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Requested start via docker compose up -d\ncompose={}\nenv={}",
            compose_path.display(),
            env_path.display()
        ),
    );

    let traefik_preflight = prepare_traefik_runtime_state(data_dir).map_err(|error| {
        let message = format!("Traefik runtime preflight failed before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    if traefik_preflight.changed {
        mark_traefik_recreate_required(data_dir).map_err(|error| {
            let message = format!(
                "Traefik runtime preflight changed mounted state, but the recreate marker could not be written: {}",
                error
            );
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;
    }

    let recreate_traefik = is_traefik_recreate_required(data_dir);
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        &format!(
            "Traefik runtime preflight: changed={} repaired_conflicting_paths={} recreate_pending={}",
            traefik_preflight.changed,
            traefik_preflight.repaired_conflicting_paths,
            recreate_traefik
        ),
    );

    if recreate_traefik {
        remove_existing_traefik_container(data_dir).map_err(|error| {
            let message = format!("Traefik recreate preparation failed: {}", error);
            let _ = append_desktop_log_for(data_dir, "hub.start", &message);
            with_view_logs_hint(message)
        })?;
        // Traefik container has been removed — clear the marker now regardless of
        // whether compose-up succeeds.  The marker's purpose ("Traefik must be
        // recreated") is satisfied once the old container is gone.
        if let Err(error) = clear_traefik_recreate_required(data_dir) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Traefik container removed but the recreate marker could not be cleared: {}",
                    error
                ),
            );
        }
    }

    if !compose_path.exists() {
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
                let message = format!(
                    "Compose file was missing and recovery copy from {} failed: {}",
                    src.display(),
                    error
                );
                let _ = append_desktop_log_for(data_dir, "hub.start", &message);
                with_view_logs_hint(message)
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
        }
    }

    // Ensure the file-mounted Docker config path is a file, not a directory.
    // If Docker ever created this path with the wrong type, compose startup fails
    // with an OCI runtime mount error.
    ensure_hub_docker_config_state(data_dir).map_err(|error| {
        let message = format!(
            "Failed to prepare internal docker-config file before startup: {}",
            error
        );
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    let env_changed = ensure_runtime_env_state(data_dir, env_path).map_err(|error| {
        let message = format!(
            "Failed to prepare runtime env state before startup: {}",
            error
        );
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;
    if env_changed {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "Runtime env file was repaired before startup: {}",
                env_path.display()
            ),
        );
    }

    let config_hash = compute_config_hash(compose_path, env_path);
    let hash_path = data_dir.join(".config-hash");
    let saved_hash = std::fs::read_to_string(&hash_path).ok();
    let should_refresh_stack = env_changed || saved_hash.as_deref() != Some(config_hash.as_str());
    if should_refresh_stack {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            "Stack configuration changed — pulling images and recreating containers.",
        );
        if let Err(error) = pull_stack_images(compose_path, env_path, data_dir) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!("Stack image pull failed (non-fatal, continuing): {}", error),
            );
        }
    }

    // Surface host NVIDIA hardware to the backend even when the container lacks
    // direct GPU devices; this enables runtime-missing warnings instead of
    // misclassifying NVIDIA hosts as "no GPU detected".
    refresh_nvidia_host_probe_cache(data_dir);

    // Surface host macOS hardware (RAM, CPU, Apple Silicon) to the backend so it
    // can report correct values instead of the Docker VM's constrained resources.
    refresh_macos_host_probe_cache(data_dir);
    refresh_windows_host_metrics_probe_cache(data_dir);
    // Surface Linux host hardware so the backend reports true RAM/CPU instead of
    // the Docker Desktop VM's capped resources (e.g. 8 GB instead of 128 GB).
    refresh_linux_host_metrics_probe_cache(data_dir);

    // On Linux + Docker Desktop, best-effort raise VM memory (~75% host RAM) before compose up.
    ensure_docker_desktop_memory_linux(data_dir);

    // Release stale Docker publish mappings before resolving host ports.
    for port in [80u16, 443] {
        let _ = release_stale_port_publishers(port, data_dir, false);
    }
    let _ = release_orphaned_traefik_port_proxies(data_dir);

    // Resolve port conflicts and write to the runtime env file before starting.
    let resolution = crate::port_manager::refresh_ports_if_needed(env_path).map_err(|error| {
        let message = format!("Port resolution failed before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    // Log port resolution results (centralised into desktop.log)
    let mut log_lines = vec!["Port resolution:".to_string()];
    for w in &resolution.warnings {
        log_lines.push(format!("  WARN: {}", w));
    }
    for i in &resolution.info {
        log_lines.push(format!("  INFO: {}", i));
    }
    for (var, port) in &resolution.env_vars {
        log_lines.push(format!("  {}={}", var, port));
    }
    let _ = append_desktop_log_for(data_dir, "hub.start", &log_lines.join("\n"));

    // Bring up PostgreSQL first and wait for health so role/database initialization
    // completes before the rest of the stack starts.
    start_database_first(compose_path, env_path, data_dir)?;
    ensure_postgres_password_matches_env(env_path, data_dir)?;

    ensure_traefik_container_released(data_dir).map_err(|error| {
        let message = format!("Traefik port cleanup failed before startup: {}", error);
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    // Best-effort: release orphaned docker-proxy processes that may hold Traefik ports.
    let _ = release_orphaned_traefik_port_proxies(data_dir);

    ensure_host_state_tree_writable(data_dir).map_err(|error| {
        let message = format!(
            "Failed to prepare writable state directory before startup: {}",
            error
        );
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        with_view_logs_hint(message)
    })?;

    // Attempt compose up with automatic retry on transient container conflicts.
    let mut last_error = String::new();
    for attempt in 1..=MAX_START_RETRIES {
        if attempt > 1 {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Retry attempt {}/{} after transient failure.",
                    attempt, MAX_START_RETRIES
                ),
            );
        }

        let mut compose_up_args = vec![
            "compose".to_string(),
            "--env-file".to_string(),
            env_path.to_string_lossy().into_owned(),
            "--project-name".to_string(),
            "ci-hub".to_string(),
            "-f".to_string(),
            compose_path.to_string_lossy().into_owned(),
            "up".to_string(),
            "-d".to_string(),
        ];
        if should_refresh_stack {
            compose_up_args.extend([
                "--pull".to_string(),
                "always".to_string(),
                "--force-recreate".to_string(),
                "--remove-orphans".to_string(),
            ]);
        }
        let output = match docker_command()
            .env("ENV_FILE", env_path)
            .args(&compose_up_args)
            .output()
        {
            Ok(output) => output,
            Err(e) => {
                let message = format!("Failed to run docker compose up -d: {}", e);
                let _ = append_desktop_log_for(data_dir, "hub.start", &message);
                return Err(with_view_logs_hint(message));
            }
        };

        let combined_output = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );

        if output.status.success() {
            let compose_message = if combined_output.is_empty() {
                "docker compose up -d succeeded.".to_string()
            } else {
                format!("docker compose up -d succeeded. {}", combined_output)
            };
            let _ = append_desktop_log_for(data_dir, "hub.start", &compose_message);
            // Persist after compose up (even if health check fails later) so retries
            // and subsequent launches do not repeatedly pull/recreate unchanged stacks.
            persist_config_hash(data_dir, compose_path, env_path);
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Waiting for ci-os-hub to report running:healthy.",
            );

            match wait_for_hub_healthy() {
                Ok(()) => {
                    let _ = append_desktop_log_for(
                        data_dir,
                        "hub.start",
                        "Hub reached running:healthy state.",
                    );
                    return Ok("Hub started successfully".to_string());
                }
                Err(error) => {
                    let message = format!(
                        "docker compose up -d succeeded but Hub did not become ready: {}",
                        error
                    );
                    let _ = append_desktop_log_for(data_dir, "hub.start", &message);
                    return Err(with_view_logs_hint(message));
                }
            }
        }

        last_error = combined_output.clone();
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "docker compose up -d failed (attempt {}). {}",
                attempt, combined_output
            ),
        );

        // Container name conflicts are self-healable: run compose down to clear them,
        // then retry.
        if is_container_name_conflict(&combined_output) && attempt < MAX_START_RETRIES {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Detected stale container name conflict — running compose down to self-heal.",
            );
            let _ = cleanup_stale_project_containers(compose_path, env_path, data_dir);
            // Brief pause to let Docker release resources.
            std::thread::sleep(std::time::Duration::from_secs(2));
            continue;
        }

        if is_host_port_bind_conflict(&combined_output) && attempt < MAX_START_RETRIES {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Detected host port bind conflict — releasing stale publishers, re-resolving ports, and retrying.",
            );
            heal_host_port_bind_conflict(compose_path, env_path, data_dir, &combined_output);
            std::thread::sleep(std::time::Duration::from_secs(2));
            continue;
        }

        // The host path bind-mounted to /data/.docker/config.json can be poisoned as a directory.
        // Self-heal it and retry automatically.
        if is_docker_config_mount_path_error(&combined_output) && attempt < MAX_START_RETRIES {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "Detected docker-config mount path type mismatch — attempting self-heal and retry.",
            );
            if let Err(error) = ensure_hub_docker_config_state(data_dir) {
                let _ = append_desktop_log_for(
                    data_dir,
                    "hub.start",
                    &format!(
                        "Self-heal of hub docker-config path failed before retry: {}",
                        error
                    ),
                );
            }
            std::thread::sleep(Duration::from_secs(1));
            continue;
        }

        // Other OCI runtime errors indicate Docker Desktop / WSL2 issues — retrying without
        // user intervention is unlikely to help.
        if is_oci_runtime_error(&combined_output) {
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                "OCI runtime error detected — Docker Desktop may need to be restarted. Stopping retries.",
            );
            break;
        }

        // Any other transient failure — wait a moment and retry.
        if attempt < MAX_START_RETRIES {
            std::thread::sleep(std::time::Duration::from_secs(2u64.pow(attempt)));
        }
    }

    let failure = if last_error.is_empty() {
        "docker compose up -d failed after all retry attempts.".to_string()
    } else {
        format!("docker compose up -d failed. {}", last_error)
    };
    let _ = append_desktop_log_for(data_dir, "hub.start", &failure);
    Err(with_view_logs_hint(failure))
}

/// Best-effort write of the current compose/env fingerprint after startup.
///
/// Called from `start_hub_inner` so manual/tray starts persist the hash that
/// `should_refresh_stack` compares on the next launch.
pub(crate) fn persist_config_hash(data_dir: &Path, compose_path: &Path, env_path: &Path) {
    let hash_path = data_dir.join(".config-hash");
    let hash = compute_config_hash(compose_path, env_path);
    if let Err(error) = std::fs::write(&hash_path, &hash) {
        let _ = append_desktop_log_for(
            data_dir,
            "hub.start",
            &format!(
                "Failed to persist configuration hash at {}: {}",
                hash_path.display(),
                error
            ),
        );
    }
}

/// Drop the saved configuration hash so the next startup treats the stack as stale.
///
/// Used before host updates so post-install startup always pulls fresh images and
/// recreates containers instead of reusing ones from the previous binary version.
pub fn invalidate_config_hash(data_dir: &Path) {
    let hash_path = data_dir.join(".config-hash");
    let _ = std::fs::remove_file(&hash_path);
}

/// Compute a SHA256 hash of the compose and env file contents.
pub fn compute_config_hash(compose_path: &Path, env_path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    if let Ok(content) = std::fs::read(compose_path) {
        hasher.update(&content);
    }
    if let Ok(content) = std::fs::read(env_path) {
        hasher.update(&content);
    }
    format!("{:x}", hasher.finalize())
}

/// Pull all stack images before compose up when configuration changed.
pub fn pull_stack_images(
    compose_path: &Path,
    env_path: &Path,
    data_dir: &Path,
) -> Result<(), String> {
    let _ = append_desktop_log_for(
        data_dir,
        "hub.start",
        "Pulling stack images before startup…",
    );
    let output = docker_command()
        .env("ENV_FILE", env_path)
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "pull",
        ])
        .output()
        .map_err(|e| format!("Failed to run docker compose pull: {}", e))?;

    let combined = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    if output.status.success() {
        let message = if combined.is_empty() {
            "docker compose pull succeeded.".to_string()
        } else {
            format!("docker compose pull succeeded. {}", combined)
        };
        let _ = append_desktop_log_for(data_dir, "hub.start", &message);
        Ok(())
    } else {
        Err(if combined.is_empty() {
            format!(
                "docker compose pull failed with exit code {:?}",
                output.status.code()
            )
        } else {
            format!("docker compose pull failed. {}", combined)
        })
    }
}

/// Stop Hub containers without marking user-stopped (for updates).
pub fn stop_hub_for_update(compose_path: &Path, env_path: &Path) -> Result<String, String> {
    let data_dir = get_hub_data_dir();
    let _ = append_desktop_log_for(
        &data_dir,
        "hub.update",
        &format!(
            "Stopping stack for update\ncompose={}\nenv={}",
            compose_path.display(),
            env_path.display()
        ),
    );

    let output = docker_command()
        .env("ENV_FILE", env_path)
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "down",
        ])
        .output()
        .map_err(|e| format!("Failed to run docker compose down: {}", e))?;

    if output.status.success() {
        Ok("Hub stack stopped for update".to_string())
    } else {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        Err(format!("docker compose down failed. {}", combined))
    }
}

/// Stop Hub containers
pub fn stop_hub(compose_path: &Path, env_path: &Path) -> Result<String, String> {
    let data_dir = get_hub_data_dir();
    // Record that the user intentionally stopped the Hub so the next launch
    // does not auto-restart it.
    if !stack_dev_mode_enabled() {
        mark_user_stopped(&data_dir);
    }
    let _ = append_desktop_log_for(
        &data_dir,
        "hub.stop",
        &format!(
            "Requested stop via docker compose down{}\ncompose={}\nenv={}",
            if stack_dev_mode_enabled() {
                " (stack-dev mode: user-stopped marker unchanged)"
            } else {
                " (user-stopped marker set)"
            },
            compose_path.display(),
            env_path.display()
        ),
    );

    let output = docker_command()
        .env("ENV_FILE", env_path)
        .args([
            "compose",
            "--env-file",
            &env_path.to_string_lossy(),
            "--project-name",
            "ci-hub",
            "-f",
            &compose_path.to_string_lossy(),
            "down",
        ])
        .output()
        .map_err(|e| {
            let message = format!("Failed to run docker compose down: {}", e);
            let _ = append_desktop_log_for(&data_dir, "hub.stop", &message);
            with_view_logs_hint(message)
        })?;

    let combined_output = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );

    if output.status.success() {
        let message = if combined_output.is_empty() {
            "docker compose down succeeded.".to_string()
        } else {
            format!("docker compose down succeeded. {}", combined_output)
        };
        let _ = append_desktop_log_for(&data_dir, "hub.stop", &message);
        Ok("Hub stopped".to_string())
    } else {
        let failure = if combined_output.is_empty() {
            format!(
                "docker compose down failed with exit code {:?}.",
                output.status.code()
            )
        } else {
            format!("docker compose down failed. {}", combined_output)
        };
        let _ = append_desktop_log_for(&data_dir, "hub.stop", &failure);
        Err(with_view_logs_hint(failure))
    }
}

pub fn stop_managed_app_containers() -> Result<Option<String>, String> {
    let output = docker_command()
        .args(managed_app_container_ps_args())
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

    let ids = parse_container_ids(&String::from_utf8_lossy(&output.stdout));
    if ids.is_empty() {
        return Ok(None);
    }

    let mut command = docker_command();
    command.arg("stop");
    for id in &ids {
        command.arg(id);
    }

    let stop_output = command
        .output()
        .map_err(|error| format!("Failed to stop running app containers: {}", error))?;

    let combined_stop_output = format_command_output(
        &String::from_utf8_lossy(&stop_output.stdout),
        &String::from_utf8_lossy(&stop_output.stderr),
    );

    if stop_output.status.success() {
        Ok(Some(if combined_stop_output.is_empty() {
            format!("Stopped {} running app container(s).", ids.len())
        } else {
            format!(
                "Stopped {} running app container(s). {}",
                ids.len(),
                combined_stop_output
            )
        }))
    } else {
        Err(if combined_stop_output.is_empty() {
            format!(
                "Stopping running app containers failed with exit code {:?}.",
                stop_output.status.code()
            )
        } else {
            format!(
                "Stopping running app containers failed. {}",
                combined_stop_output
            )
        })
    }
}

/// Parse a .env file into a HashMap of key-value pairs.
fn parse_env_file(path: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                map.insert(key.trim().to_string(), value.trim().to_string());
            }
        }
    }
    map
}

/// Returns `true` when the Tailscale sidecar (`hub-tailscale`) should run.
///
/// The sidecar is **on by default** for every stack (dev, prod, Tauri desktop, docker-only).
/// Disable only when the hub `.env` contains an explicit opt-out:
/// `PRIVATE_VPN_USER_DISABLED=true` (written by [`render_runtime_env_content`] when the user turns
/// VPN off). Compose actually starts the container when `COMPOSE_PROFILES` includes `private-vpn`
/// (merged in the same render path). Legacy `PRIVATE_VPN_ENABLED` in old `.env` files is ignored.
fn private_vpn_enabled_from_map(env: &std::collections::HashMap<String, String>) -> bool {
    !matches!(
        env.get("PRIVATE_VPN_USER_DISABLED").map(|v| v.as_str()),
        Some("true")
    )
}

fn reset_vpn_sidecar_status_poll_phase() {
    *lock_recovering(&VPN_SIDECAR_STATUS_POLL_PHASE) = VpnSidecarPollPhase::PendingReady;
}

/// `hub-tailscale` must be [`ServiceState::Ready`]: running (no healthcheck → `none` counts as ready).
fn vpn_sidecars_ready() -> bool {
    let names = ["hub-tailscale"];
    let states = inspect_containers(&names);
    for name in names {
        match states.get(name) {
            Some((state, health)) => {
                let svc_state = derive_service_state(state.as_str(), health.as_str());
                if !matches!(svc_state, ServiceState::Ready) {
                    return false;
                }
            }
            None => return false,
        }
    }
    true
}

/// Cached by hub `.env` file mtime so frequent [`get_hub_status`] polls do not re-read and parse the file.
fn is_private_vpn_enabled() -> bool {
    let path = hub_env_path();
    let mtime = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok());
    let mut guard = lock_recovering(&PRIVATE_VPN_ENV_CACHE);
    if let Some((cached_mtime, cached_val)) = guard.as_ref() {
        if *cached_mtime == mtime {
            return *cached_val;
        }
    }
    let val = private_vpn_enabled_from_map(&parse_env_file(&path));
    *guard = Some((mtime, val));
    val
}

/// Deduplicate comma-separated profile names while preserving first-seen order (stable across repeated merges).
fn dedupe_compose_profile_tokens(tokens: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    let mut out = Vec::new();
    for t in tokens {
        if seen.insert(t.clone()) {
            out.push(t);
        }
    }
    out
}

fn has_cloudflare_tunnel_token(existing: &std::collections::HashMap<String, String>) -> bool {
    let Some(root) = get_non_empty_env_value(existing, "ROOT_FOLDER_HOST") else {
        return false;
    };
    let token_path = PathBuf::from(root).join("..").join("tunnel").join("token");
    std::fs::metadata(&token_path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Ensures `private-vpn` and `cloudflare` compose profiles when enabled, without dropping other profiles.
fn merge_compose_profiles(
    existing: &std::collections::HashMap<String, String>,
    vpn_on: bool,
) -> String {
    let raw = existing
        .get("COMPOSE_PROFILES")
        .map(|s| s.as_str())
        .unwrap_or("")
        .trim();
    let tokens: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut parts = dedupe_compose_profile_tokens(tokens);

    if vpn_on {
        if !parts.iter().any(|p| p == "private-vpn") {
            parts.push("private-vpn".into());
        }
    } else {
        parts.retain(|p| p != "private-vpn");
    }

    if has_cloudflare_tunnel_token(existing) {
        if !parts.iter().any(|p| p == "cloudflare") {
            parts.push("cloudflare".into());
        }
    } else {
        parts.retain(|p| p != "cloudflare");
    }

    parts.join(",")
}

fn get_non_empty_env_value(
    existing: &std::collections::HashMap<String, String>,
    key: &str,
) -> Option<String> {
    existing
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn render_runtime_env_content(
    data_dir: &Path,
    existing: &std::collections::HashMap<String, String>,
) -> String {
    let root_folder_host = get_non_empty_env_value(existing, "ROOT_FOLDER_HOST")
        .unwrap_or_else(|| compute_data_dir_str(data_dir));
    let jwt_secret =
        get_non_empty_env_value(existing, "JWT_SECRET").unwrap_or_else(|| generate_hex(64));
    let postgres_password =
        get_non_empty_env_value(existing, "POSTGRES_PASSWORD").unwrap_or_else(|| generate_hex(32));
    // Tailscale sidecar: on by default (dev/prod/Tauri/docker-only). Opt-out only via
    // PRIVATE_VPN_USER_DISABLED=true. Compose gates hub-tailscale with COMPOSE_PROFILES=private-vpn.
    let vpn_on = private_vpn_enabled_from_map(existing);
    // When opted out, persist the sentinel; when enabled, omit it so the default applies.
    let private_vpn_user_disabled_line = if vpn_on {
        String::new()
    } else {
        "PRIVATE_VPN_USER_DISABLED=true\n".to_string()
    };
    let compose_profiles = merge_compose_profiles(existing, vpn_on);
    // Omit when empty: Compose treats unset COMPOSE_PROFILES like "", but a bare `COMPOSE_PROFILES=`
    // line is noisy and can unintentionally override a user-defined shell value with emptiness.
    let compose_profiles_line = if compose_profiles.is_empty() {
        String::new()
    } else {
        format!("COMPOSE_PROFILES={compose_profiles}\n")
    };

    // Inject a stable device ID from the host's /etc/machine-id so the backend
    // container always uses the same host-level identity regardless of container
    // restarts or recreation (container machine-id differs from host machine-id).
    let device_id_line = match std::fs::read_to_string("/etc/machine-id") {
        Ok(id) => {
            let id = id.trim();
            if id.is_empty() {
                String::new()
            } else {
                format!("DEVICE_ID={id}\n")
            }
        }
        Err(_) => String::new(),
    };

    let domain = option_env!("CI_HUB_DOMAIN").unwrap_or(default_public_domain());
    let cloud_url = option_env!("CI_HUB_CLOUD_URL").unwrap_or(default_ci_cloud_url());
    let hub_version = option_env!("CI_HUB_BUILD_VERSION").unwrap_or("4.7.0");
    // Always recompute from the current binary so upgrades pick up the new stack image tag.
    let hub_image = image_for_domain(domain).to_string();
    let docker_platform = if cfg!(target_arch = "aarch64") {
        "linux/arm64"
    } else {
        "linux/amd64"
    };
    let (container_uid, container_gid, docker_gid) = resolve_hub_container_identity();
    let docker_gid_line = format!("DOCKER_GID={docker_gid}\n");
    let sentry_dsn_line = get_non_empty_env_value(existing, "SENTRY_DSN")
        .map(|dsn| format!("SENTRY_DSN={dsn}\n"))
        .unwrap_or_default();
    let sentry_desktop_dsn_line = get_non_empty_env_value(existing, "SENTRY_DESKTOP_DSN")
        .or_else(|| option_env!("SENTRY_DESKTOP_DSN").map(|dsn| dsn.to_string()))
        .filter(|dsn| !dsn.trim().is_empty())
        .map(|dsn| format!("SENTRY_DESKTOP_DSN={dsn}\n"))
        .unwrap_or_default();
    let docker_socket_path = host_docker_socket_path();
    let docker_socket_path_line = format!(
        "DOCKER_SOCKET_PATH={}\n",
        docker_socket_path.to_string_lossy()
    );

    format!(
        "# Preserved (generated once, survive upgrades)\n\
         ROOT_FOLDER_HOST={root_folder_host}\n\
         JWT_SECRET={jwt_secret}\n\
         POSTGRES_PASSWORD={postgres_password}\n\
         \n\
         # Derived (recomputed every launch from the current binary)\n\
         INTERNAL_IP=0.0.0.0\n\
         DOMAIN={domain}\n\
         CI_CLOUD_URL={cloud_url}\n\
         CI_HUB_VERSION={hub_version}\n\
         CI_HUB_IMAGE={hub_image}\n\
         DOCKER_PLATFORM={docker_platform}\n\
         {docker_socket_path_line}\
         {docker_gid_line}\
         CI_HUB_CONTAINER_UID={container_uid}\n\
         CI_HUB_CONTAINER_GID={container_gid}\n\
         {private_vpn_user_disabled_line}\
         {compose_profiles_line}\
         {device_id_line}\
         {sentry_desktop_dsn_line}\
         {sentry_dsn_line}",
        root_folder_host = root_folder_host,
        jwt_secret = jwt_secret,
        postgres_password = postgres_password,
        domain = domain,
        cloud_url = cloud_url,
        hub_version = hub_version,
        hub_image = hub_image,
        docker_socket_path_line = docker_socket_path_line,
        docker_platform = docker_platform,
        docker_gid_line = docker_gid_line,
        container_uid = container_uid,
        container_gid = container_gid,
        private_vpn_user_disabled_line = private_vpn_user_disabled_line,
        compose_profiles_line = compose_profiles_line,
        device_id_line = device_id_line,
        sentry_desktop_dsn_line = sentry_desktop_dsn_line,
        sentry_dsn_line = sentry_dsn_line,
    )
}

fn ensure_runtime_env_state(data_dir: &Path, env_path: &Path) -> Result<bool, String> {
    let existing = load_runtime_env_values(data_dir, env_path);
    let env_content = render_runtime_env_content(data_dir, &existing);
    let previous_content = std::fs::read_to_string(env_path).unwrap_or_default();
    let changed = strip_port_vars(&previous_content) != env_content;

    if changed {
        std::fs::write(env_path, &env_content).map_err(|e| {
            format!(
                "Failed to write runtime env file at {}: {}",
                env_path.display(),
                e
            )
        })?;
    }

    let compat_env_path = compat_hub_env_path_for(data_dir);
    if compat_env_path != env_path {
        let _ = std::fs::write(&compat_env_path, &env_content);
    }

    Ok(changed)
}

/// Generate a random hex string of the given byte length.
fn generate_hex(bytes: usize) -> String {
    (0..bytes)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect()
}

/// Determine the Hub container image tag from the domain.
pub fn image_for_domain(domain: &str) -> &'static str {
    match domain {
        "ci.computer" | "companionintelligence.org" => {
            "ghcr.io/companionintelligence/ci-hub:latest"
        }
        "companionintel.com" => "ghcr.io/companionintelligence/ci-hub:staging",
        _ => "ghcr.io/companionintelligence/ci-hub:dev",
    }
}

/// Compute the data directory path string, handling Windows Docker Desktop paths.
fn compute_data_dir_str(data_dir: &Path) -> String {
    if cfg!(windows) {
        let path = data_dir.to_string_lossy().to_string();
        if path.len() >= 2 && path.chars().nth(1) == Some(':') {
            let drive = path.chars().next().unwrap().to_lowercase().to_string();
            format!("/{}{}", drive, path[2..].replace('\\', "/"))
        } else {
            path.replace('\\', "/")
        }
    } else {
        data_dir.to_string_lossy().to_string()
    }
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

/// Initialize Hub data directory and generate .env file.
///
/// Uses a regenerate-and-preserve approach:
/// - Preserved values (read from existing .env, generated if missing): ROOT_FOLDER_HOST, JWT_SECRET, POSTGRES_PASSWORD
/// - Derived values (always recomputed from the current binary): INTERNAL_IP, DOMAIN, CI_CLOUD_URL, CI_HUB_VERSION, CI_HUB_IMAGE, DOCKER_PLATFORM, DEVICE_ID
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
        log_lines.push("  -> WARNING: no compose file found in any candidate path!".to_string());
        let _ = append_desktop_log_for(
            &data_dir,
            "initialize",
            "No docker-compose.prod.yml resource was found in any candidate path.",
        );
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

    // Write the primary runtime env file (port manager will append dynamic port vars after this)
    let old_content = std::fs::read_to_string(&env_path).unwrap_or_default();
    // Strip port vars from old content for comparison (port manager manages those)
    let env_changed = strip_port_vars(&old_content) != env_content;
    std::fs::write(&env_path, &env_content).map_err(|e| {
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
/// hooks), preserves inline `auth` entries, and also preserves `credsStore`
/// and `credHelpers` entries when they are not in the host-only list.
///
/// If the destination path is a directory (stale Docker placeholder from a
/// previous failed mount), it is removed first.
///
/// `host_docker_dir` overrides the default `~/.docker` directory (used by
/// tests to avoid mutating global environment variables).
fn generate_container_docker_config(
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

    // Only auths (inline), credsStore (non-host-only), and credHelpers
    // (non-host-only) are preserved.  Everything else is dropped:
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

/// Strip dynamic port variables from .env content for comparison purposes.
/// Port manager owns these vars and rewrites them each launch.
fn strip_port_vars(content: &str) -> String {
    let port_vars = [
        "API_PORT=",
        "POSTGRES_PORT=",
        "RABBITMQ_PORT=",
        "TRAEFIK_DASHBOARD_PORT=",
        "HTTP_PORT=",
        "HTTPS_PORT=",
    ];
    content
        .lines()
        .filter(|line| !port_vars.iter().any(|pv| line.starts_with(pv)))
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

pub fn install_docker() -> Result<DockerInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_docker_linux().map(|detail| DockerInstallResult {
            // Linux always needs a logout/login for docker group membership to take effect.
            state: DockerInstallState::NeedsRestart,
            detail: Some(detail),
        });
    }

    #[cfg(target_os = "windows")]
    {
        return install_docker_windows();
    }

    #[cfg(target_os = "macos")]
    {
        return install_docker_macos();
    }

    #[allow(unreachable_code)]
    Err("Docker installation is not supported on this platform".to_string())
}

#[cfg(any(test, target_os = "windows"))]
fn docker_desktop_windows_install_script(download_url: &str) -> String {
    format!(
        r#"param([string]$AppUser)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
& wsl --status | Out-Null
if ($LASTEXITCODE -ne 0) {{
  & wsl --install --no-distribution
  exit 100
}}
$installer = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.exe')
Remove-Item $installer -Force -ErrorAction SilentlyContinue
try {{
  Invoke-WebRequest -UseBasicParsing -Uri '{download_url}' -OutFile $installer
  $signature = Get-AuthenticodeSignature $installer
  if ($signature.Status -ne 'Valid') {{
    throw "Downloaded Docker Desktop installer signature validation failed: $($signature.Status)"
  }}
  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'Docker') {{
    throw "Downloaded Docker Desktop installer signer was not recognized as Docker."
  }}
  $installProcess = Start-Process -Wait -PassThru -FilePath $installer -ArgumentList 'install','--quiet','--accept-license','--backend=wsl-2','--always-run-service'
  if ($installProcess.ExitCode -ne 0) {{
    exit $installProcess.ExitCode
  }}
  $groupResult = & net.exe localgroup docker-users "$AppUser" /add 2>&1
  if ($LASTEXITCODE -ne 0) {{
    $groupText = ($groupResult | Out-String)
    if ($groupText -notmatch 'already a member') {{
      throw "Failed to add user to docker-users: $groupText"
    }}
  }}
}} finally {{
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
}}
exit 0
"#,
        download_url = download_url,
    )
}

#[cfg(target_os = "windows")]
fn install_docker_windows() -> Result<DockerInstallResult, String> {
    use std::io::Write as IoWrite;

    let username = resolve_current_username_windows()?;
    // PowerShell -File refuses scripts without a .ps1 extension.
    let mut script = tempfile::Builder::new()
        .suffix(".ps1")
        .tempfile()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(
            docker_desktop_windows_install_script(DOCKER_DESKTOP_WINDOWS_INSTALLER_URL).as_bytes(),
        )
        .map_err(|e| format!("Failed to write Windows installer script: {}", e))?;

    let launch_command = format!(
        "$process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{}','-AppUser','{}'); exit $process.ExitCode",
        escape_powershell_single_quoted(&script.path().to_string_lossy()),
        escape_powershell_single_quoted(&username),
    );

    let mut command = Command::new("powershell.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &launch_command,
        ])
        .output()
        .map_err(|e| format!("Failed to launch elevated Docker Desktop installer: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let combined = if !stderr.is_empty() && !stdout.is_empty() {
        format!("{}\n{}", stderr, stdout)
    } else if !stderr.is_empty() {
        stderr.clone()
    } else {
        stdout.clone()
    };
    let combined_lower = combined.to_lowercase();

    match output.status.code() {
        Some(0) => {
            let _ = launch_docker_desktop_windows();
            Ok(DockerInstallResult {
                state: DockerInstallState::Completed,
                detail: Some(
                    "Docker Desktop installation completed. Waiting for Docker to become ready."
                        .to_string(),
                ),
            })
        }
        Some(100) => Ok(DockerInstallResult {
            state: DockerInstallState::NeedsRestart,
            detail: Some(
                "WSL was installed or enabled. Restart Windows, then reopen Companion Hub to continue Docker setup."
                    .to_string(),
            ),
        }),
        _ if combined_lower.contains("cancel") && combined_lower.contains("user") => {
            Err("Authorization was cancelled or denied.".to_string())
        }
        _ if combined.is_empty() => Err(format!(
            "Docker Desktop installation failed with exit code {:?}.",
            output.status.code()
        )),
        _ => Err(format!("Docker Desktop installation failed: {}", combined)),
    }
}

#[cfg(target_os = "windows")]
fn resolve_current_username_windows() -> Result<String, String> {
    if let Ok(username) = std::env::var("USERNAME") {
        let username = username.trim();
        if !username.is_empty() {
            return Ok(username.to_string());
        }
    }

    let mut command = Command::new("whoami");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|e| format!("Failed to resolve current username: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to resolve current username: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let username = String::from_utf8_lossy(&output.stdout)
        .trim()
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_string();
    if username.is_empty() {
        Err("Failed to resolve current username.".to_string())
    } else {
        Ok(username)
    }
}

#[cfg(target_os = "windows")]
fn escape_powershell_single_quoted(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(target_os = "windows")]
fn launch_docker_desktop_windows() -> Result<(), String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    for env_var in ["ProgramFiles", "ProgramW6432"] {
        if let Ok(root) = std::env::var(env_var) {
            candidates.push(
                Path::new(&root)
                    .join("Docker")
                    .join("Docker")
                    .join("Docker Desktop.exe"),
            );
        }
    }

    let app = candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| {
            "Docker Desktop was installed, but the app launcher could not be found.".to_string()
        })?;

    let mut command = Command::new(app);
    command.creation_flags(CREATE_NO_WINDOW);
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch Docker Desktop: {}", e))
}

#[cfg(any(test, target_os = "macos"))]
fn docker_desktop_macos_install_script(download_url: &str, username: &str) -> String {
    format!(
        r#"#!/bin/bash
set -euo pipefail
workdir="$(mktemp -d)"
cleanup() {{
  if mount | grep -q "$workdir/mnt"; then
    hdiutil detach "$workdir/mnt" -quiet || true
  fi
  rm -rf "$workdir"
}}
trap cleanup EXIT

dmg="$workdir/Docker.dmg"
mount_dir="$workdir/mnt"
mkdir -p "$mount_dir"
curl -L --fail -o "$dmg" "{download_url}"
spctl --assess --type open --verbose=2 "$dmg"
hdiutil attach "$dmg" -mountpoint "$mount_dir" -nobrowse -quiet
codesign --verify --deep --strict --verbose=2 "$mount_dir/Docker.app"
spctl --assess --type execute --verbose=2 "$mount_dir/Docker.app"
"$mount_dir/Docker.app/Contents/MacOS/install" --accept-license --user="{username}"
"#,
        download_url = download_url,
        username = username,
    )
}

#[cfg(target_os = "macos")]
fn install_docker_macos() -> Result<DockerInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let username = resolve_current_username_macos()?;
    let mut script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(
            docker_desktop_macos_install_script(docker_desktop_macos_download_url(), &username)
                .as_bytes(),
        )
        .map_err(|e| format!("Failed to write macOS installer script: {}", e))?;

    script
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Failed to set macOS installer script permissions: {}", e))?;

    let applescript = format!(
        "do shell script quoted form of POSIX path of \"{}\" with administrator privileges",
        script.path().to_string_lossy().replace('"', "\\\"")
    );

    let output = Command::new("osascript")
        .args(["-e", &applescript])
        .output()
        .map_err(|e| format!("Failed to launch elevated Docker Desktop installer: {}", e))?;

    if output.status.success() {
        let _ = launch_docker_desktop_macos();
        Ok(DockerInstallResult {
            state: DockerInstallState::Completed,
            detail: Some(
                "Docker Desktop installation completed. Waiting for Docker to become ready."
                    .to_string(),
            ),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = if !stderr.is_empty() && !stdout.is_empty() {
            format!("{}\n{}", stderr, stdout)
        } else if !stderr.is_empty() {
            stderr
        } else {
            stdout
        };
        let combined_lower = combined.to_lowercase();

        if combined_lower.contains("cancel") && combined_lower.contains("user") {
            Err("Authorization was cancelled or denied.".to_string())
        } else if combined.is_empty() {
            Err("Docker Desktop installation failed.".to_string())
        } else {
            Err(format!("Docker Desktop installation failed: {}", combined))
        }
    }
}

#[cfg(target_os = "macos")]
fn docker_desktop_macos_download_url() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        DOCKER_DESKTOP_MACOS_ARM_URL
    } else {
        DOCKER_DESKTOP_MACOS_INTEL_URL
    }
}

#[cfg(target_os = "macos")]
fn resolve_current_username_macos() -> Result<String, String> {
    if let Ok(username) = std::env::var("USER") {
        let username = username.trim();
        if !username.is_empty() {
            return Ok(username.to_string());
        }
    }

    let output = Command::new("id")
        .args(["-un"])
        .output()
        .map_err(|e| format!("Failed to resolve current username: {}", e))?;
    if !output.status.success() {
        return Err(format!(
            "Failed to resolve current username: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if username.is_empty() {
        Err("Failed to resolve current username.".to_string())
    } else {
        Ok(username)
    }
}

#[cfg(target_os = "macos")]
fn launch_docker_desktop_macos() -> Result<(), String> {
    Command::new("open")
        .args(["-a", "Docker"])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch Docker Desktop: {}", e))
}

/// Install Docker Engine on Linux.
///
/// Detects the distro from /etc/os-release and picks the right package manager:
///   - Arch-based (Arch, Manjaro, EndeavourOS, Garuda): pacman
///   - Alpine: apk + OpenRC
///   - SUSE-based (openSUSE Leap/Tumbleweed, SLES): zypper
///   - RHEL: official Docker dnf repo (get.docker.com doesn't support RHEL)
///   - Everything else (Debian, Ubuntu, Raspberry Pi OS, Fedora, CentOS, Rocky, etc.):
///     Docker's official get.docker.com convenience script; auto-installs curl/wget
///     if neither is present.
///
/// Adds the current user to the docker group and enables the Docker service via
/// systemd or OpenRC as available. Uses pkexec (polkit) for the GUI privilege prompt.
#[cfg(target_os = "linux")]
pub fn install_docker_linux() -> Result<String, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let username = resolve_current_username()?;
    let pkexec_path = find_executable("pkexec").ok_or_else(|| {
        "pkexec is not installed or not on PATH. Install polkit/pkexec and try again.".to_string()
    })?;

    let mut wrapper_script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary install script: {}", e))?;
    wrapper_script
        .write_all(
            br#"#!/bin/bash
# Docker auto-installer for Companion Hub. Runs as root via pkexec.
# Arg 1: username to add to the docker group.
set -e
export DEBIAN_FRONTEND=noninteractive
USERNAME="$1"

# -- Distro detection ---------------------------------------------------------
DISTRO_ID="unknown"
DISTRO_LIKE=""
if [ -f /etc/os-release ]; then
    DISTRO_ID="$(. /etc/os-release && printf '%s' "${ID:-unknown}")"
    DISTRO_LIKE="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
fi

# True if ID equals $1 OR ID_LIKE contains $1 as a whitespace-delimited word.
is_distro() {
    [ "$DISTRO_ID" = "$1" ] && return 0
    case " $DISTRO_LIKE " in *" $1 "*) return 0;; esac
    return 1
}

# -- Init-system: enable + start docker --------------------------------------
enable_and_start_docker() {
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        systemctl enable docker
        systemctl start docker
    elif command -v rc-update >/dev/null 2>&1; then
        rc-update add docker boot || true
        rc-service docker start || true
    elif command -v service >/dev/null 2>&1; then
        service docker start || true
    fi
}

# -- Download helper: curl then wget ------------------------------------------
download_to() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$2" "$1"
    else
        return 1
    fi
}

# -- Per-distro install -------------------------------------------------------

if is_distro arch || is_distro manjaro || is_distro endeavouros || is_distro garuda; then
    pacman -Sy --noconfirm docker docker-compose
    enable_and_start_docker

elif is_distro alpine; then
    apk add --no-cache docker docker-cli-compose
    rc-update add docker boot 2>/dev/null || true
    rc-service docker start 2>/dev/null || true

elif is_distro suse || is_distro opensuse-leap || is_distro opensuse-tumbleweed || is_distro sles; then
    zypper --non-interactive install docker docker-compose
    enable_and_start_docker

elif [ "$DISTRO_ID" = "rhel" ]; then
    # Only true RHEL (ID=rhel): get.docker.com does not support it; use the Docker dnf repo.
    # Rocky Linux, AlmaLinux, CentOS (all have ID_LIKE containing "rhel") are handled by
    # get.docker.com below -- do NOT use is_distro here or they fall into this branch.
    dnf install -y dnf-plugins-core
    # dnf 5 (RHEL 9+) syntax vs dnf 4 (RHEL 8) syntax
    if ! dnf config-manager addrepo \
            --from-repofile https://download.docker.com/linux/rhel/docker-ce.repo 2>/dev/null; then
        dnf config-manager --add-repo \
            https://download.docker.com/linux/rhel/docker-ce.repo
    fi
    dnf install -y docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    enable_and_start_docker

else
    # Debian, Ubuntu, Raspberry Pi OS, Fedora, CentOS, Rocky Linux, and others.
    # Docker's official convenience script handles all of these.

    # Ensure a downloader is available; install curl if neither curl nor wget is
    # present. ca-certificates rides along: apt treats it as a Recommends, so
    # --no-install-recommends curl alone cannot do HTTPS (curl error 77).
    if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
            apt-get install -y --no-install-recommends curl ca-certificates
        elif command -v dnf >/dev/null 2>&1; then
            dnf install -y curl ca-certificates
        elif command -v yum >/dev/null 2>&1; then
            yum install -y curl ca-certificates
        else
            printf 'Error: curl/wget not found and could not be installed automatically.\n' >&2
            printf 'Install curl first, then retry.\n' >&2
            exit 1
        fi
    fi

    installer_script="$(mktemp)"
    trap 'rm -f "$installer_script"' EXIT
    download_to https://get.docker.com "$installer_script" \
        || { printf 'Error: failed to download Docker installer from get.docker.com\n' >&2; exit 1; }
    sh "$installer_script"
    enable_and_start_docker
fi

# -- Add user to the docker group (common to all distros) --------------------
if getent group docker >/dev/null 2>&1; then
    usermod -aG docker "$USERNAME"
fi
"#,
        )
        .map_err(|e| format!("Failed to write install script: {}", e))?;

    let permissions = std::fs::Permissions::from_mode(0o700);
    wrapper_script
        .as_file()
        .set_permissions(permissions)
        .map_err(|e| format!("Failed to set install script permissions: {}", e))?;

    let output = Command::new(&pkexec_path)
        .arg(wrapper_script.path())
        .arg(&username)
        .output()
        .map_err(|e| format!("Failed to run pkexec installer: {}", e))?;

    if output.status.success() {
        Ok("Docker installed successfully. You may need to log out and back in for group changes to take effect.".to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = format_command_output(&stdout, &stderr);
        let combined_lower = combined.to_lowercase();

        if combined_lower.contains("dismissed")
            || combined_lower.contains("not authorized")
            || combined_lower.contains("authorization required")
            || combined_lower.contains("authentication failed")
        {
            Err("Authorization was cancelled or denied.".to_string())
        } else if combined.is_empty() {
            Err(format!(
                "Docker installation failed with exit code {:?}.",
                output.status.code()
            ))
        } else {
            Err(format!("Docker installation failed: {}", combined))
        }
    }
}

#[cfg(target_os = "linux")]
fn resolve_current_username() -> Result<String, String> {
    let output = Command::new("id")
        .args(["-un"])
        .output()
        .map_err(|e| format!("Failed to resolve current username: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "Failed to resolve current username: {}",
            format_command_output(
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr)
            )
        ));
    }

    let username = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if username.is_empty() {
        Err("Failed to resolve current username from current UID.".to_string())
    } else {
        Ok(username)
    }
}

#[cfg(target_os = "linux")]
fn find_executable(binary: &str) -> Option<PathBuf> {
    Command::new("which")
        .arg(binary)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() {
                None
            } else {
                Some(PathBuf::from(path))
            }
        })
}

/// Install Ollama on the current platform.
///
/// - Linux: official install.sh via pkexec (binary to /usr/local, systemd unit,
///   `ollama` system user, NVIDIA/AMD GPU detection — all handled by the script).
/// - macOS: Ollama-darwin.zip (universal binary) verified with codesign/spctl,
///   installed to /Applications with the CLI symlinked, launched hidden.
/// - Windows: OllamaSetup.exe (Inno Setup, per-user — no elevation needed),
///   Authenticode-verified, run with /VERYSILENT; the tray app auto-starts.
///
/// The Ollama API listens on 127.0.0.1:11434 on every platform.
pub fn install_ollama() -> Result<OllamaInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_ollama_linux();
    }

    #[cfg(target_os = "windows")]
    {
        return install_ollama_windows();
    }

    #[cfg(target_os = "macos")]
    {
        return install_ollama_macos();
    }

    #[allow(unreachable_code)]
    Err("Ollama auto-install is not supported on this platform.".to_string())
}

#[cfg(any(test, target_os = "windows"))]
fn ollama_windows_install_script(download_url: &str) -> String {
    format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$installer = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.exe')
Remove-Item $installer -Force -ErrorAction SilentlyContinue
try {{
  Invoke-WebRequest -UseBasicParsing -Uri '{download_url}' -OutFile $installer
  $signature = Get-AuthenticodeSignature $installer
  if ($signature.Status -ne 'Valid') {{
    throw "Downloaded Ollama installer signature validation failed: $($signature.Status)"
  }}
  if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch 'Ollama') {{
    throw "Downloaded Ollama installer signer was not recognized as Ollama."
  }}
  $installProcess = Start-Process -Wait -PassThru -FilePath $installer -ArgumentList '/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES'
  if ($installProcess.ExitCode -ne 0) {{
    exit $installProcess.ExitCode
  }}
}} finally {{
  Remove-Item $installer -Force -ErrorAction SilentlyContinue
}}
exit 0
"#,
        download_url = download_url,
    )
}

/// OllamaSetup.exe is an Inno Setup installer with PrivilegesRequired=lowest —
/// it installs per-user to %LOCALAPPDATA%\Programs\Ollama, so unlike the Docker
/// installer no elevation is required. The installer adds Ollama to the user
/// PATH and launches the tray app itself.
#[cfg(target_os = "windows")]
fn install_ollama_windows() -> Result<OllamaInstallResult, String> {
    use std::io::Write as IoWrite;

    // PowerShell -File refuses scripts without a .ps1 extension.
    let mut script = tempfile::Builder::new()
        .suffix(".ps1")
        .tempfile()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(ollama_windows_install_script(OLLAMA_WINDOWS_INSTALLER_URL).as_bytes())
        .map_err(|e| format!("Failed to write Windows installer script: {}", e))?;

    let mut command = Command::new("powershell.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script.path().to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("Failed to launch Ollama installer: {}", e))?;

    if output.status.success() {
        Ok(OllamaInstallResult {
            state: OllamaInstallState::Completed,
            detail: Some(
                "Ollama installed. The API is available at http://127.0.0.1:11434.".to_string(),
            ),
        })
    } else {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        if combined.is_empty() {
            Err(format!(
                "Ollama installation failed with exit code {:?}.",
                output.status.code()
            ))
        } else {
            Err(format!("Ollama installation failed: {}", combined))
        }
    }
}

#[cfg(any(test, target_os = "macos"))]
fn ollama_macos_install_script(download_url: &str) -> String {
    format!(
        r#"#!/bin/bash
set -euo pipefail
workdir="$(mktemp -d)"
cleanup() {{
  rm -rf "$workdir"
}}
trap cleanup EXIT

zip="$workdir/Ollama-darwin.zip"
curl -L --fail -o "$zip" "{download_url}"
ditto -x -k "$zip" "$workdir/extracted"
app="$workdir/extracted/Ollama.app"
test -d "$app"
codesign --verify --deep --strict --verbose=2 "$app"
spctl --assess --type execute --verbose=2 "$app"
pkill -x Ollama 2>/dev/null || true
rm -rf /Applications/Ollama.app
ditto "$app" /Applications/Ollama.app
mkdir -p /usr/local/bin
ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama
"#,
        download_url = download_url,
    )
}

#[cfg(target_os = "macos")]
fn install_ollama_macos() -> Result<OllamaInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let mut script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(ollama_macos_install_script(OLLAMA_MACOS_ZIP_URL).as_bytes())
        .map_err(|e| format!("Failed to write macOS installer script: {}", e))?;
    script
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Failed to set macOS installer script permissions: {}", e))?;

    let applescript = format!(
        "do shell script quoted form of POSIX path of \"{}\" with administrator privileges",
        script.path().to_string_lossy().replace('"', "\\\"")
    );

    let output = Command::new("osascript")
        .args(["-e", &applescript])
        .output()
        .map_err(|e| format!("Failed to launch elevated Ollama installer: {}", e))?;

    if output.status.success() {
        // Launch as the current user (not root) so the menu-bar app lands in
        // the user session; `hidden` suppresses the first-run window.
        let _ = Command::new("open")
            .args(["-a", "Ollama", "--args", "hidden"])
            .spawn();
        Ok(OllamaInstallResult {
            state: OllamaInstallState::Completed,
            detail: Some(
                "Ollama installed. The API is available at http://127.0.0.1:11434.".to_string(),
            ),
        })
    } else {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        let combined_lower = combined.to_lowercase();

        if combined_lower.contains("cancel") && combined_lower.contains("user") {
            Err("Authorization was cancelled or denied.".to_string())
        } else if combined.is_empty() {
            Err("Ollama installation failed.".to_string())
        } else {
            Err(format!("Ollama installation failed: {}", combined))
        }
    }
}

#[cfg(any(test, target_os = "linux"))]
fn ollama_linux_install_script() -> &'static str {
    // The official installer is distro-agnostic (tarball to /usr/local + systemd
    // unit + GPU detection), so unlike Docker no per-distro branching is needed —
    // only its hard dependencies (curl, zstd) vary by package manager.
    r#"#!/bin/bash
# Ollama auto-installer for Companion Hub. Runs as root via pkexec.
# Arg 1: username to add to the ollama group.
set -e
USERNAME="$1"

# The official installer hard-requires curl and zstd; install whichever are
# missing. ca-certificates rides along with curl: apt treats it as a Recommends,
# so --no-install-recommends curl alone cannot do HTTPS (curl error 77). The
# package name is identical across all six package-manager families.
need=""
command -v curl >/dev/null 2>&1 || need="curl ca-certificates"
command -v zstd >/dev/null 2>&1 || need="$need zstd"
if [ -n "$need" ]; then
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get install -y --no-install-recommends $need \
            || { apt-get update && apt-get install -y --no-install-recommends $need; }
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y $need
    elif command -v yum >/dev/null 2>&1; then
        yum install -y $need
    elif command -v pacman >/dev/null 2>&1; then
        pacman -Sy --noconfirm $need
    elif command -v zypper >/dev/null 2>&1; then
        zypper --non-interactive install $need
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache $need
    else
        printf 'Error: missing required tools (%s) and no known package manager found.\n' "$need" >&2
        exit 1
    fi
fi

installer_script="$(mktemp)"
trap 'rm -f "$installer_script"' EXIT
curl -fsSL https://ollama.com/install.sh -o "$installer_script"
sh "$installer_script"

# Best-effort: the ollama group grants direct model-dir access; the HTTP API
# itself needs no group membership. Without systemd the script skips group
# creation, hence the existence check.
if getent group ollama >/dev/null 2>&1; then
    usermod -aG ollama "$USERNAME" || true
fi
"#
}

/// Install Ollama on Linux via the official install.sh, elevated with pkexec
/// (GUI polkit prompt). The script handles arch detection, the systemd service,
/// and NVIDIA/AMD GPU setup; GPU driver installation can take several minutes.
#[cfg(target_os = "linux")]
pub fn install_ollama_linux() -> Result<OllamaInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let username = resolve_current_username()?;
    let pkexec_path = find_executable("pkexec").ok_or_else(|| {
        "pkexec is not installed or not on PATH. Install polkit/pkexec and try again.".to_string()
    })?;

    let mut wrapper_script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary install script: {}", e))?;
    wrapper_script
        .write_all(ollama_linux_install_script().as_bytes())
        .map_err(|e| format!("Failed to write install script: {}", e))?;

    let permissions = std::fs::Permissions::from_mode(0o700);
    wrapper_script
        .as_file()
        .set_permissions(permissions)
        .map_err(|e| format!("Failed to set install script permissions: {}", e))?;

    let output = Command::new(&pkexec_path)
        .arg(wrapper_script.path())
        .arg(&username)
        .output()
        .map_err(|e| format!("Failed to run pkexec installer: {}", e))?;

    if output.status.success() {
        Ok(OllamaInstallResult {
            state: OllamaInstallState::Completed,
            detail: Some(
                "Ollama installed. The API is available at http://127.0.0.1:11434.".to_string(),
            ),
        })
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let combined = format_command_output(&stdout, &stderr);
        let combined_lower = combined.to_lowercase();

        if combined_lower.contains("dismissed")
            || combined_lower.contains("not authorized")
            || combined_lower.contains("authorization required")
            || combined_lower.contains("authentication failed")
        {
            Err("Authorization was cancelled or denied.".to_string())
        } else if combined.is_empty() {
            Err(format!(
                "Ollama installation failed with exit code {:?}.",
                output.status.code()
            ))
        } else {
            Err(format!("Ollama installation failed: {}", combined))
        }
    }
}

/// Install a licensing-free Docker engine. Docker Desktop requires a paid
/// subscription for organizations with >250 employees or >$10M revenue; these
/// paths run the open-source Docker Engine instead:
///   - macOS: Colima (Engine in a lightweight vz VM). Homebrew when present,
///     otherwise verified binaries (colima + lima + docker CLI) into /usr/local.
///   - Windows: Docker Engine inside WSL2 (Ubuntu), TCP-exposed on
///     127.0.0.1:2375 with a docker context — no Docker Desktop involved.
///   - Linux: the standard Engine install (already licensing-free).
pub fn install_docker_engine_alternative() -> Result<DockerInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_docker_linux().map(|detail| DockerInstallResult {
            state: DockerInstallState::NeedsRestart,
            detail: Some(detail),
        });
    }

    #[cfg(target_os = "macos")]
    {
        return install_colima_macos();
    }

    #[cfg(target_os = "windows")]
    {
        return install_docker_wsl2_windows();
    }

    #[allow(unreachable_code)]
    Err("No licensing-free engine path is available on this platform.".to_string())
}

/// Elevated phase of the no-Homebrew Colima install: place colima, lima, and
/// the docker CLI under /usr/local. Checksums are verified for colima (per-asset
/// .sha256sum) and lima (release SHA256SUMS); Docker's static CLI publishes no
/// checksums, so it relies on TLS like the get.docker.com path.
#[cfg(any(test, target_os = "macos"))]
fn colima_macos_binary_install_script() -> &'static str {
    r#"#!/bin/bash
set -euo pipefail
workdir="$(mktemp -d)"
cleanup() {
  rm -rf "$workdir"
}
trap cleanup EXIT
cd "$workdir"

ARCH="$(uname -m)"   # arm64 | x86_64
case "$ARCH" in
  arm64) DOCKER_ARCH_DIR="aarch64" ;;
  x86_64) DOCKER_ARCH_DIR="x86_64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

# colima: version-less asset names, so latest/download is stable; verify sha256.
curl -fsSL -o colima "https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-${ARCH}"
curl -fsSL -o colima.sha256sum "https://github.com/abiosoft/colima/releases/latest/download/colima-Darwin-${ARCH}.sha256sum"
# The published file references the asset name; check against our local name.
expected="$(awk '{print $1}' colima.sha256sum)"
echo "${expected}  colima" | shasum -a 256 -c -
install -m 0755 colima /usr/local/bin/colima

# lima: asset names embed the version; resolve the tag from the GitHub API.
LIMA_TAG="$(curl -fsSL https://api.github.com/repos/lima-vm/lima/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
test -n "$LIMA_TAG"
LIMA_VERSION="${LIMA_TAG#v}"
curl -fsSL -o lima.tar.gz "https://github.com/lima-vm/lima/releases/download/${LIMA_TAG}/lima-${LIMA_VERSION}-Darwin-${ARCH}.tar.gz"
curl -fsSL -o lima-SHA256SUMS "https://github.com/lima-vm/lima/releases/download/${LIMA_TAG}/SHA256SUMS"
grep "lima-${LIMA_VERSION}-Darwin-${ARCH}.tar.gz" lima-SHA256SUMS | awk '{print $1}' | { read -r sum; echo "${sum}  lima.tar.gz" | shasum -a 256 -c -; }
# Extract the whole tarball to one prefix: limactl resolves ../share/lima
# (guest agents, templates) relative to its own binary.
tar -xzf lima.tar.gz -C /usr/local

# docker CLI (static, client-only): no latest pointer — scrape the index.
DOCKER_TGZ="$(curl -fsSL "https://download.docker.com/mac/static/stable/${DOCKER_ARCH_DIR}/" | grep -o 'docker-[0-9][0-9.]*\.tgz' | sort -uV | tail -1)"
test -n "$DOCKER_TGZ"
curl -fsSL -o docker.tgz "https://download.docker.com/mac/static/stable/${DOCKER_ARCH_DIR}/${DOCKER_TGZ}"
tar -xzf docker.tgz
install -m 0755 docker/docker /usr/local/bin/docker
"#
}

/// User phase of the Colima install (never root — brew refuses it, and the VM
/// must belong to the user). Installs via Homebrew when available; otherwise
/// assumes the binary phase already ran, registers a LaunchAgent for autostart,
/// and waits until `docker info` answers (first start downloads a ~350 MB VM
/// image, so the ceiling is generous).
#[cfg(any(test, target_os = "macos"))]
fn colima_macos_start_script() -> &'static str {
    r#"#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

BREW=""
for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [ -x "$candidate" ]; then BREW="$candidate"; break; fi
done

if [ -n "$BREW" ]; then
  "$BREW" install colima docker
  "$BREW" services start colima
else
  # Binary install path: autostart via a per-user LaunchAgent.
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$HOME/Library/LaunchAgents/com.companionhub.colima.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.companionhub.colima</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/colima</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
  launchctl unload "$HOME/Library/LaunchAgents/com.companionhub.colima.plist" 2>/dev/null || true
  launchctl load "$HOME/Library/LaunchAgents/com.companionhub.colima.plist"
fi

# First start downloads the VM image (~350 MB); wait until the engine answers.
for _ in $(seq 1 120); do
  if docker info >/dev/null 2>&1; then exit 0; fi
  sleep 5
done
echo "Timed out waiting for the Colima engine to come up." >&2
exit 1
"#
}

#[cfg(target_os = "macos")]
fn install_colima_macos() -> Result<DockerInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let brew_present = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .iter()
        .any(|p| Path::new(p).exists());

    // Without Homebrew the binaries must be placed under /usr/local first —
    // the only step that needs admin rights.
    if !brew_present {
        let mut script = NamedTempFile::new()
            .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
        script
            .write_all(colima_macos_binary_install_script().as_bytes())
            .map_err(|e| format!("Failed to write Colima installer script: {}", e))?;
        script
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("Failed to set installer script permissions: {}", e))?;

        let applescript = format!(
            "do shell script quoted form of POSIX path of \"{}\" with administrator privileges",
            script.path().to_string_lossy().replace('"', "\\\"")
        );
        let output = Command::new("osascript")
            .args(["-e", &applescript])
            .output()
            .map_err(|e| format!("Failed to launch elevated Colima installer: {}", e))?;
        if !output.status.success() {
            let combined = format_command_output(
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr),
            );
            let combined_lower = combined.to_lowercase();
            if combined_lower.contains("cancel") && combined_lower.contains("user") {
                return Err("Authorization was cancelled or denied.".to_string());
            }
            return Err(format!("Colima binary installation failed: {}", combined));
        }
    }

    // Brew install, autostart registration, colima start, and the readiness
    // wait all run as the user — never root.
    let mut start_script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary start script: {}", e))?;
    start_script
        .write_all(colima_macos_start_script().as_bytes())
        .map_err(|e| format!("Failed to write Colima start script: {}", e))?;
    start_script
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Failed to set start script permissions: {}", e))?;

    let output = Command::new("bash")
        .arg(start_script.path())
        .output()
        .map_err(|e| format!("Failed to run Colima start script: {}", e))?;

    if output.status.success() {
        Ok(DockerInstallResult {
            state: DockerInstallState::Completed,
            detail: Some(
                "Colima installed and the Docker Engine is running (context \"colima\").".to_string(),
            ),
        })
    } else {
        let combined = format_command_output(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        );
        if combined.is_empty() {
            Err("Colima installation failed.".to_string())
        } else {
            Err(format!("Colima installation failed: {}", combined))
        }
    }
}

/// Windows: Docker Engine inside WSL2, no Docker Desktop.
///
/// Exit code contract matches the Docker Desktop installer: 100 = WSL was just
/// enabled and Windows must reboot (NeedsRestart); 0 = engine reachable.
///
/// Design notes (all verified against MS Learn / Docker docs):
///   - `wsl --install -d Ubuntu --no-launch` registers Ubuntu without the
///     interactive first-run user creation; `wsl -u root` works without it.
///   - Ubuntu's docker-ce systemd unit uses `-H fd://`, which conflicts with a
///     daemon.json `hosts` key — TCP exposure needs a systemd drop-in instead.
///   - WSL2 localhost forwarding makes tcp://127.0.0.1:2375 reachable from
///     Windows, but only while the distro runs — and systemd services do NOT
///     keep the VM alive, hence the hidden `sleep infinity` keepalive in the
///     user's Startup folder.
///   - docker.exe goes where find_docker_binary() already looks, and a docker
///     context (stored in ~/.docker, read at runtime) points it at the TCP
///     endpoint — no env vars, so the running Hub needs no restart.
#[cfg(any(test, target_os = "windows"))]
fn wsl2_engine_windows_install_script() -> String {
    let linux_setup = r#"set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v dockerd >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
fi
printf '[boot]\nsystemd=true\n' > /etc/wsl.conf
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nExecStart=\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375\n' > /etc/systemd/system/docker.service.d/companionhub-tcp.conf
systemctl enable docker 2>/dev/null || true"#;

    format!(
        r#"$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:WSL_UTF8 = '1'

# Phase 1: WSL itself (admin + reboot when absent).
& wsl.exe --status | Out-Null
if ($LASTEXITCODE -ne 0) {{
  & wsl.exe --install --no-distribution
  exit 100
}}

# Phase 2: Ubuntu distro, registered without the interactive first-run.
$distros = (& wsl.exe -l -q) | ForEach-Object {{ $_.Trim() }}
$distro = $distros | Where-Object {{ $_ -eq 'Ubuntu' -or $_ -match '^Ubuntu-' }} | Select-Object -First 1
if (-not $distro) {{
  & wsl.exe --install -d Ubuntu --no-launch
  if ($LASTEXITCODE -ne 0) {{ throw "Ubuntu installation failed with exit code $LASTEXITCODE" }}
  $distro = 'Ubuntu'
}}

# Phase 3: Docker Engine + systemd TCP drop-in inside the distro (as root).
$setup = @'
{linux_setup}
'@ -replace "`r`n", "`n"
$setup | & wsl.exe -d $distro -u root -- sh
if ($LASTEXITCODE -ne 0) {{ throw "Docker Engine setup inside WSL failed with exit code $LASTEXITCODE" }}

# Restart the distro so wsl.conf + the drop-in take effect.
& wsl.exe --shutdown
& wsl.exe -d $distro -u root -- true

# Phase 4: static docker CLI where the Hub already looks for it.
$dockerBin = Join-Path $Env:ProgramFiles 'Docker\Docker\resources\bin'
if (-not (Test-Path (Join-Path $dockerBin 'docker.exe'))) {{
  $index = (Invoke-WebRequest -UseBasicParsing -Uri 'https://download.docker.com/win/static/stable/x86_64/').Content
  $zips = [regex]::Matches($index, 'docker-[0-9][0-9.]*\.zip') | ForEach-Object {{ $_.Value }} | Sort-Object {{ [version]($_ -replace 'docker-|\.zip', '') }}
  $latest = $zips[-1]
  if (-not $latest) {{ throw 'Could not determine the latest static docker CLI version.' }}
  $zipPath = Join-Path $Env:TEMP $latest
  Invoke-WebRequest -UseBasicParsing -Uri "https://download.docker.com/win/static/stable/x86_64/$latest" -OutFile $zipPath
  try {{
    $extract = Join-Path $Env:TEMP 'companionhub-docker-cli'
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -Path $zipPath -DestinationPath $extract
    New-Item -ItemType Directory -Force -Path $dockerBin | Out-Null
    Copy-Item (Join-Path $extract 'docker\docker.exe') (Join-Path $dockerBin 'docker.exe') -Force
    Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  }} finally {{
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
  }}
}}

# Phase 5: route the CLI at the WSL engine via a context (read from ~/.docker
# at runtime — no env vars, no Hub restart needed).
$dockerExe = Join-Path $dockerBin 'docker.exe'
& $dockerExe context inspect wsl-engine 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {{
  & $dockerExe context create wsl-engine --docker host=tcp://127.0.0.1:2375 | Out-Null
}}
& $dockerExe context use wsl-engine | Out-Null

# Phase 6: keepalive at logon — systemd services do not keep the WSL VM alive.
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'CompanionHub-WSL-Docker.vbs'
Set-Content -Path $vbs -Value "CreateObject(""Wscript.Shell"").Run ""wsl.exe -d $distro -u root -- sleep infinity"", 0, False"

# Keepalive for this session too, then wait for the engine.
Start-Process -WindowStyle Hidden -FilePath 'wsl.exe' -ArgumentList '-d',$distro,'-u','root','--','sleep','infinity'
for ($i = 0; $i -lt 60; $i++) {{
  & $dockerExe info 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {{ exit 0 }}
  Start-Sleep -Seconds 5
}}
throw 'Timed out waiting for the Docker Engine inside WSL2 to come up.'
"#,
        linux_setup = linux_setup,
    )
}

#[cfg(target_os = "windows")]
fn install_docker_wsl2_windows() -> Result<DockerInstallResult, String> {
    use std::io::Write as IoWrite;

    // PowerShell -File refuses scripts without a .ps1 extension.
    let mut script = tempfile::Builder::new()
        .suffix(".ps1")
        .tempfile()
        .map_err(|e| format!("Failed to create temporary installer script: {}", e))?;
    script
        .write_all(wsl2_engine_windows_install_script().as_bytes())
        .map_err(|e| format!("Failed to write WSL2 engine installer script: {}", e))?;

    let launch_command = format!(
        "$ErrorActionPreference = 'Stop'; $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{}'); exit $process.ExitCode",
        escape_powershell_single_quoted(&script.path().to_string_lossy()),
    );

    let mut command = Command::new("powershell.exe");
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &launch_command,
        ])
        .output()
        .map_err(|e| format!("Failed to launch elevated WSL2 engine installer: {}", e))?;

    let combined = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );
    let combined_lower = combined.to_lowercase();

    match output.status.code() {
        Some(0) => Ok(DockerInstallResult {
            state: DockerInstallState::Completed,
            detail: Some(
                "Docker Engine is running inside WSL2 (context \"wsl-engine\").".to_string(),
            ),
        }),
        Some(100) => Ok(DockerInstallResult {
            state: DockerInstallState::NeedsRestart,
            detail: Some(
                "WSL was installed or enabled. Restart Windows, then reopen Companion Hub to continue Docker setup."
                    .to_string(),
            ),
        }),
        _ if combined_lower.contains("cancel") && combined_lower.contains("user") => {
            Err("Authorization was cancelled or denied.".to_string())
        }
        _ if combined.is_empty() => Err(format!(
            "WSL2 Docker Engine installation failed with exit code {:?}.",
            output.status.code()
        )),
        _ => Err(format!("WSL2 Docker Engine installation failed: {}", combined)),
    }
}

fn truncate_command_output(output: &str) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let char_count = trimmed.chars().count();
    if char_count <= MAX_COMMAND_OUTPUT_CHARS {
        return trimmed.to_string();
    }

    let truncated: String = trimmed.chars().take(MAX_COMMAND_OUTPUT_CHARS).collect();
    format!(
        "{}… [truncated {} chars]",
        truncated,
        char_count - MAX_COMMAND_OUTPUT_CHARS
    )
}

pub(crate) fn format_command_output(stdout: &str, stderr: &str) -> String {
    let stdout = truncate_command_output(stdout);
    let stderr = truncate_command_output(stderr);

    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("stdout: {} | stderr: {}", stdout, stderr),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(any(test, target_os = "macos"))]
    use super::docker_desktop_macos_install_script;
    #[cfg(any(test, target_os = "windows"))]
    use super::docker_desktop_windows_install_script;
    #[cfg(any(test, target_os = "linux"))]
    use super::ollama_linux_install_script;
    #[cfg(any(test, target_os = "macos"))]
    use super::ollama_macos_install_script;
    #[cfg(any(test, target_os = "windows"))]
    use super::ollama_windows_install_script;
    #[cfg(any(test, target_os = "macos"))]
    use super::{colima_macos_binary_install_script, colima_macos_start_script};
    #[cfg(any(test, target_os = "windows"))]
    use super::wsl2_engine_windows_install_script;
    use super::{
        append_desktop_log_for, classify_docker_access_result, clear_traefik_recreate_required,
        clear_tunnel_token, desktop_log_path_for, docker_context_host_from_inspect_output,
        format_command_output, generate_container_docker_config, host_container_uid_gid,
        host_docker_socket_path, is_container_name_conflict, is_host_port_bind_conflict,
        is_oci_runtime_error, is_traefik_recreate_required, logs_open_target_for,
        managed_app_container_ps_args, mark_traefik_recreate_required, merge_compose_profiles,
        parse_container_ids, parse_docker_socket_uid_gid, prepare_traefik_runtime_state,
        private_vpn_enabled_from_map, seeded_traefik_config_contents,
        should_defer_docker_bind_mount_probe, startup_service_definitions, truncate_command_output,
        tunnel_dir_for, tunnel_token_path_for, DockerAccessState, MAX_COMMAND_OUTPUT_CHARS,
        TRAEFIK_ACME_FILE, TRAEFIK_CONFIG_FILE, TRAEFIK_DYNAMIC_CONFIG_SEED, TRAEFIK_DYNAMIC_FILE,
        TRAEFIK_TLS_DIR,
    };
    #[cfg(target_os = "linux")]
    use super::{
        current_docker_context_name, linux_docker_host_for_context_or_local_sockets,
        select_reachable_linux_docker_socket_path,
    };
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(target_os = "linux")]
    use std::path::Path;
    use std::path::PathBuf;

    #[test]
    fn classifies_daemon_unavailable_before_permission_denied() {
        let result = classify_docker_access_result(
            "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
            Some(1),
        );

        assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
    }

    #[test]
    fn classifies_explicit_permission_denied_as_permission_issue() {
        let result = classify_docker_access_result(
            "Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
            Some(1),
        );

        assert!(matches!(result.state, DockerAccessState::PermissionDenied));
    }

    #[test]
    fn classifies_windows_named_pipe_not_found_as_daemon_unavailable() {
        let result = classify_docker_access_result(
            "open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.",
            Some(1),
        );

        assert!(matches!(result.state, DockerAccessState::DaemonUnavailable));
    }

    #[test]
    fn classifies_windows_access_denied_as_permission_issue() {
        let result = classify_docker_access_result(
            "open //./pipe/docker_engine: Access is denied. In the default daemon configuration on Windows, the docker client must be run with elevated privileges to connect.",
            Some(1),
        );

        assert!(matches!(result.state, DockerAccessState::PermissionDenied));
    }

    #[test]
    fn defers_bind_mount_probe_until_docker_is_ready() {
        assert!(!should_defer_docker_bind_mount_probe(
            &DockerAccessState::Available
        ));
        assert!(should_defer_docker_bind_mount_probe(
            &DockerAccessState::DaemonUnavailable
        ));
        assert!(should_defer_docker_bind_mount_probe(
            &DockerAccessState::NotInstalled
        ));
        assert!(should_defer_docker_bind_mount_probe(
            &DockerAccessState::PermissionDenied
        ));
        assert!(should_defer_docker_bind_mount_probe(
            &DockerAccessState::Error
        ));
    }

    #[test]
    fn prefers_docker_host_unix_socket_path() {
        let original = std::env::var_os("DOCKER_HOST");
        unsafe {
            std::env::set_var("DOCKER_HOST", "unix:///tmp/ci-hub-docker.sock");
        }

        assert_eq!(
            host_docker_socket_path(),
            PathBuf::from("/tmp/ci-hub-docker.sock")
        );

        if let Some(value) = original {
            unsafe {
                std::env::set_var("DOCKER_HOST", value);
            }
        } else {
            unsafe {
                std::env::remove_var("DOCKER_HOST");
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn prefers_reachable_linux_engine_socket_over_desktop_candidates() {
        let candidates = vec![
            PathBuf::from("/var/run/docker.sock"),
            PathBuf::from("/run/user/1000/docker.sock"),
            PathBuf::from("/home/test/.docker/run/docker.sock"),
        ];
        let reachable = candidates[0].clone();

        let selected = select_reachable_linux_docker_socket_path(&candidates, |candidate| {
            candidate == reachable.as_path()
        });

        assert_eq!(selected, Some(reachable));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn falls_back_to_reachable_linux_desktop_socket_when_engine_isnt_ready() {
        let candidates = vec![
            PathBuf::from("/var/run/docker.sock"),
            PathBuf::from("/run/user/1000/docker.sock"),
            PathBuf::from("/home/test/.docker/run/docker.sock"),
        ];
        let reachable = candidates[1].clone();

        let selected = select_reachable_linux_docker_socket_path(&candidates, |candidate| {
            candidate == reachable.as_path()
        });

        assert_eq!(selected, Some(reachable));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn reads_current_docker_context_from_config_fixture() {
        let fixture = r#"{ "currentContext": "desktop-linux" }"#;
        let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);

        assert_eq!(
            current_docker_context_name(Some(&docker_dir)),
            Some("desktop-linux".to_string())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn ignores_default_docker_context_name() {
        let fixture = r#"{ "currentContext": "default" }"#;
        let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);

        assert_eq!(current_docker_context_name(Some(&docker_dir)), None);
    }

    #[test]
    fn parses_docker_context_host_from_inspect_output() {
        let inspect_output = r#"[{
            "Name": "desktop-linux",
            "Endpoints": {
                "docker": {
                    "Host": "unix:///home/test/.docker/desktop/docker.sock"
                }
            }
        }]"#;

        assert_eq!(
            docker_context_host_from_inspect_output(inspect_output),
            Some("unix:///home/test/.docker/desktop/docker.sock".to_string())
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn prefers_reachable_linux_context_host_before_socket_fallbacks() {
        let context_host = "unix:///home/test/.docker/desktop/docker.sock";
        let candidates = vec![
            PathBuf::from("/var/run/docker.sock"),
            PathBuf::from("/run/user/1000/docker.sock"),
        ];

        let selected = linux_docker_host_for_context_or_local_sockets(
            Some(context_host),
            true,
            &candidates,
            |_candidate| false,
        );

        assert_eq!(selected, Some(context_host.to_string()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn does_not_fall_back_when_nondefault_context_is_configured_but_unreachable() {
        let candidates = vec![
            PathBuf::from("/var/run/docker.sock"),
            PathBuf::from("/run/user/1000/docker.sock"),
        ];

        let selected =
            linux_docker_host_for_context_or_local_sockets(None, true, &candidates, |candidate| {
                candidate == Path::new("/var/run/docker.sock")
            });

        assert_eq!(selected, None);
    }

    #[test]
    fn parses_docker_socket_stat_output() {
        assert_eq!(parse_docker_socket_uid_gid("0:0"), Some((0, 0)));
        assert_eq!(parse_docker_socket_uid_gid("0:998\n"), Some((0, 998)));
        assert_eq!(parse_docker_socket_uid_gid("bad"), None);
    }

    #[test]
    fn truncates_long_command_output() {
        let output = "x".repeat(MAX_COMMAND_OUTPUT_CHARS + 25);
        let truncated = truncate_command_output(&output);

        assert!(truncated.contains("[truncated 25 chars]"));
        assert!(truncated.starts_with(&"x".repeat(MAX_COMMAND_OUTPUT_CHARS)));
    }

    #[test]
    fn formats_stdout_and_stderr_with_truncation() {
        let stdout = "ok";
        let stderr = "y".repeat(MAX_COMMAND_OUTPUT_CHARS + 10);
        let formatted = format_command_output(stdout, &stderr);

        assert!(formatted.starts_with("stdout: ok | stderr: "));
        assert!(formatted.contains("[truncated 10 chars]"));
    }

    #[test]
    fn appends_desktop_log_entries_to_the_consolidated_log() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let log_path =
            append_desktop_log_for(tempdir.path(), "hub.start", "first line\nsecond line")
                .expect("append desktop log");
        let content = std::fs::read_to_string(log_path).expect("read log");

        assert!(content.contains("hub.start: first line"));
        assert!(content.contains("    second line"));
    }

    #[test]
    fn view_logs_opens_the_logs_folder_even_when_desktop_log_exists() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let logs_dir = tempdir.path().join("logs");
        std::fs::create_dir_all(&logs_dir).expect("create logs dir");

        assert_eq!(logs_open_target_for(tempdir.path()), logs_dir);

        let desktop_log = desktop_log_path_for(tempdir.path());
        std::fs::write(&desktop_log, "ready").expect("write desktop log");

        assert_eq!(logs_open_target_for(tempdir.path()), logs_dir);
    }

    #[test]
    fn tray_stop_targets_running_app_containers_by_ci_hub_labels() {
        assert_eq!(
            managed_app_container_ps_args(),
            [
                "ps",
                "-q",
                "--filter",
                "label=ci-os-hub.managed=true",
                "--filter",
                "label=ci-os-hub.appurn",
            ]
        );
    }

    #[test]
    fn host_container_uid_gid_matches_current_process_on_unix() {
        let (uid, gid) = host_container_uid_gid();
        #[cfg(unix)]
        {
            assert_eq!(uid, unsafe { libc::getuid() });
            assert_eq!(gid, unsafe { libc::getgid() });
        }
        #[cfg(windows)]
        {
            assert_eq!(uid, 1000);
            assert_eq!(gid, 1000);
        }
    }

    #[test]
    fn private_vpn_enabled_by_default_ignores_legacy_enabled_false() {
        let mut env = std::collections::HashMap::new();
        env.insert("PRIVATE_VPN_ENABLED".into(), "false".into());
        assert!(private_vpn_enabled_from_map(&env));
    }

    #[test]
    fn private_vpn_disabled_only_when_user_disabled_sentinel_set() {
        let mut env = std::collections::HashMap::new();
        env.insert("PRIVATE_VPN_USER_DISABLED".into(), "true".into());
        assert!(!private_vpn_enabled_from_map(&env));
    }

    #[test]
    fn merge_compose_profiles_adds_private_vpn_by_default() {
        let env = std::collections::HashMap::new();
        assert_eq!(merge_compose_profiles(&env, true), "private-vpn");
    }

    #[test]
    fn startup_progress_keeps_private_vpn_visible_but_non_blocking() {
        let (core, optional) = startup_service_definitions(true);

        assert_eq!(core.len(), 4);
        assert!(optional
            .iter()
            .any(|(container, label, required)| *container == "hub-tailscale"
                && *label == "Private VPN"
                && !required));
    }

    #[test]
    fn startup_progress_includes_ollama_as_optional_non_blocking() {
        let (_, optional) = startup_service_definitions(false);

        assert!(optional
            .iter()
            .any(|(container, label, required)| *container == "ci-hub-ollama"
                && *label == "Ollama"
                && !required));
    }

    #[test]
    fn parses_running_app_container_ids_from_docker_ps_output() {
        assert_eq!(
            parse_container_ids("abc123\n\n def456 \n"),
            vec!["abc123".to_string(), "def456".to_string()]
        );
    }

    #[test]
    fn prepares_fresh_traefik_runtime_state_for_desktop_runtime() {
        let tempdir = tempfile::tempdir().expect("tempdir");

        let result = prepare_traefik_runtime_state(tempdir.path()).expect("prepare traefik");

        let config_path = tempdir.path().join(TRAEFIK_CONFIG_FILE);
        let dynamic_path = tempdir.path().join(TRAEFIK_DYNAMIC_FILE);
        let acme_path = tempdir.path().join(TRAEFIK_ACME_FILE);
        let tls_dir = tempdir.path().join(TRAEFIK_TLS_DIR);

        assert!(result.changed);
        assert!(!result.repaired_conflicting_paths);
        assert!(config_path.is_file());
        assert!(dynamic_path.is_file());
        assert!(acme_path.is_file());
        assert!(tls_dir.is_dir());
        assert_eq!(
            std::fs::read_to_string(&config_path).expect("read traefik config"),
            seeded_traefik_config_contents()
        );
        assert_eq!(
            std::fs::read_to_string(&dynamic_path).expect("read dynamic config"),
            TRAEFIK_DYNAMIC_CONFIG_SEED
        );
        assert_eq!(
            std::fs::read_to_string(&acme_path).expect("read acme file"),
            "{}"
        );
        assert!(!is_traefik_recreate_required(tempdir.path()));

        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let mode = std::fs::metadata(&acme_path)
                .expect("acme metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn heals_poisoned_traefik_mount_paths_back_to_files() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let config_path = tempdir.path().join(TRAEFIK_CONFIG_FILE);
        let dynamic_path = tempdir.path().join(TRAEFIK_DYNAMIC_FILE);
        let acme_path = tempdir.path().join(TRAEFIK_ACME_FILE);

        std::fs::create_dir_all(&config_path).expect("create poisoned config directory");
        std::fs::create_dir_all(&dynamic_path).expect("create poisoned dynamic directory");
        std::fs::create_dir_all(&acme_path).expect("create poisoned acme directory");

        let result = prepare_traefik_runtime_state(tempdir.path()).expect("prepare traefik");

        assert!(result.changed);
        assert!(result.repaired_conflicting_paths);
        assert!(config_path.is_file());
        assert!(dynamic_path.is_file());
        assert!(acme_path.is_file());
        assert_eq!(
            std::fs::read_to_string(&config_path).expect("read healed traefik config"),
            seeded_traefik_config_contents()
        );
        assert_eq!(
            std::fs::read_to_string(&dynamic_path).expect("read healed dynamic config"),
            TRAEFIK_DYNAMIC_CONFIG_SEED
        );
        assert_eq!(
            std::fs::read_to_string(&acme_path).expect("read healed acme file"),
            "{}"
        );
    }

    #[test]
    fn traefik_recreate_marker_can_be_set_and_cleared() {
        let tempdir = tempfile::tempdir().expect("tempdir");

        assert!(!is_traefik_recreate_required(tempdir.path()));

        mark_traefik_recreate_required(tempdir.path()).expect("mark recreate required");
        assert!(is_traefik_recreate_required(tempdir.path()));

        clear_traefik_recreate_required(tempdir.path()).expect("clear recreate required");
        assert!(!is_traefik_recreate_required(tempdir.path()));
    }

    #[test]
    fn windows_installer_script_uses_unique_temp_download_and_validates_signature() {
        let script = docker_desktop_windows_install_script(
            "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
        );

        assert!(script.contains("GetTempFileName()"));
        assert!(script.contains("Get-AuthenticodeSignature"));
        assert!(script.contains("net.exe localgroup docker-users \"$AppUser\" /add"));
        assert!(!script.contains("CompanionHub-DockerDesktopInstaller.exe"));
        assert!(!script.contains("cmd /c"));
    }

    #[test]
    fn macos_installer_script_verifies_downloaded_app_signature() {
        let script = docker_desktop_macos_install_script(
            "https://desktop.docker.com/mac/main/arm64/Docker.dmg",
            "hex",
        );

        assert!(script.contains("spctl --assess --type open --verbose=2"));
        assert!(script.contains("codesign --verify --deep --strict --verbose=2"));
        assert!(script.contains("spctl --assess --type execute --verbose=2"));
        assert!(script.contains("--user=\"hex\""));
    }

    #[test]
    fn ollama_windows_installer_script_validates_signature_and_runs_silently() {
        let script = ollama_windows_install_script("https://ollama.com/download/OllamaSetup.exe");

        assert!(script.contains("GetTempFileName()"));
        assert!(script.contains("Get-AuthenticodeSignature"));
        assert!(script.contains("-notmatch 'Ollama'"));
        assert!(script.contains("'/VERYSILENT','/NORESTART','/SUPPRESSMSGBOXES'"));
        // Per-user Inno Setup installer — must never request elevation.
        assert!(!script.contains("RunAs"));
        assert!(!script.contains("-Verb"));
    }

    #[test]
    fn ollama_macos_installer_script_verifies_app_signature_and_installs_cli() {
        let script = ollama_macos_install_script("https://ollama.com/download/Ollama-darwin.zip");

        assert!(script.contains("codesign --verify --deep --strict --verbose=2"));
        assert!(script.contains("spctl --assess --type execute --verbose=2"));
        assert!(script.contains("ditto"));
        assert!(script.contains("/Applications/Ollama.app"));
        assert!(script.contains("ln -sf /Applications/Ollama.app/Contents/Resources/ollama /usr/local/bin/ollama"));
    }

    #[test]
    fn colima_binary_install_script_verifies_checksums_and_layout() {
        let script = colima_macos_binary_install_script();

        // colima sha256 + lima SHA256SUMS verification are non-negotiable.
        assert!(script.contains("shasum -a 256 -c"));
        assert!(script.contains("colima.sha256sum"));
        assert!(script.contains("SHA256SUMS"));
        // The lima tarball must be extracted whole — limactl resolves
        // ../share/lima relative to its own binary.
        assert!(script.contains("tar -xzf lima.tar.gz -C /usr/local"));
        assert!(script.contains("releases/latest/download/colima-Darwin-"));
        assert!(script.contains("download.docker.com/mac/static/stable"));
    }

    #[test]
    fn colima_start_script_never_runs_brew_as_root_and_waits_for_engine() {
        let script = colima_macos_start_script();

        // brew refuses root; this script must not contain any elevation.
        assert!(!script.contains("sudo"));
        assert!(!script.contains("osascript"));
        assert!(script.contains(r#""$BREW" install colima docker"#));
        assert!(script.contains(r#""$BREW" services start colima"#));
        assert!(script.contains("LaunchAgents/com.companionhub.colima.plist"));
        // Success must mean a working engine, not just installed binaries.
        assert!(script.contains("docker info"));
    }

    #[test]
    fn wsl2_engine_script_keeps_desktop_contract_and_avoids_daemon_json_hosts() {
        let script = wsl2_engine_windows_install_script();

        // Exit-code contract shared with the Docker Desktop installer.
        assert!(script.contains("exit 100"));
        assert!(script.contains("--no-distribution"));
        assert!(script.contains("--install -d Ubuntu --no-launch"));
        // TCP exposure must be a systemd drop-in, not daemon.json "hosts"
        // (which conflicts with Ubuntu's -H fd:// unit).
        assert!(script.contains("docker.service.d"));
        assert!(script.contains("-H fd:// -H tcp://127.0.0.1:2375"));
        assert!(!script.contains("\"hosts\""));
        // UTF-16 output guard for wsl -l parsing.
        assert!(script.contains("WSL_UTF8"));
        // Context routing (no env vars) + logon keepalive.
        assert!(script.contains("context create wsl-engine"));
        assert!(script.contains("sleep infinity"));
        assert!(script.contains("docker.exe"));
    }

    #[test]
    fn ollama_linux_installer_script_uses_official_installer_and_handles_deps() {
        let script = ollama_linux_install_script();

        assert!(script.contains("https://ollama.com/install.sh"));
        // The official installer hard-requires curl and zstd.
        assert!(script.contains("command -v curl"));
        assert!(script.contains("command -v zstd"));
        // apt's --no-install-recommends curl can't do HTTPS without this.
        assert!(script.contains("curl ca-certificates"));
        // Dep install must cover the major package-manager families.
        for pm in ["apt-get", "dnf", "yum", "pacman", "zypper", "apk"] {
            assert!(script.contains(pm), "missing package manager: {}", pm);
        }
        // Group add is best-effort and gated on group existence (no-systemd hosts).
        assert!(script.contains("getent group ollama"));
        assert!(script.contains(r#"usermod -aG ollama "$USERNAME""#));
    }

    // --- is_container_name_conflict / is_oci_runtime_error classifiers ---

    #[test]
    fn detects_container_name_conflict_from_docker_daemon_message() {
        let output = r#"Error response from daemon: Conflict. The container name "/ci-hub-app" is already in use by container "8dfafdbc3a40". You have to remove (or rename) that container to be able to reuse that name."#;
        assert!(is_container_name_conflict(output));
        assert!(!is_oci_runtime_error(output));
    }

    #[test]
    fn detects_container_name_conflict_case_insensitively() {
        let output = r#"service-app-1  Recreate
Error response from daemon: CONFLICT. The container name "/ci-hub-app" IS ALREADY IN USE BY CONTAINER "8dfafdbc3a40"."#;
        assert!(is_container_name_conflict(output));
    }

    #[test]
    fn does_not_treat_port_allocation_failure_as_container_name_conflict() {
        let output = "Error response from daemon: driver failed programming external connectivity on endpoint ci-hub-app-1: Bind for 0.0.0.0:5432 failed: port is already allocated";
        assert!(!is_container_name_conflict(output));
    }

    #[test]
    fn detects_host_port_bind_conflict_from_traefik_publish_error() {
        let output = r#"Error response from daemon: ports are not available: exposing port TCP 0.0.0.0:443 -> 127.0.0.1:0: listen tcp 0.0.0.0:443: bind: address already in use"#;
        assert!(is_host_port_bind_conflict(output));
        assert!(!is_container_name_conflict(output));
    }

    #[test]
    fn detects_oci_runtime_create_failed_message() {
        let output = r#"Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: "/app/start.sh": stat /app/start.sh: no such file or directory: unknown"#;
        assert!(is_oci_runtime_error(output));
        assert!(!is_container_name_conflict(output));
    }

    #[test]
    fn detects_failed_to_create_shim_task_message() {
        let output = "service-app-1  Starting\nError response from daemon: failed to create shim task: context deadline exceeded: unknown";
        assert!(is_oci_runtime_error(output));
    }

    #[test]
    fn does_not_treat_pull_access_denied_as_oci_runtime_error() {
        let output = "Error response from daemon: pull access denied for ci-hub-app, repository does not exist or may require 'docker login'";
        assert!(!is_oci_runtime_error(output));
    }

    #[test]
    fn rotates_desktop_log_when_it_exceeds_max_size() {
        use super::{rotate_log_if_needed, DESKTOP_LOG_FILENAME, MAX_LOG_ROTATIONS};

        // Use a tiny threshold so the test doesn't write multi-MB files.
        const TEST_MAX_SIZE: u64 = 64;

        let tempdir = tempfile::tempdir().expect("tempdir");
        let logs_dir = tempdir.path();
        let log_path = logs_dir.join(DESKTOP_LOG_FILENAME);

        // Create a log file that exceeds the size limit.
        let payload_len = (TEST_MAX_SIZE + 1) as usize;
        let payload = "x".repeat(payload_len);
        std::fs::write(&log_path, &payload).expect("write oversized log");

        rotate_log_if_needed(&log_path, logs_dir, TEST_MAX_SIZE);

        // Original should no longer exist (it was rotated to .1).
        assert!(!log_path.exists(), "original log should have been renamed");
        let rotated = logs_dir.join(format!("{}.1", DESKTOP_LOG_FILENAME));
        assert!(rotated.exists(), "desktop.log.1 should exist");
        let content = std::fs::read_to_string(&rotated).expect("read rotated");
        assert_eq!(content, payload);

        // Rotate again: .1 → .2, new data → .1
        let new_payload = "y".repeat(payload_len);
        std::fs::write(&log_path, &new_payload).expect("write new oversized log");
        rotate_log_if_needed(&log_path, logs_dir, TEST_MAX_SIZE);

        assert!(!log_path.exists());
        let r1 = logs_dir.join(format!("{}.1", DESKTOP_LOG_FILENAME));
        let r2 = logs_dir.join(format!("{}.2", DESKTOP_LOG_FILENAME));
        assert!(r1.exists());
        assert!(r2.exists());
        assert_eq!(std::fs::read_to_string(&r1).expect("read r1"), new_payload);
        assert_eq!(std::fs::read_to_string(&r2).expect("read r2"), payload);

        // Repeated rotations should keep updating .1..=MAX_LOG_ROTATIONS even when
        // those targets already exist, and the oldest entry should be evicted.
        let mut expected_rotations = vec![new_payload.clone(), payload.clone()];
        for i in 0..MAX_LOG_ROTATIONS {
            // Use a short unique prefix + single-byte fill to keep total size
            // just over the limit without allocating unnecessarily large strings.
            let prefix = format!("z{}-", i);
            let p = prefix.clone() + &"z".repeat(payload_len - prefix.len());
            std::fs::write(&log_path, &p).expect("write");
            rotate_log_if_needed(&log_path, logs_dir, TEST_MAX_SIZE);

            expected_rotations.insert(0, p);
            expected_rotations.truncate(MAX_LOG_ROTATIONS);
        }

        for rotation in 1..=MAX_LOG_ROTATIONS {
            let rotated_path = logs_dir.join(format!("{}.{}", DESKTOP_LOG_FILENAME, rotation));
            assert!(
                rotated_path.exists(),
                "expected rotated log {} to exist",
                rotated_path.display()
            );
            assert_eq!(
                std::fs::read_to_string(&rotated_path).expect("read rotated log"),
                expected_rotations[rotation - 1],
                "unexpected contents for rotated log {}",
                rotated_path.display()
            );
        }

        let beyond = logs_dir.join(format!(
            "{}.{}",
            DESKTOP_LOG_FILENAME,
            MAX_LOG_ROTATIONS + 1
        ));
        assert!(
            !beyond.exists(),
            "should not keep more than MAX_LOG_ROTATIONS history files"
        );

        // After rotation, a fresh active desktop.log should still be creatable
        // and appendable.
        std::fs::write(&log_path, "active-1").expect("write active log");
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&log_path)
                .expect("open active log for append");
            use std::io::Write;
            file.write_all(b"active-2").expect("append active log");
        }
        assert_eq!(
            std::fs::read_to_string(&log_path).expect("read active log"),
            "active-1active-2"
        );
    }

    /// Write a `~/.docker/config.json` fixture into a temp directory and
    /// return the `.docker` path for use as `host_docker_dir`.
    fn write_docker_config_fixture(fixture: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp_home = tempfile::tempdir().expect("create temp home");
        let docker_dir = tmp_home.path().join(".docker");
        std::fs::create_dir_all(&docker_dir).expect("create .docker dir");
        std::fs::write(docker_dir.join("config.json"), fixture).expect("write fixture");
        (tmp_home, docker_dir)
    }

    #[test]
    fn generates_container_docker_config_stripping_host_fields() {
        let fixture = r#"{
            "auths": {
                "https://index.docker.io/v1/": { "auth": "dXNlcjpwYXNz" }
            },
            "credsStore": "desktop",
            "credHelpers": { "ghcr.io": "desktop" },
            "currentContext": "desktop-linux",
            "plugins": { "debug": { "enabled": true } }
        }"#;

        let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
        let tmp = tempfile::tempdir().expect("create temp dir");
        let data_dir = tmp.path().to_path_buf();
        generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

        let config_path = data_dir.join(".docker").join("config.json");
        assert!(config_path.is_file(), "config should be a file");

        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();

        assert_eq!(
            parsed.get("auths"),
            Some(&serde_json::json!({ "https://index.docker.io/v1/": { "auth": "dXNlcjpwYXNz" } })),
            "inline auths should be preserved"
        );
        assert!(
            parsed.get("credsStore").is_none(),
            "host-only credsStore stripped"
        );
        assert!(
            parsed.get("credHelpers").is_none(),
            "host-only credHelpers stripped"
        );
        assert!(
            parsed.get("currentContext").is_none(),
            "currentContext stripped"
        );
        assert!(parsed.get("plugins").is_none(), "plugins stripped");

        // Verify file permissions are restricted on Unix
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        {
            let mode = config_path.metadata().unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "config.json should be 0600");
        }
    }

    #[test]
    fn replaces_stale_directory_with_config_file() {
        let fixture = r#"{ "credsStore": "desktop" }"#;

        let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
        let tmp = tempfile::tempdir().expect("create temp dir");
        let data_dir = tmp.path().to_path_buf();
        let config_path = data_dir.join(".docker").join("config.json");

        // Simulate the stale directory Docker creates
        std::fs::create_dir_all(&config_path).unwrap();
        assert!(config_path.is_dir(), "precondition: should be a directory");

        generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

        assert!(
            config_path.is_file(),
            "stale dir should be replaced with a file"
        );
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();
        assert!(parsed.is_object());
        assert!(parsed.get("credsStore").is_none());
    }

    #[test]
    fn preserves_non_host_only_cred_helpers() {
        let fixture = r#"{
            "credsStore": "ecr-login",
            "credHelpers": {
                "ghcr.io": "desktop",
                "123456789.dkr.ecr.us-east-1.amazonaws.com": "ecr-login"
            }
        }"#;

        let (_tmp_home, docker_dir) = write_docker_config_fixture(fixture);
        let tmp = tempfile::tempdir().expect("create temp dir");
        let data_dir = tmp.path().to_path_buf();
        generate_container_docker_config(&data_dir, Some(&docker_dir)).expect("generate config");

        let config_path = data_dir.join(".docker").join("config.json");
        let parsed: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&config_path).unwrap()).unwrap();

        assert_eq!(
            parsed.get("credsStore"),
            Some(&serde_json::json!("ecr-login")),
            "non-host-only credsStore should be preserved"
        );
        let helpers = parsed.get("credHelpers").expect("credHelpers should exist");
        assert!(
            helpers.get("ghcr.io").is_none(),
            "host-only credHelper should be stripped"
        );
        assert_eq!(
            helpers.get("123456789.dkr.ecr.us-east-1.amazonaws.com"),
            Some(&serde_json::json!("ecr-login")),
            "non-host-only credHelper should be preserved"
        );
    }

    #[test]
    fn clear_tunnel_token_is_noop_when_absent() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let summary = clear_tunnel_token(tempdir.path()).expect("clear_tunnel_token succeeds");
        assert!(
            summary.contains("already absent"),
            "missing token should report no-op, got: {summary}",
        );
        assert!(!tunnel_token_path_for(tempdir.path()).exists());
    }

    #[test]
    fn clear_tunnel_token_removes_token_and_empty_dir() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let token_path = tunnel_token_path_for(tempdir.path());
        std::fs::create_dir_all(token_path.parent().expect("parent")).expect("mkdir tunnel/");
        std::fs::write(&token_path, b"FAKE_TOKEN").expect("write token");

        let summary = clear_tunnel_token(tempdir.path()).expect("clear_tunnel_token succeeds");

        assert!(!token_path.exists(), "token file should be removed");
        assert!(
            !tunnel_dir_for(tempdir.path()).exists(),
            "empty tunnel dir should be removed",
        );
        assert!(
            summary.contains("removed"),
            "summary should report removal, got: {summary}",
        );
    }

    #[test]
    fn clear_tunnel_token_keeps_dir_with_siblings() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let token_path = tunnel_token_path_for(tempdir.path());
        std::fs::create_dir_all(token_path.parent().expect("parent")).expect("mkdir tunnel/");
        std::fs::write(&token_path, b"FAKE_TOKEN").expect("write token");
        // A sibling file (e.g. certs/) keeps the tunnel/ directory alive after token removal.
        std::fs::write(tunnel_dir_for(tempdir.path()).join("certs.pem"), b"PEM")
            .expect("write sibling");

        clear_tunnel_token(tempdir.path()).expect("clear_tunnel_token succeeds");

        assert!(!token_path.exists(), "token file should be removed");
        assert!(
            tunnel_dir_for(tempdir.path()).exists(),
            "tunnel dir with sibling files should be preserved",
        );
    }

    #[test]
    fn invalidate_config_hash_removes_saved_hash() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let hash_path = tempdir.path().join(".config-hash");
        std::fs::write(&hash_path, b"abc123").expect("write hash");

        super::invalidate_config_hash(tempdir.path());

        assert!(!hash_path.exists(), ".config-hash should be removed");
    }

    #[test]
    fn persist_config_hash_writes_compose_env_fingerprint() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let compose = tempdir.path().join("docker-compose.prod.yml");
        let env = tempdir.path().join(".env");
        std::fs::write(&compose, b"services: {}\n").expect("write compose");
        std::fs::write(&env, b"ROOT_FOLDER_HOST=/data\n").expect("write env");

        super::persist_config_hash(tempdir.path(), &compose, &env);

        let hash_path = tempdir.path().join(".config-hash");
        let saved = std::fs::read_to_string(&hash_path).expect("hash file");
        let expected = super::compute_config_hash(&compose, &env);
        assert_eq!(saved, expected);
    }
}
