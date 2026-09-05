//! Per-OS CPU, RAM and disk metrics probing.

use crate::hub_manager::*;

#[allow(unused_imports)]
use super::*;

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
pub(crate) fn detect_macos_primary_disk_gb() -> (u64, u64, String) {
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
pub(crate) fn refresh_windows_host_metrics_probe_cache(data_dir: &Path) {
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
pub(crate) fn refresh_windows_host_metrics_probe_cache(_data_dir: &Path) {}

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
pub(crate) fn refresh_macos_host_probe_cache(data_dir: &Path) {
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
pub(crate) fn refresh_macos_host_probe_cache(_data_dir: &Path) {
    // No-op on non-macOS platforms.
}

/// On Linux the Tauri binary runs directly on the host, so `/proc/meminfo` and
/// `/proc/cpuinfo` reflect true host hardware (not Docker Desktop VM limits).
/// Write `host_metrics.json` so the backend container uses host RAM and CPU values.
#[cfg(target_os = "linux")]
pub(crate) fn refresh_linux_host_metrics_probe_cache(data_dir: &Path) {
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
pub(crate) fn refresh_linux_host_metrics_probe_cache(_data_dir: &Path) {}

/// Parse a named field from `/proc/meminfo` and return its value in kB.
/// e.g. `MemTotal:      131891648 kB` → `131891648`
#[cfg(target_os = "linux")]
pub(crate) fn read_proc_meminfo_kb(field: &str) -> Option<u64> {
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
pub(crate) fn read_linux_cpu_info() -> (String, u32) {
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
pub(crate) fn linux_primary_disk_gb(data_dir: &Path) -> (u64, u64, String) {
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
