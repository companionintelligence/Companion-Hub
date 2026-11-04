//! The NVIDIA container runtime on native Linux.

use super::*;

/// Installs nvidia-container-toolkit and registers its runtime with Docker. Runs as root via pkexec.
/// The Docker restart also restarts the Hub's containers, which come back by their restart policy.
pub(crate) fn nvidia_runtime_linux_install_script() -> &'static str {
    r#"#!/bin/bash
set -e
LIBNVIDIA=https://nvidia.github.io/libnvidia-container
if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    KEYRING=/etc/apt/keyrings/nvidia-container-toolkit-keyring.gpg
    command -v curl >/dev/null 2>&1 && command -v gpg >/dev/null 2>&1 || {
        apt-get update
        apt-get install -y --no-install-recommends curl gnupg ca-certificates
    }
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL "$LIBNVIDIA/gpgkey" | gpg --yes --dearmor -o "$KEYRING"
    curl -fsSL "$LIBNVIDIA/stable/deb/nvidia-container-toolkit.list" \
        | sed "s#deb https://#deb [signed-by=$KEYRING] https://#g" \
        > /etc/apt/sources.list.d/nvidia-container-toolkit.list
    apt-get update
    apt-get install -y nvidia-container-toolkit
elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL "$LIBNVIDIA/stable/rpm/nvidia-container-toolkit.repo" > /etc/yum.repos.d/nvidia-container-toolkit.repo
    dnf install -y nvidia-container-toolkit
elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm nvidia-container-toolkit
else
    echo "No supported package manager found (apt-get, dnf or pacman)." >&2
    exit 1
fi
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker
"#
}

/// The toolkit can't reach a GPU the host driver doesn't drive, so this refuses early and says so.
#[cfg(target_os = "linux")]
pub fn install_nvidia_runtime() -> Result<String, String> {
    if !nvidia_smi_answers() {
        return Err(
            "The NVIDIA driver isn't answering (nvidia-smi doesn't work). Install the driver and restart first."
                .to_string(),
        );
    }
    run_nvidia_runtime_installer()
}

#[cfg(not(target_os = "linux"))]
pub fn install_nvidia_runtime() -> Result<String, String> {
    Err("The NVIDIA container runtime is only installed automatically on Linux.".to_string())
}

#[cfg(target_os = "linux")]
pub(crate) fn run_nvidia_runtime_installer() -> Result<String, String> {
    let pkexec_path = find_executable("pkexec").ok_or_else(|| {
        "pkexec is not installed or not on PATH. Install polkit/pkexec and try again.".to_string()
    })?;
    let script = write_elevated_script(nvidia_runtime_linux_install_script().as_bytes())?;

    let output = Command::new(&pkexec_path)
        .arg(&*script)
        .output()
        .map_err(|e| format!("Failed to run pkexec installer: {}", e))?;

    if output.status.success() {
        return Ok("NVIDIA container runtime installed.".to_string());
    }
    let combined = format_command_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
    );
    if pkexec_refused(output.status.code(), &combined) {
        Err("Authorization was cancelled or denied.".to_string())
    } else if combined.is_empty() {
        Err(format!(
            "NVIDIA container runtime installation failed with exit code {:?}.",
            output.status.code()
        ))
    } else {
        Err(format!(
            "NVIDIA container runtime installation failed: {}",
            combined
        ))
    }
}

/// True when the host's driver answers: the same query the host probe runs.
#[cfg(target_os = "linux")]
fn nvidia_smi_answers() -> bool {
    linux_nvidia_smi_query()
        .map(|output| output.status.success() && !output.stdout.is_empty())
        .unwrap_or(false)
}
