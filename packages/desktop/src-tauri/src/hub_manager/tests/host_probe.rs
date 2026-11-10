//! Tests for the `host_probe` module: what `nvidia.json` holds from each OS's probe and how the
//! memory and disk figures in `host_metrics.json` are kept current.

#[allow(unused_imports)]
use super::*;
use crate::hub_manager::host_probe::{
    linux_nvidia_probe_from_output, linux_nvidia_probe_payload, probe_with_host_load,
    refresh_host_load, windows_nvidia_probe_payload, write_host_metrics_file, HostLoadSample,
};

/// The Hub takes `nvidia.json` as proof the host's driver answered in this boot only when
/// `updatedAt` is an RFC 3339 time within it, so every writer stamps it.
fn assert_stamped_now(payload: &serde_json::Value) {
    let stamp = payload
        .get("updatedAt")
        .and_then(|value| value.as_str())
        .expect("nvidia.json has no updatedAt");
    let written = chrono::DateTime::parse_from_rfc3339(stamp).expect("updatedAt is not RFC 3339");
    let age = chrono::Utc::now().signed_duration_since(written.with_timezone(&chrono::Utc));
    assert!(
        age.num_seconds().abs() < 60,
        "updatedAt {} is not now",
        stamp
    );
}

#[test]
fn windows_probe_from_nvidia_smi_is_stamped_and_keeps_the_card() {
    // What the PowerShell script prints when nvidia-smi.exe answered.
    let raw = r#"{"Name":"NVIDIA GeForce RTX 4070","VramMb":12282,"DriverVersion":"581.80","Source":"desktop-host-windows-nvidia-smi"}"#;

    let payload = windows_nvidia_probe_payload(raw).expect("payload");

    assert_eq!(payload["model"], "NVIDIA GeForce RTX 4070");
    assert_eq!(payload["vramMb"], 12282);
    assert_eq!(payload["driverVersion"], "581.80");
    assert_eq!(payload["source"], "desktop-host-windows-nvidia-smi");
    assert_stamped_now(&payload);
}

#[test]
fn windows_probe_from_wmi_is_stamped_and_reads_adapter_ram() {
    // No nvidia-smi.exe: WMI's 32-bit AdapterRAM, which saturates near 4 GB.
    let raw = r#"{"Name":"NVIDIA GeForce RTX 3060","AdapterRAM":4293918720,"DriverVersion":"32.0.15.8180","Source":"desktop-host-windows-wmi"}"#;

    let payload = windows_nvidia_probe_payload(raw).expect("payload");

    assert_eq!(payload["vramMb"], 4095);
    assert_eq!(payload["source"], "desktop-host-windows-wmi");
    assert_stamped_now(&payload);
}

#[test]
fn windows_probe_without_an_adapter_name_writes_nothing() {
    assert!(windows_nvidia_probe_payload(r#"{"VramMb":8192}"#).is_err());
    assert!(windows_nvidia_probe_payload("not json").is_err());
}

#[test]
fn linux_probe_is_stamped_and_takes_the_first_gpu() {
    let payload = linux_nvidia_probe_payload(
        "NVIDIA GeForce RTX 3080 Laptop GPU, 8192, 595.99.02\nNVIDIA RTX A1000, 8188, 595.99.02\n",
    )
    .expect("payload");

    assert_eq!(payload["model"], "NVIDIA GeForce RTX 3080 Laptop GPU");
    assert_eq!(payload["vramMb"], 8192);
    assert_eq!(payload["driverVersion"], "595.99.02");
    assert_eq!(payload["source"], "desktop-host-nvidia-smi");
    assert_stamped_now(&payload);
}

#[test]
fn linux_probe_with_no_row_writes_nothing() {
    assert!(linux_nvidia_probe_payload("\n").is_err());
    assert!(linux_nvidia_probe_payload(", 8192, 595.99.02").is_err());
}

#[test]
fn linux_probe_is_written_from_a_listed_gpu_even_when_nvidia_smi_exits_non_zero() {
    // One card of two could not be read: nvidia-smi still lists the other and exits 15.
    let (payload, note) = linux_nvidia_probe_from_output(
        Some(15),
        "NVIDIA GeForce RTX 3080 Laptop GPU, 8192, 595.99.02\n",
        "Unable to determine the device handle for GPU0002:00:00.0: Unknown Error",
    )
    .expect("a listed GPU writes the probe");

    assert_eq!(payload["vramMb"], 8192);
    let note = note.expect("the exit code is logged");
    assert!(note.contains("exit code 15"), "{}", note);
    assert!(note.contains("Unknown Error"), "{}", note);
}

#[test]
fn linux_probe_with_a_clean_exit_logs_nothing_extra_and_a_failed_run_with_no_row_says_why() {
    let (_, note) =
        linux_nvidia_probe_from_output(Some(0), "NVIDIA RTX A1000, 8188, 595.91.07\n", "")
            .expect("payload");
    assert!(note.is_none());

    let refused = linux_nvidia_probe_from_output(
        Some(9),
        "",
        "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.",
    )
    .expect_err("no row, no probe");
    assert!(refused.contains("exit code 9"), "{}", refused);
    assert!(refused.contains("couldn't communicate"), "{}", refused);
}

#[test]
fn linux_probe_after_a_failed_run_does_not_take_an_nvidia_smi_error_line_for_a_gpu() {
    // nvidia-smi prints these on stdout, with stderr empty.
    for (code, stdout) in [
        (6, "No devices were found\n"),
        (18, "Failed to initialize NVML: Driver/library version mismatch\nNVML library version: 595.99\n"),
    ] {
        let refused = linux_nvidia_probe_from_output(Some(code), stdout, "")
            .expect_err("an error line is not a GPU");
        assert!(refused.contains(&format!("exit code {}", code)), "{}", refused);
        assert!(refused.contains(stdout.lines().next().unwrap()), "{}", refused);
    }

    // A real row after an error line still counts.
    let (payload, note) = linux_nvidia_probe_from_output(
        Some(15),
        "Unable to determine the device handle for GPU0002:00:00.0: Unknown Error\nNVIDIA RTX A1000, 8188, 595.91.07\n",
        "",
    )
    .expect("the readable card is written");
    assert_eq!(payload["model"], "NVIDIA RTX A1000");
    assert_eq!(payload["vramMb"], 8188);
    assert!(note.is_some());
}

const PROBED_AT: &str = "2026-11-10T12:00:00+00:00";

/// A probe as the macOS start probe writes it, with a firewall entry as `cihub up` adds one.
fn stored_probe(platform: &str) -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "platform": platform,
        "cpuArch": "arm64",
        "source": "desktop-host-macos",
        "probedAt": PROBED_AT,
        "host": {
            "totalRamMb": 32768,
            "availableRamMb": 24576,
            "cpuCores": 12,
            "cpuModel": "Apple M2 Pro",
            "diskTotalGb": 494,
            "diskUsedGb": 200,
            "diskMount": "/System/Volumes/Data"
        },
        "firewall": { "kind": "none", "active": false }
    })
}

fn minutes_after_probe(minutes: i64) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(PROBED_AT)
        .unwrap()
        .with_timezone(&chrono::Utc)
        + chrono::Duration::minutes(minutes)
}

fn memory(available_mb: u64) -> HostLoadSample {
    HostLoadSample {
        memory: Some((32768, available_mb)),
        disk: None,
    }
}

#[test]
fn host_load_writes_the_memory_in_use_now_and_keeps_the_rest_of_the_probe() {
    let probe = stored_probe("darwin");

    let next = probe_with_host_load(&probe, "darwin", &memory(4096), minutes_after_probe(1))
        .expect("memory moved");

    assert_eq!(next["host"]["availableRamMb"], 4096);
    assert_eq!(next["host"]["totalRamMb"], 32768);
    assert_eq!(next["probedAt"], minutes_after_probe(1).to_rfc3339());
    // No disk reading this time: the stored one stays, as does everything the start probe wrote.
    assert_eq!(next["host"]["diskUsedGb"], 200);
    assert_eq!(next["host"]["diskMount"], "/System/Volumes/Data");
    assert_eq!(next["host"]["cpuModel"], "Apple M2 Pro");
    assert_eq!(next["host"]["cpuCores"], 12);
    assert_eq!(next["source"], "desktop-host-macos");
    assert_eq!(next["firewall"]["kind"], "none");
}

#[test]
fn host_load_skips_the_write_while_memory_moved_less_than_one_percent() {
    let probe = stored_probe("darwin");
    // 1% of 32768 MB is 327 MB.
    let unchanged_disk = HostLoadSample {
        memory: Some((32768, 24576 - 300)),
        disk: Some((494, 200, "/System/Volumes/Data".to_string())),
    };

    assert!(
        probe_with_host_load(&probe, "darwin", &unchanged_disk, minutes_after_probe(1)).is_none()
    );
    assert!(probe_with_host_load(
        &probe,
        "darwin",
        &memory(24576 + 327),
        minutes_after_probe(1)
    )
    .is_some());
}

#[test]
fn host_load_writes_the_disk_when_it_moved() {
    let probe = stored_probe("win32");
    let sample = HostLoadSample {
        memory: Some((32768, 24576)),
        disk: Some((494, 201, "/System/Volumes/Data".to_string())),
    };

    let next =
        probe_with_host_load(&probe, "win32", &sample, minutes_after_probe(1)).expect("disk moved");

    assert_eq!(next["host"]["diskUsedGb"], 201);
    assert_eq!(next["host"]["diskTotalGb"], 494);
}

#[test]
fn host_load_rewrites_an_unchanged_probe_once_it_is_ten_minutes_old() {
    let probe = stored_probe("linux");

    assert!(
        probe_with_host_load(&probe, "linux", &memory(24576), minutes_after_probe(9)).is_none()
    );
    let next = probe_with_host_load(&probe, "linux", &memory(24576), minutes_after_probe(10))
        .expect("ten minutes old");
    assert_eq!(next["probedAt"], minutes_after_probe(10).to_rfc3339());
    // A clock stepped back ten minutes doesn't hold the next write off for ten more.
    assert!(
        probe_with_host_load(&probe, "linux", &memory(24576), minutes_after_probe(-10)).is_some()
    );
}

#[test]
fn host_load_leaves_a_probe_for_another_os_or_another_schema_alone() {
    let probe = stored_probe("darwin");
    assert!(
        probe_with_host_load(&probe, "win32", &memory(1024), minutes_after_probe(60)).is_none()
    );

    let mut newer = stored_probe("darwin");
    newer["schemaVersion"] = 2.into();
    assert!(
        probe_with_host_load(&newer, "darwin", &memory(1024), minutes_after_probe(60)).is_none()
    );

    let mut no_total = stored_probe("darwin");
    no_total["host"]["totalRamMb"] = 0.into();
    assert!(
        probe_with_host_load(&no_total, "darwin", &memory(1024), minutes_after_probe(60)).is_none()
    );
}

#[test]
fn host_load_writes_nothing_without_a_memory_reading() {
    // A write stamps the figures as current, so a failed memory reading can't make one, however old
    // the file or whatever the disk did.
    let probe = stored_probe("darwin");
    let disk_only = HostLoadSample {
        memory: None,
        disk: Some((494, 300, "/System/Volumes/Data".to_string())),
    };

    assert!(
        probe_with_host_load(&probe, "darwin", &disk_only, minutes_after_probe(24 * 60)).is_none()
    );
}

#[test]
fn host_load_never_records_more_free_memory_than_there_is() {
    let probe = stored_probe("linux");
    let sample = HostLoadSample {
        memory: Some((16384, 20000)),
        disk: None,
    };

    let next = probe_with_host_load(&probe, "linux", &sample, minutes_after_probe(1))
        .expect("total changed");

    assert_eq!(next["host"]["totalRamMb"], 16384);
    assert_eq!(next["host"]["availableRamMb"], 16384);
}

#[test]
fn host_metrics_file_is_replaced_whole_and_leaves_no_temporary_file() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("host_metrics.json");
    std::fs::write(&path, "{\"old\":true}\n").expect("seed");

    write_host_metrics_file(&path, "{\"new\":true}\n").expect("write");

    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"new\":true}\n");
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from("host_metrics.json")]);
}

#[cfg(unix)]
#[test]
fn host_metrics_file_is_written_in_place_where_the_folder_takes_no_new_file() {
    use std::os::unix::fs::PermissionsExt;
    // Root creates files in a read-only folder anyway, so the rename would run and this would pass
    // without reaching the in-place write.
    // SAFETY: geteuid has no preconditions and can't fail.
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("host_metrics.json");
    std::fs::write(&path, "{\"old\":true}\n").expect("seed");
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o555)).unwrap();

    let written = write_host_metrics_file(&path, "{\"new\":true}\n");
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755)).unwrap();

    written.expect("write");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"new\":true}\n");
}

// On Windows a folder in the way reads as PermissionDenied, which is the in-place case.
#[cfg(unix)]
#[test]
fn host_metrics_file_stays_as_it_was_when_the_temporary_file_fails_for_another_reason() {
    // As on a full disk: writing in place would truncate the file first and could leave it empty.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("host_metrics.json");
    std::fs::write(&path, "{\"old\":true}\n").expect("seed");
    let temporary = dir
        .path()
        .join(format!(".host_metrics.json.{}.tmp", std::process::id()));
    std::fs::create_dir(&temporary).expect("a folder where the temporary file goes");

    assert!(write_host_metrics_file(&path, "{\"new\":true}\n").is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"old\":true}\n");
}

#[test]
fn refresh_host_load_leaves_a_missing_unreadable_or_foreign_probe_alone() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("state/hardware/host_metrics.json");

    assert_eq!(refresh_host_load(dir.path(), true), Ok(false));
    assert!(!path.exists(), "a refresh doesn't create the file");

    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    for stored in [
        "not json".to_string(),
        serde_json::to_string(&stored_probe("freebsd")).unwrap(),
    ] {
        std::fs::write(&path, &stored).unwrap();
        assert_eq!(refresh_host_load(dir.path(), true), Ok(false));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), stored);
    }
}

#[cfg(target_os = "linux")]
#[test]
fn refresh_host_load_writes_this_machines_memory_and_disk_into_the_linux_probe() {
    use crate::hub_manager::host_probe::{linux_primary_disk_gb, read_proc_meminfo_kb};
    let dir = tempfile::tempdir().expect("tempdir");
    let hardware = dir.path().join("state/hardware");
    std::fs::create_dir_all(&hardware).unwrap();
    let mut probe = stored_probe("linux");
    probe["host"]["totalRamMb"] = 1.into();
    probe["host"]["availableRamMb"] = 1.into();
    probe["host"]["diskMount"] = dir.path().to_string_lossy().into_owned().into();
    std::fs::write(
        hardware.join("host_metrics.json"),
        serde_json::to_string_pretty(&probe).unwrap(),
    )
    .unwrap();

    assert_eq!(refresh_host_load(dir.path(), true), Ok(true));

    let next: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(hardware.join("host_metrics.json")).unwrap())
            .unwrap();
    let total_mb = read_proc_meminfo_kb("MemTotal").unwrap() / 1024;
    assert_eq!(next["host"]["totalRamMb"], total_mb);
    let available_mb = next["host"]["availableRamMb"].as_u64().unwrap();
    assert!(
        available_mb > 1 && available_mb <= total_mb,
        "{}",
        available_mb
    );
    let (disk_total_gb, _, _) = linux_primary_disk_gb(dir.path());
    if disk_total_gb > 0 {
        assert_eq!(next["host"]["diskTotalGb"], disk_total_gb);
    }
    assert_eq!(next["host"]["cpuModel"], "Apple M2 Pro");
    assert_eq!(next["firewall"]["kind"], "none");
    assert_ne!(next["probedAt"], PROBED_AT);
    assert_eq!(std::fs::read_dir(&hardware).unwrap().count(), 1);
}
