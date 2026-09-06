//! AMD ROCm probe state and installation.

use crate::hub_manager::*;

#[allow(unused_imports)]
use super::*;

#[cfg(target_os = "linux")]
fn rocm_probe_path(data_dir: &Path) -> PathBuf {
    data_dir.join("state/hardware/rocm.json")
}

#[cfg(target_os = "linux")]
fn rocm_install_state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("state/hardware/rocm-install.json")
}

#[cfg(target_os = "linux")]
fn write_rocm_install_state(data_dir: &Path, phase: &str, message: &str) {
    let path = rocm_install_state_path(data_dir);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = serde_json::json!({
        "phase": phase,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
        "message": message,
    });
    if let Ok(serialized) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(path, format!("{}\n", serialized));
    }
}

/// Refresh the host ROCm probe cache (`state/hardware/rocm.json`) on Linux.
pub fn refresh_rocm_host_probe_cache(data_dir: &Path) {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = data_dir;
        return;
    }

    #[cfg(target_os = "linux")]
    {
        let probe_path = rocm_probe_path(data_dir);
        if let Some(parent) = probe_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        let has_kfd = Path::new("/dev/kfd").exists() && Path::new("/dev/dri").exists();
        let source = if has_kfd {
            "host-dev-kfd"
        } else {
            let smi = Command::new("sh")
                .arg("-lc")
                .arg("rocm-smi --version")
                .output();
            match smi {
                Ok(output) if output.status.success() => {
                    let stdout_raw = String::from_utf8_lossy(&output.stdout);
                    let stdout = stdout_raw.trim();
                    if !stdout.is_empty() {
                        let payload = serde_json::json!({
                            "available": false,
                            "source": "host-rocm-smi",
                            "updatedAt": chrono::Utc::now().to_rfc3339(),
                            "message": "ROCm drivers detected but /dev/kfd is not ready yet. Restart may be required.",
                        });
                        if let Ok(serialized) = serde_json::to_string_pretty(&payload) {
                            let _ = std::fs::write(&probe_path, format!("{}\n", serialized));
                            let _ = append_desktop_log_for(
                                data_dir,
                                "gpu.probe",
                                &format!(
                                    "Updated host ROCm probe cache at {} (drivers present, /dev/kfd missing)",
                                    probe_path.display()
                                ),
                            );
                        }
                        return;
                    }
                }
                _ => {}
            }
            "host-dev-kfd"
        };

        let available = has_kfd;
        let payload = serde_json::json!({
            "available": available,
            "source": source,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        });
        if let Ok(serialized) = serde_json::to_string_pretty(&payload) {
            let _ = std::fs::write(&probe_path, format!("{}\n", serialized));
            let _ = append_desktop_log_for(
                data_dir,
                "gpu.probe",
                &format!(
                    "Updated host ROCm probe cache at {} (available={})",
                    probe_path.display(),
                    available
                ),
            );
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RocmInstallState {
    RebootRequired,
    Completed,
    Failed,
}

#[derive(Clone, serde::Serialize)]
pub struct RocmInstallResult {
    pub state: RocmInstallState,
    pub detail: Option<String>,
}

/// Install ROCm on Ubuntu via pkexec-elevated AMDGPU installer script.
pub fn install_rocm() -> Result<RocmInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        return install_rocm_linux();
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("ROCm auto-install is only supported on Linux.".to_string())
    }
}

/// Re-probe host ROCm devices and refresh install state after reboot.
pub fn verify_rocm_probe() -> Result<RocmInstallResult, String> {
    #[cfg(target_os = "linux")]
    {
        let data_dir = get_hub_data_dir();
        refresh_rocm_host_probe_cache(&data_dir);

        let has_kfd = Path::new("/dev/kfd").exists() && Path::new("/dev/dri").exists();
        if has_kfd {
            write_rocm_install_state(&data_dir, "completed", "ROCm is ready.");
            return Ok(RocmInstallResult {
                state: RocmInstallState::Completed,
                detail: Some("ROCm is available on the host.".to_string()),
            });
        }

        write_rocm_install_state(
            &data_dir,
            "reboot_required",
            "Restart your computer, reopen Companion Hub, then verify again.",
        );
        Ok(RocmInstallResult {
            state: RocmInstallState::RebootRequired,
            detail: Some(
                "ROCm is not ready yet. Restart your computer if you recently installed drivers."
                    .to_string(),
            ),
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        Err("ROCm verification is only supported on Linux.".to_string())
    }
}

#[cfg(any(test, target_os = "linux"))]
pub(crate) fn rocm_linux_install_script() -> &'static str {
    r#"#!/bin/bash
# ROCm auto-installer for Companion Hub. Runs as root via pkexec.
# Arg 1: username to add to render/video groups.
# Arg 2: Hub state directory (…/companion-hub/state).
set -euo pipefail
USERNAME="$1"
STATE_DIR="$2"
HARDWARE_DIR="${STATE_DIR}/hardware"
mkdir -p "$HARDWARE_DIR"

write_state() {
  phase="$1"
  msg="$2"
  cat > "${HARDWARE_DIR}/rocm-install.json" <<EOF
{
  "phase": "$phase",
  "updatedAt": "$(date -Iseconds)",
  "message": "$msg"
}
EOF
}

write_state "downloading" "Downloading AMDGPU installer…"

. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "Error: ROCm auto-install is only supported on Ubuntu." >&2
  write_state "failed" "Unsupported operating system"
  exit 1
fi

case "${VERSION_ID:-}" in
  22.04) CODENAME=jammy ;;
  24.04|26.04) CODENAME=noble ;;
  *)
    echo "Error: Unsupported Ubuntu version ${VERSION_ID}. Use 22.04, 24.04, or 26.04." >&2
    write_state "failed" "Unsupported Ubuntu version"
    exit 1
    ;;
esac

export DEBIAN_FRONTEND=noninteractive
write_state "installing" "Installing ROCm packages…"

apt-get update
apt-get install -y wget gpg curl ca-certificates \
  "linux-headers-$(uname -r)" 2>/dev/null \
  || apt-get install -y wget gpg curl ca-certificates linux-headers-generic

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
BASE_URL="https://repo.radeon.com/amdgpu-install/latest/ubuntu/${CODENAME}"
DEB="$(curl -fsSL "${BASE_URL}/" | grep -oE 'amdgpu-install_[0-9][^"]+_all\.deb' | head -1 || true)"
if [ -z "$DEB" ]; then
  echo "Error: Could not find amdgpu-install package for Ubuntu ${VERSION_ID} (${CODENAME})." >&2
  write_state "failed" "Could not find AMDGPU installer package"
  exit 1
fi

curl -fsSL "${BASE_URL}/${DEB}" -o "$WORKDIR/amdgpu-install.deb"
apt-get install -y "$WORKDIR/amdgpu-install.deb"
amdgpu-install -y --usecase=rocm

for grp in render video; do
  if getent group "$grp" >/dev/null 2>&1; then
    usermod -aG "$grp" "$USERNAME" || true
  fi
done

cat > "${HARDWARE_DIR}/rocm.json" <<EOF
{
  "available": false,
  "source": "host-dev-kfd",
  "updatedAt": "$(date -Iseconds)"
}
EOF

write_state "reboot_required" "Restart your computer to finish ROCm setup."
echo "ROCm installation complete. A system restart is required."
"#
}

#[cfg(target_os = "linux")]
fn install_rocm_linux() -> Result<RocmInstallResult, String> {
    use std::io::Write as IoWrite;
    use tempfile::NamedTempFile;

    let data_dir = get_hub_data_dir();
    let state_dir = data_dir.join("state");
    let username = resolve_current_username()?;
    let pkexec_path = find_executable("pkexec").ok_or_else(|| {
        "pkexec is not installed or not on PATH. Install polkit/pkexec and try again.".to_string()
    })?;

    write_rocm_install_state(&data_dir, "downloading", "Downloading AMDGPU installer…");
    let _ = append_desktop_log_for(
        &data_dir,
        "rocm.install",
        "Starting ROCm installation via pkexec",
    );

    let mut wrapper_script = NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary install script: {}", e))?;
    wrapper_script
        .write_all(rocm_linux_install_script().as_bytes())
        .map_err(|e| format!("Failed to write install script: {}", e))?;

    let permissions = std::fs::Permissions::from_mode(0o700);
    wrapper_script
        .as_file()
        .set_permissions(permissions)
        .map_err(|e| format!("Failed to set install script permissions: {}", e))?;

    let output = Command::new(&pkexec_path)
        .arg(wrapper_script.path())
        .arg(&username)
        .arg(state_dir)
        .output()
        .map_err(|e| format!("Failed to run pkexec ROCm installer: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let combined = format_command_output(&stdout, &stderr);
    let _ = append_desktop_log_for(
        &data_dir,
        "rocm.install",
        &truncate_command_output(&combined),
    );

    if output.status.success() {
        write_rocm_install_state(
            &data_dir,
            "reboot_required",
            "Restart your computer to finish ROCm setup.",
        );
        Ok(RocmInstallResult {
            state: RocmInstallState::RebootRequired,
            detail: Some(
                "ROCm packages installed. Restart your computer, reopen Hub, then click Verify."
                    .to_string(),
            ),
        })
    } else {
        write_rocm_install_state(&data_dir, "failed", "ROCm installation failed");
        let combined_lower = combined.to_lowercase();

        if combined_lower.contains("dismissed")
            || combined_lower.contains("not authorized")
            || combined_lower.contains("authorization required")
            || combined_lower.contains("authentication failed")
        {
            Err("Authorization was cancelled or denied.".to_string())
        } else if combined.is_empty() {
            Err(format!(
                "ROCm installation failed with exit code {:?}.",
                output.status.code()
            ))
        } else {
            Err(format!("ROCm installation failed: {}", combined))
        }
    }
}
