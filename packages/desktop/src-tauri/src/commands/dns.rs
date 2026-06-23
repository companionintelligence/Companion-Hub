use tauri::command;

/// Attempts to flush the system DNS cache.
/// This is a best-effort operation that may require elevated permissions on some systems.
/// Failures are silently ignored to avoid blocking the user experience.
#[command]
pub async fn flush_dns_cache() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("ipconfig")
            .arg("/flushdns")
            .output();
    }

    #[cfg(target_os = "macos")]
    {
        // Flush dscacheutil cache
        let _ = std::process::Command::new("dscacheutil")
            .arg("-flushcache")
            .output();

        // Restart mDNSResponder
        let _ = std::process::Command::new("killall")
            .arg("-HUP")
            .arg("mDNSResponder")
            .output();
    }

    #[cfg(target_os = "linux")]
    {
        // Try systemd-resolved (most common on modern Linux)
        let _ = std::process::Command::new("systemd-resolve")
            .arg("--flush-caches")
            .output();

        // Try resolvectl (newer systemd name)
        let _ = std::process::Command::new("resolvectl")
            .arg("flush-caches")
            .output();

        // Try nscd if available
        let _ = std::process::Command::new("nscd")
            .arg("-i")
            .arg("hosts")
            .output();
    }

    Ok(())
}
