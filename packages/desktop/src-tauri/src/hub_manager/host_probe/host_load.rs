//! Keeps the memory and disk figures in `host_metrics.json` current while the desktop app runs.
//!
//! On macOS and Windows the Hub's container sees Docker's VM and not the computer. Linux with
//! Docker Desktop's engine is the same. This file is the Hub's only view of the computer's memory
//! and disk there. The start probes in `metrics.rs` write it when the Hub starts. The Hub reads it
//! again on every request, so writing the figures again here keeps the Hub following the computer.
//! On a native Linux engine the Hub reads meminfo and the disk itself and doesn't use them.

#[allow(unused_imports)]
use super::*;
use std::sync::{MutexGuard, PoisonError};

const HOST_METRICS_FILE: &str = "state/hardware/host_metrics.json";
/// How often memory is read.
const HOST_LOAD_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
/// Disk is read on one refresh in this many. It moves slowly. On macOS reading it runs
/// `system_profiler`.
const DISK_REFRESH_EVERY: u64 = 5;
/// Free memory that moved by less than the total over this (1%) isn't worth a write.
const MEMORY_STEP_DIVISOR: u64 = 100;
/// While memory can be read, the file is written at least this often even when nothing moved, so
/// its `probedAt` keeps saying when the figures were read.
const HOST_LOAD_MAX_AGE_SECS: i64 = 10 * 60;

/// The start probes and the refresher both write `host_metrics.json`. One at a time, so a refresh
/// can't write back over what a start probe has just written.
static HOST_METRICS_FILE_LOCK: Mutex<()> = Mutex::new(());

#[cfg(target_os = "macos")]
const HOST_PLATFORM: &str = "darwin";
#[cfg(target_os = "windows")]
const HOST_PLATFORM: &str = "win32";
#[cfg(target_os = "linux")]
const HOST_PLATFORM: &str = "linux";
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
const HOST_PLATFORM: &str = "";

pub(crate) fn lock_host_metrics_file() -> MutexGuard<'static, ()> {
    HOST_METRICS_FILE_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Writes `host_metrics.json` through a temporary file and a rename, so the Hub never reads half
/// of it. When that fails (Windows won't replace a file another process has open, or the folder
/// takes no new file) it writes in place, as it always did before.
pub(crate) fn write_host_metrics_file(path: &Path, contents: &str) -> std::io::Result<()> {
    let temporary = path.with_file_name(format!(".host_metrics.json.{}.tmp", std::process::id()));
    let replaced =
        std::fs::write(&temporary, contents).and_then(|()| std::fs::rename(&temporary, path));
    if replaced.is_err() {
        let _ = std::fs::remove_file(&temporary);
        std::fs::write(path, contents)?;
    }
    Ok(())
}

/// Memory and disk as read now. `None` for a figure that couldn't be read or wasn't due.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct HostLoadSample {
    /// Total and available memory in MB.
    pub(crate) memory: Option<(u64, u64)>,
    /// Total and used disk in GB and where it was read.
    pub(crate) disk: Option<(u64, u64, String)>,
}

/// `probe` with `sample` in it and `probedAt` set to `now`. `None` when there is nothing to write:
/// the probe isn't one for `platform`, memory couldn't be read, or no figure moved and the file is
/// less than ten minutes old. CPU, firewall and the rest of the probe stay as the start probe wrote
/// them.
pub(crate) fn probe_with_host_load(
    probe: &serde_json::Value,
    platform: &str,
    sample: &HostLoadSample,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<serde_json::Value> {
    if probe.get("schemaVersion").and_then(|value| value.as_u64()) != Some(1)
        || probe.get("platform").and_then(|value| value.as_str()) != Some(platform)
    {
        return None;
    }
    let host = probe.get("host")?.as_object()?;
    let stored = |key: &str| host.get(key).and_then(|value| value.as_u64());
    stored("totalRamMb").filter(|total| *total > 0)?;
    // A write says the figures are from now, so there is none without a memory reading.
    let (total_mb, available_mb) = sample.memory.filter(|(total, _)| *total > 0)?;
    let available_mb = available_mb.min(total_mb);

    let step_mb = (total_mb / MEMORY_STEP_DIVISOR).max(1);
    let mut moved = stored("totalRamMb") != Some(total_mb)
        || stored("availableRamMb").map_or(true, |before| before.abs_diff(available_mb) >= step_mb);
    let mut next_host = host.clone();
    next_host.insert("totalRamMb".to_string(), total_mb.into());
    next_host.insert("availableRamMb".to_string(), available_mb.into());
    if let Some((disk_total_gb, disk_used_gb, disk_mount)) =
        sample.disk.as_ref().filter(|(total, _, _)| *total > 0)
    {
        moved |= stored("diskTotalGb") != Some(*disk_total_gb)
            || stored("diskUsedGb") != Some(*disk_used_gb)
            || host.get("diskMount").and_then(|value| value.as_str()) != Some(disk_mount.as_str());
        next_host.insert("diskTotalGb".to_string(), (*disk_total_gb).into());
        next_host.insert("diskUsedGb".to_string(), (*disk_used_gb).into());
        next_host.insert("diskMount".to_string(), disk_mount.clone().into());
    }

    // Either way round, so a clock stepped backwards doesn't hold off the next write.
    let age_secs = probe
        .get("probedAt")
        .and_then(|value| value.as_str())
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .map(|at| now.signed_duration_since(at).num_seconds().abs());
    if !moved && age_secs.is_some_and(|age| age < HOST_LOAD_MAX_AGE_SECS) {
        return None;
    }

    let mut next = probe.clone();
    next["host"] = serde_json::Value::Object(next_host);
    next["probedAt"] = now.to_rfc3339().into();
    Some(next)
}

/// Writes memory (and disk when `with_disk`) into this data folder's `host_metrics.json` when they
/// moved. A missing or unreadable file is left alone: the next start writes a whole one. `Ok(true)`
/// when it wrote.
pub(crate) fn refresh_host_load(data_dir: &Path, with_disk: bool) -> Result<bool, String> {
    let path = data_dir.join(HOST_METRICS_FILE);
    // Read outside the lock. On macOS a reading runs commands, which a start probe mustn't wait on.
    let Some(host) = read_probe(&path)?
        .and_then(|probe| probe.get("host").and_then(|host| host.as_object()).cloned())
    else {
        return Ok(false);
    };
    let sample = sample_host_load(data_dir, &host, with_disk);
    let _file = lock_host_metrics_file();
    // Again under the lock, so a probe a start wrote meanwhile keeps everything but these figures.
    let Some(probe) = read_probe(&path)? else {
        return Ok(false);
    };
    let Some(next) = probe_with_host_load(&probe, HOST_PLATFORM, &sample, chrono::Utc::now())
    else {
        return Ok(false);
    };
    let serialized = serde_json::to_string_pretty(&next)
        .map_err(|error| format!("Could not serialize host_metrics.json: {}", error))?;
    write_host_metrics_file(&path, &format!("{}\n", serialized))
        .map_err(|error| format!("Could not write {}: {}", path.display(), error))?;
    Ok(true)
}

/// The probe in `path`. `None` when there is no file or it isn't JSON.
fn read_probe(path: &Path) -> Result<Option<serde_json::Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => Ok(serde_json::from_str(&raw).ok()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read {}: {}", path.display(), error)),
    }
}

/// Keeps this data folder's memory and disk figures current for as long as the app runs: memory
/// every minute, disk every five minutes.
pub fn spawn_host_load_refresher(data_dir: PathBuf) {
    let log_dir = data_dir.clone();
    let spawned = std::thread::Builder::new()
        .name("host-load-refresh".to_string())
        .spawn(move || {
            let mut last_error: Option<String> = None;
            for refresh in 0u64.. {
                std::thread::sleep(HOST_LOAD_REFRESH_INTERVAL);
                match refresh_host_load(&data_dir, refresh % DISK_REFRESH_EVERY == 0) {
                    Ok(_) => {
                        if last_error.take().is_some() {
                            let _ = append_desktop_log_for(
                                &data_dir,
                                "hw.probe",
                                "Host memory and disk figures are being refreshed again",
                            );
                        }
                    }
                    Err(error) => {
                        // Once, not every minute it goes on failing the same way.
                        if last_error.as_deref() != Some(error.as_str()) {
                            let _ = append_desktop_log_for(&data_dir, "hw.probe", &error);
                        }
                        last_error = Some(error);
                    }
                }
            }
        });
    if let Err(error) = spawned {
        let _ = append_desktop_log_for(
            &log_dir,
            "hw.probe",
            &format!(
                "Could not start the host memory and disk refresh: {}",
                error
            ),
        );
    }
}

#[cfg(target_os = "linux")]
fn sample_host_load(
    data_dir: &Path,
    host: &serde_json::Map<String, serde_json::Value>,
    with_disk: bool,
) -> HostLoadSample {
    let memory = match (
        read_proc_meminfo_kb("MemTotal"),
        read_proc_meminfo_kb("MemAvailable"),
    ) {
        (Some(total_kb), Some(available_kb)) if total_kb > 0 => {
            Some((total_kb / 1024, available_kb / 1024))
        }
        _ => None,
    };
    let disk = if with_disk {
        // The folder the start probe read, so the figure doesn't jump to another disk.
        let folder = host
            .get("diskMount")
            .and_then(|value| value.as_str())
            .map(Path::new)
            .filter(|path| path.is_absolute() && path.is_dir())
            .unwrap_or(data_dir);
        let (total_gb, used_gb, mount) = linux_primary_disk_gb(folder);
        (total_gb > 0).then_some((total_gb, used_gb, mount))
    } else {
        None
    };
    HostLoadSample { memory, disk }
}

#[cfg(target_os = "macos")]
fn sample_host_load(
    _data_dir: &Path,
    host: &serde_json::Map<String, serde_json::Value>,
    with_disk: bool,
) -> HostLoadSample {
    // Physical memory doesn't change while the Mac runs, so the start probe's total stays. The
    // same reading and the same check as the start probe, without its 85% guess.
    let total_mb = host
        .get("totalRamMb")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let available_mb = detect_available_ram_mb_macos();
    let memory = (available_mb > 0 && available_mb <= total_mb).then_some((total_mb, available_mb));
    let disk = if with_disk {
        let (total_gb, used_gb, mount) = detect_macos_primary_disk_gb();
        (total_gb > 0).then_some((total_gb, used_gb, mount))
    } else {
        None
    };
    HostLoadSample { memory, disk }
}

#[cfg(target_os = "windows")]
fn sample_host_load(
    _data_dir: &Path,
    host: &serde_json::Map<String, serde_json::Value>,
    with_disk: bool,
) -> HostLoadSample {
    let memory = windows_load::memory_mb();
    let disk = if with_disk {
        let drive = host
            .get("diskMount")
            .and_then(|value| value.as_str())
            .filter(|mount| windows_load::is_drive(mount))
            .unwrap_or("C:");
        windows_load::disk_gb(drive)
            .map(|(total_gb, used_gb)| (total_gb, used_gb, drive.to_string()))
    } else {
        None
    };
    HostLoadSample { memory, disk }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn sample_host_load(
    _data_dir: &Path,
    _host: &serde_json::Map<String, serde_json::Value>,
    _with_disk: bool,
) -> HostLoadSample {
    HostLoadSample::default()
}

/// The same figures as the start probe's `Win32_OperatingSystem` and `Win32_LogicalDisk` query,
/// rounded the same way, from two kernel32 calls instead of starting PowerShell every minute.
#[cfg(target_os = "windows")]
mod windows_load {
    const MIB: u64 = 1024 * 1024;
    const GIB: u64 = 1024 * 1024 * 1024;

    /// MEMORYSTATUSEX.
    #[repr(C)]
    struct MemoryStatusEx {
        length: u32,
        memory_load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    const _: () = assert!(std::mem::size_of::<MemoryStatusEx>() == 64);

    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(buffer: *mut MemoryStatusEx) -> i32;
        fn GetDiskFreeSpaceExW(
            directory: *const u16,
            free_to_caller: *mut u64,
            total: *mut u64,
            total_free: *mut u64,
        ) -> i32;
    }

    fn rounded(value: u64, unit: u64) -> u64 {
        (value + unit / 2) / unit
    }

    pub(super) fn is_drive(mount: &str) -> bool {
        let bytes = mount.as_bytes();
        bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
    }

    /// Total and available memory in MB, as Task Manager counts available.
    pub(super) fn memory_mb() -> Option<(u64, u64)> {
        let mut status = MemoryStatusEx {
            length: std::mem::size_of::<MemoryStatusEx>() as u32,
            memory_load: 0,
            total_phys: 0,
            avail_phys: 0,
            total_page_file: 0,
            avail_page_file: 0,
            total_virtual: 0,
            avail_virtual: 0,
            avail_extended_virtual: 0,
        };
        // SAFETY: `status` is a MEMORYSTATUSEX with `length` set to its size, as the call requires.
        if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 || status.total_phys == 0 {
            return None;
        }
        Some((
            rounded(status.total_phys, MIB),
            rounded(status.avail_phys, MIB),
        ))
    }

    /// Total and used GB of the drive `drive` (`C:`).
    pub(super) fn disk_gb(drive: &str) -> Option<(u64, u64)> {
        let root: Vec<u16> = format!("{}\\", drive)
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let (mut free_to_caller, mut total, mut total_free) = (0u64, 0u64, 0u64);
        // SAFETY: `root` is a NUL-terminated UTF-16 path and each output points at a u64, the
        // layout of ULARGE_INTEGER.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                root.as_ptr(),
                &mut free_to_caller,
                &mut total,
                &mut total_free,
            )
        };
        let total_gb = rounded(total, GIB);
        if ok == 0 || total_gb == 0 {
            return None;
        }
        Some((total_gb, total_gb.saturating_sub(rounded(total_free, GIB))))
    }
}
