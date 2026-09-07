//! NVIDIA and AMD GPU probe caches.

use crate::hub_manager::*;

#[allow(unused_imports)]
use super::*;

pub(crate) fn refresh_nvidia_host_probe_cache(data_dir: &Path) {
    let probe_path = data_dir.join("state/hardware/nvidia.json");
    if let Some(parent) = probe_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let clear_stale_probe = || {
        let _ = std::fs::remove_file(&probe_path);
    };

    #[cfg(target_os = "windows")]
    {
        let script = "$smi = (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue).Source; 
if (-not $smi) { 
    $candidates = @($env:SystemRoot + '\\System32\\nvidia-smi.exe', $env:ProgramFiles + '\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe', ${env:ProgramFiles(x86)} + '\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'); 
    $smi = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1; 
}; 
if ($smi) { 
    $rows = & $smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>$null; 
    $best = $rows | ForEach-Object { 
        $parts = $_.Split(','); 
        if ($parts.Length -ge 2) { 
            [PSCustomObject]@{ Name = $parts[0].Trim(); VramMb = [int64]$parts[1].Trim(); DriverVersion = $(if ($parts.Length -ge 3) { $parts[2].Trim() } else { '' }); Source = 'desktop-host-windows-nvidia-smi' } 
        } 
    } | Sort-Object VramMb -Descending | Select-Object -First 1; 
    if ($best -ne $null) { $best | ConvertTo-Json -Compress; exit 0 } 
}; 
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA' } | Select-Object -First 1 Name,AdapterRAM,DriverVersion; 
if ($null -eq $gpu) { exit 3 }; 
[PSCustomObject]@{ Name = $gpu.Name; AdapterRAM = [int64]$gpu.AdapterRAM; DriverVersion = $gpu.DriverVersion; Source = 'desktop-host-windows-wmi' } | ConvertTo-Json -Compress";
        let mut command = Command::new("powershell.exe");
        command
            .creation_flags(CREATE_NO_WINDOW)
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(script);

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
            .get("VramMb")
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
            })
            .or_else(|| {
                parsed
                    .get("AdapterRAM")
                    .and_then(|value| value.as_u64())
                    .map(|bytes| bytes / (1024 * 1024))
            })
            .unwrap_or(0);
        let driver_version = parsed
            .get("DriverVersion")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let source = parsed
            .get("Source")
            .and_then(|value| value.as_str())
            .unwrap_or("desktop-host-windows-wmi");

        let payload = serde_json::json!({
            "model": model,
            "vramMb": vram_mb,
            "driverVersion": driver_version,
            "source": source
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

/// Surface host AMD/Radeon GPU hardware to the backend on Windows.
///
/// Windows' WMI `Win32_VideoController.AdapterRAM` field is a 32-bit `uint32`
/// and therefore saturates at 4 GiB (`4294967295` bytes), so it cannot report
/// the true VRAM of a modern discrete AMD card (e.g. a 24 GB Radeon would be
/// clamped to ~4 GB). To get the real size we read the 64-bit
/// `HardwareInformation.qwMemorySize` REG_QWORD that the display driver writes
/// under the GPU class key, falling back to `AdapterRAM` only when the QWORD is
/// unavailable.
#[cfg(target_os = "windows")]
pub(crate) fn refresh_amd_host_probe_cache(data_dir: &Path) {
    let probe_path = data_dir.join("state/hardware/amd.json");
    if let Some(parent) = probe_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let clear_stale_probe = || {
        let _ = std::fs::remove_file(&probe_path);
    };

    // Match the AMD/Radeon/ATI adapter via WMI for the model + driver version,
    // then walk the display-class registry keys to recover the 64-bit VRAM size
    // (qwMemorySize) which is not subject to the 32-bit AdapterRAM ceiling.
    let script = "$amd = Get-CimInstance Win32_VideoController | 
Where-Object { $_.Name -match 'AMD|Radeon|ATI' } | Select-Object -First 1; 
if ($null -eq $amd) { exit 3 }; 
$vram = [int64]0; 
$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'; 
Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object { 
$p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; 
$q = $p.'HardwareInformation.qwMemorySize'; 
if ($q -ne $null -and ($p.DriverDesc -match 'AMD|Radeon|ATI')) { 
$c = [int64]$q; if ($c -gt $vram) { $vram = $c } } }; 
[PSCustomObject]@{ Name = $amd.Name; QwMemorySizeBytes = $vram; 
AdapterRAM = [int64]$amd.AdapterRAM; DriverVersion = $amd.DriverVersion } | ConvertTo-Json -Compress";

    let mut command = Command::new("powershell.exe");
    command
        .creation_flags(CREATE_NO_WINDOW)
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(script);

    let output = match command.output() {
        Ok(value) => value,
        Err(error) => {
            clear_stale_probe();
            let _ = append_desktop_log_for(
                data_dir,
                "gpu.probe",
                &format!(
                    "Skipping Windows AMD probe cache refresh (PowerShell unavailable): {}",
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
            "No AMD GPU found via Windows WMI; host AMD probe cache cleared.".to_string()
        } else {
            format!("Windows AMD probe command failed: {}", stderr)
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
                &format!("Failed to parse Windows AMD probe output: {}", error),
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
            "Windows AMD probe output missing adapter name; host cache not updated.",
        );
        return;
    }

    // ConvertTo-Json may emit a large QWORD as either a JSON number or a string,
    // so accept both. Both fields are byte counts.
    let as_bytes = |field: &str| -> u64 {
        parsed
            .get(field)
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|s| s.trim().parse::<u64>().ok()))
            })
            .unwrap_or(0)
    };

    // Prefer the 64-bit qwMemorySize; only fall back to the 32-bit AdapterRAM
    // (which tops out at ~4 GiB) when the QWORD could not be read.
    let qw_bytes = as_bytes("QwMemorySizeBytes");
    let adapter_ram_bytes = as_bytes("AdapterRAM");
    let vram_bytes = if qw_bytes > 0 {
        qw_bytes
    } else {
        adapter_ram_bytes
    };
    let vram_mb = vram_bytes / (1024 * 1024);

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
        "source": "desktop-host-windows-wmi-amd"
    });

    let serialized = match serde_json::to_string_pretty(&payload) {
        Ok(value) => format!("{}\n", value),
        Err(error) => {
            clear_stale_probe();
            let _ = append_desktop_log_for(
                data_dir,
                "gpu.probe",
                &format!("Failed to serialize Windows AMD probe cache: {}", error),
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
                    "Updated Windows host AMD probe cache at {} ({} MB VRAM)",
                    probe_path.display(),
                    vram_mb
                ),
            );
        }
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                "gpu.probe",
                &format!(
                    "Failed to write Windows host AMD probe cache at {}: {}",
                    probe_path.display(),
                    error
                ),
            );
        }
    }
}
