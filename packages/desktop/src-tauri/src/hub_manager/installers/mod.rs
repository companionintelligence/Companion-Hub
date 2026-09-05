//! Host installers for Docker, Ollama, ROCm and the alternative engines.

use super::*;

mod docker;
mod engine_alt;
mod ollama;
mod rocm;

pub use docker::*;
pub use engine_alt::*;
pub use ollama::*;
pub use rocm::*;

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
