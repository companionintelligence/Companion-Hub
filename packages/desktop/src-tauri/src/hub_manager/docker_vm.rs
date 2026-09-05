//! Docker Desktop / Colima VM resource sizing and tuning.

use super::*;

#[cfg(any(target_os = "linux", target_os = "macos"))]
const MIN_DOCKER_RAM_MB: u64 = 8192;
#[cfg(any(target_os = "linux", target_os = "macos"))]
const DOCKER_OS_RESERVE_MB: u64 = 4096;
#[cfg(any(target_os = "linux", target_os = "macos"))]
const MIN_DOCKER_DISK_GB: u64 = 64;

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn recommended_docker_vm_ram_mb(host_total_mb: u64) -> u64 {
    if host_total_mb == 0 {
        return MIN_DOCKER_RAM_MB;
    }
    let capped = ((host_total_mb as f64) * 0.75) as u64;
    let reserved = host_total_mb.saturating_sub(DOCKER_OS_RESERVE_MB);
    let target = std::cmp::min(capped, reserved);
    std::cmp::max(MIN_DOCKER_RAM_MB, std::cmp::min(target, host_total_mb))
}

#[cfg(target_os = "linux")]
fn docker_desktop_settings_path() -> Option<PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".docker/desktop/settings-store.json"))
        .filter(|p| p.exists())
}

#[cfg(target_os = "macos")]
fn docker_desktop_settings_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    [
        home.join("Library/Group Containers/group.com.docker/settings-store.json"),
        home.join(".docker/desktop/settings-store.json"),
    ]
    .into_iter()
    .find(|p| p.exists())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn read_docker_desktop_u64(
    settings: &serde_json::Value,
    key: &str,
    legacy_key: &str,
) -> Option<u64> {
    settings
        .get(key)
        .or_else(|| settings.get(legacy_key))
        .and_then(|m| m.as_u64())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn write_docker_tuning_record(data_dir: &Path, record: serde_json::Value) {
    let path = data_dir.join("state/hardware/docker-tuning.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_string_pretty(&record) {
        let _ = std::fs::write(path, format!("{serialized}\n"));
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn try_restart_docker_desktop() {
    let docker = find_docker_binary();
    let _ = Command::new(&docker)
        .args(["desktop", "restart"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Host hardware totals used to size the Docker Desktop VM.
#[cfg(any(target_os = "linux", target_os = "macos"))]
struct HostVmSizingInputs {
    total_ram_mb: u64,
    cpu_cores: u64,
    disk_total_gb: u64,
}

/// With Docker Desktop, containers run in a VM whose RAM/CPU/disk caps live in
/// `settings-store.json`. Best-effort, raise-only tuning: memory toward ~75% of host
/// RAM, CPUs toward all host cores, disk toward half the host disk (the disk image is
/// sparse, so a higher cap costs nothing until apps use the space). Restarts Docker
/// Desktop when something changed and records the outcome in
/// `state/hardware/docker-tuning.json` (shown in Settings → System).
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn ensure_docker_desktop_vm_resources(data_dir: &Path, platform: &str, host: HostVmSizingInputs) {
    let settings_path = match docker_desktop_settings_path() {
        // No settings file means a native engine or no Docker Desktop — nothing to tune
        Some(path) => path,
        None => return,
    };

    if host.total_ram_mb == 0 {
        return;
    }

    let attempted_at = chrono::Utc::now().to_rfc3339();

    let mut settings: serde_json::Value = match std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    {
        Some(value) if value.is_object() => value,
        _ => serde_json::json!({}),
    };

    let recommended_ram_mb = recommended_docker_vm_ram_mb(host.total_ram_mb);
    let ram_threshold_mb = (recommended_ram_mb as f64 * 0.9) as u64;
    let current_ram_mib =
        read_docker_desktop_u64(&settings, "memoryMiB", "MemoryMiB").unwrap_or(MIN_DOCKER_RAM_MB);
    let raise_ram = current_ram_mib < ram_threshold_mb;

    // Give the VM every host core; per-app fairness comes from compose-level CPU caps.
    let current_cpus = read_docker_desktop_u64(&settings, "cpus", "Cpus").unwrap_or(0);
    let raise_cpus = host.cpu_cores > 0 && current_cpus < host.cpu_cores;

    // Only touch the disk cap when the key already exists — a missing key means
    // Docker Desktop manages its own (often larger) default.
    let recommended_disk_mib = std::cmp::max(MIN_DOCKER_DISK_GB, host.disk_total_gb / 2) * 1024;
    let current_disk_mib = read_docker_desktop_u64(&settings, "diskSizeMiB", "DiskSizeMiB");
    let raise_disk = host.disk_total_gb > 0
        && matches!(current_disk_mib, Some(current) if current < recommended_disk_mib);

    if !raise_ram && !raise_cpus && !raise_disk {
        write_docker_tuning_record(
            data_dir,
            serde_json::json!({
                "attemptedAt": attempted_at,
                "platform": platform,
                "action": "noop",
                "reason": "Docker Desktop VM resources already at or above recommended values",
                "previousMemoryMb": current_ram_mib,
                "targetMemoryMb": recommended_ram_mb,
                "appliedMemoryMb": current_ram_mib,
                "previousCpus": current_cpus,
                "targetCpus": host.cpu_cores,
            }),
        );
        return;
    }

    let Some(obj) = settings.as_object_mut() else {
        return;
    };

    let mut changes: Vec<String> = Vec::new();
    if raise_ram {
        obj.insert(
            "memoryMiB".to_string(),
            serde_json::Value::Number(serde_json::Number::from(recommended_ram_mb)),
        );
        changes.push(format!(
            "memoryMiB {current_ram_mib} → {recommended_ram_mb}"
        ));
    }
    if raise_cpus {
        obj.insert(
            "cpus".to_string(),
            serde_json::Value::Number(serde_json::Number::from(host.cpu_cores)),
        );
        changes.push(format!("cpus {current_cpus} → {}", host.cpu_cores));
    }
    if raise_disk {
        obj.insert(
            "diskSizeMiB".to_string(),
            serde_json::Value::Number(serde_json::Number::from(recommended_disk_mib)),
        );
        changes.push(format!(
            "diskSizeMiB {} → {recommended_disk_mib}",
            current_disk_mib.unwrap_or(0)
        ));
    }

    let serialized = match serde_json::to_string_pretty(&settings) {
        Ok(value) => format!("{value}\n"),
        Err(error) => {
            write_docker_tuning_record(
                data_dir,
                serde_json::json!({
                    "attemptedAt": attempted_at,
                    "platform": platform,
                    "action": "failed",
                    "reason": format!("Could not serialize Docker Desktop settings: {error}"),
                    "previousMemoryMb": current_ram_mib,
                    "targetMemoryMb": recommended_ram_mb,
                }),
            );
            return;
        }
    };

    match std::fs::write(&settings_path, serialized) {
        Ok(_) => {
            try_restart_docker_desktop();
            let _ = append_desktop_log_for(
                data_dir,
                "docker.vm",
                &format!(
                    "Raised Docker Desktop VM resources ({}) for host with {} MB RAM / {} cores / {} GB disk; requested Docker Desktop restart.",
                    changes.join(", "),
                    host.total_ram_mb,
                    host.cpu_cores,
                    host.disk_total_gb,
                ),
            );
            write_docker_tuning_record(
                data_dir,
                serde_json::json!({
                    "attemptedAt": attempted_at,
                    "platform": platform,
                    "action": "updated",
                    "reason": format!("Increased Docker Desktop VM resources: {} (restart Docker Desktop if resources still look capped)", changes.join(", ")),
                    "previousMemoryMb": current_ram_mib,
                    "targetMemoryMb": recommended_ram_mb,
                    "appliedMemoryMb": if raise_ram { recommended_ram_mb } else { current_ram_mib },
                    "previousCpus": current_cpus,
                    "targetCpus": host.cpu_cores,
                    "appliedCpus": if raise_cpus { host.cpu_cores } else { current_cpus },
                }),
            );
        }
        Err(error) => {
            let _ = append_desktop_log_for(
                data_dir,
                "docker.vm",
                &format!(
                    "Could not write Docker Desktop settings at {}: {error}. Raise resources manually under Docker Desktop → Settings → Resources.",
                    settings_path.display()
                ),
            );
            write_docker_tuning_record(
                data_dir,
                serde_json::json!({
                    "attemptedAt": attempted_at,
                    "platform": platform,
                    "action": "failed",
                    "reason": format!("Could not write Docker Desktop settings: {error}"),
                    "previousMemoryMb": current_ram_mib,
                    "targetMemoryMb": recommended_ram_mb,
                }),
            );
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn ensure_docker_vm_resources(data_dir: &Path) {
    let total_ram_mb = match read_proc_meminfo_kb("MemTotal") {
        Some(kb) => kb / 1024,
        None => return,
    };
    let (_, cpu_cores) = read_linux_cpu_info();
    let (disk_total_gb, _, _) = linux_primary_disk_gb(data_dir);

    ensure_docker_desktop_vm_resources(
        data_dir,
        "linux",
        HostVmSizingInputs {
            total_ram_mb,
            cpu_cores: cpu_cores as u64,
            disk_total_gb,
        },
    );
}

#[cfg(target_os = "macos")]
fn sysctl_u64(name: &str) -> Option<u64> {
    let output = Command::new("sysctl").args(["-n", name]).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(target_os = "macos")]
pub(crate) fn ensure_docker_vm_resources(data_dir: &Path) {
    let total_ram_mb = match sysctl_u64("hw.memsize") {
        Some(bytes) if bytes > 0 => bytes / 1024 / 1024,
        _ => return,
    };
    let cpu_cores = sysctl_u64("hw.logicalcpu").unwrap_or(0);
    let (disk_total_gb, _, _) = detect_macos_primary_disk_gb();

    ensure_docker_desktop_vm_resources(
        data_dir,
        "darwin",
        HostVmSizingInputs {
            total_ram_mb,
            cpu_cores,
            disk_total_gb,
        },
    );
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn ensure_docker_vm_resources(_data_dir: &Path) {}
