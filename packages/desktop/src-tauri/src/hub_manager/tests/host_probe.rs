//! Tests for the `host_probe` module: what `nvidia.json` holds, from each OS's probe.

#[allow(unused_imports)]
use super::*;
use crate::hub_manager::host_probe::{
    linux_nvidia_probe_from_output, linux_nvidia_probe_payload, windows_nvidia_probe_payload,
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
