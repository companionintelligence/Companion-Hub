//! Host installers for Docker, Ollama, ROCm and the alternative engines.

use super::*;

mod docker;
mod engine_alt;
mod nvidia;
mod ollama;
mod rocm;

pub use docker::*;
pub use engine_alt::*;
pub use nvidia::*;
pub use ollama::*;
pub use rocm::*;

/// Writes a script for pkexec to run as root and closes our handle on it.
///
/// Linux refuses to execute a file that any process holds open for writing, so running the path
/// of a live `NamedTempFile` fails with "Text file busy" right after the user approves the prompt.
/// The file is deleted when the returned `TempPath` is dropped, so keep it until pkexec returns.
#[cfg(target_os = "linux")]
pub(crate) fn write_elevated_script(contents: &[u8]) -> Result<tempfile::TempPath, String> {
    use std::io::Write as IoWrite;

    let mut script = tempfile::NamedTempFile::new()
        .map_err(|e| format!("Failed to create temporary install script: {}", e))?;
    script
        .write_all(contents)
        .map_err(|e| format!("Failed to write install script: {}", e))?;
    script
        .as_file()
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("Failed to set install script permissions: {}", e))?;
    Ok(script.into_temp_path())
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
