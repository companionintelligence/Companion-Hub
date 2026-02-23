use serde::{Deserialize, Serialize};
use sysinfo::System;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SystemInfo {
    pub os: String,
    pub os_version: String,
    pub architecture: String,
    pub total_memory_gb: f64,
    pub available_disk_space_gb: f64,
    pub cpu_count: usize,
    pub has_virtualization: bool,
    pub meets_requirements: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SystemRequirements {
    pub min_memory_gb: f64,
    pub recommended_memory_gb: f64,
    pub min_disk_space_gb: f64,
}

impl Default for SystemRequirements {
    fn default() -> Self {
        Self {
            min_memory_gb: 4.0,
            recommended_memory_gb: 8.0,
            min_disk_space_gb: 10.0,
        }
    }
}

#[tauri::command]
pub async fn check_system_requirements() -> Result<SystemInfo, String> {
    let mut sys = System::new_all();
    sys.refresh_all();

    let requirements = SystemRequirements::default();
    let mut warnings = Vec::new();

    // Get OS information
    let os = std::env::consts::OS.to_string();
    let os_version = System::os_version().unwrap_or_else(|| "Unknown".to_string());
    let architecture = std::env::consts::ARCH.to_string();

    // Get memory information (convert from bytes to GB)
    let total_memory_gb = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
    
    // Check memory requirements
    if total_memory_gb < requirements.min_memory_gb {
        warnings.push(format!(
            "Insufficient RAM: {:.1}GB detected, minimum {:.0}GB required",
            total_memory_gb, requirements.min_memory_gb
        ));
    } else if total_memory_gb < requirements.recommended_memory_gb {
        warnings.push(format!(
            "RAM below recommended: {:.1}GB detected, {:.0}GB recommended for optimal performance",
            total_memory_gb, requirements.recommended_memory_gb
        ));
    }

    // Get disk space (using current directory as reference)
    let available_disk_space_gb = get_available_disk_space()?;
    
    // Check disk space requirements
    if available_disk_space_gb < requirements.min_disk_space_gb {
        warnings.push(format!(
            "Insufficient disk space: {:.1}GB available, minimum {:.0}GB required",
            available_disk_space_gb, requirements.min_disk_space_gb
        ));
    }

    // Get CPU count
    let cpu_count = sys.cpus().len();

    // Check virtualization support (platform-specific)
    let has_virtualization = check_virtualization_support();

    if !has_virtualization {
        warnings.push(
            "Virtualization support not detected. Docker may require hardware virtualization (VT-x/AMD-V) to be enabled in BIOS".to_string()
        );
    }

    let meets_requirements = total_memory_gb >= requirements.min_memory_gb
        && available_disk_space_gb >= requirements.min_disk_space_gb;

    Ok(SystemInfo {
        os,
        os_version,
        architecture,
        total_memory_gb: (total_memory_gb * 10.0).round() / 10.0, // Round to 1 decimal
        available_disk_space_gb: (available_disk_space_gb * 10.0).round() / 10.0,
        cpu_count,
        has_virtualization,
        meets_requirements,
        warnings,
    })
}

fn get_available_disk_space() -> Result<f64, String> {
    use std::path::Path;
    
    let path = std::env::current_dir().map_err(|e| e.to_string())?;
    
    #[cfg(target_os = "windows")]
    {
        get_disk_space_windows(&path)
    }
    #[cfg(not(target_os = "windows"))]
    {
        get_disk_space_unix(&path)
    }
}

#[cfg(target_os = "windows")]
fn get_disk_space_windows(path: &std::path::Path) -> Result<f64, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    
    let root = path
        .ancestors()
        .last()
        .ok_or("Could not determine root path")?;
    
    let wide: Vec<u16> = OsStr::new(root)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    
    let mut available_bytes: u64 = 0;
    
    unsafe {
        if winapi::um::fileapi::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut available_bytes as *mut u64 as *mut _,
        ) == 0
        {
            return Err("Failed to get disk space".to_string());
        }
    }
    
    Ok(available_bytes as f64 / (1024.0 * 1024.0 * 1024.0))
}

#[cfg(not(target_os = "windows"))]
fn get_disk_space_unix(path: &std::path::Path) -> Result<f64, String> {
    use std::mem;
    use std::os::unix::ffi::OsStrExt;
    use std::ffi::CString;
    
    let path_cstr = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| "Invalid path")?;
    
    unsafe {
        let mut stats: libc::statvfs = mem::zeroed();
        if libc::statvfs(path_cstr.as_ptr(), &mut stats) != 0 {
            return Err("Failed to get disk space".to_string());
        }
        
        let available_bytes = stats.f_bavail as u64 * stats.f_frsize as u64;
        Ok(available_bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

fn check_virtualization_support() -> bool {
    #[cfg(target_os = "windows")]
    {
        check_virtualization_windows()
    }
    #[cfg(target_os = "macos")]
    {
        // macOS Intel Macs and Apple Silicon both support virtualization
        true
    }
    #[cfg(target_os = "linux")]
    {
        check_virtualization_linux()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        false
    }
}

#[cfg(target_os = "windows")]
fn check_virtualization_windows() -> bool {
    // Check if Hyper-V is enabled via systeminfo command
    use std::process::Command;
    
    if let Ok(output) = Command::new("systeminfo").output() {
        if let Ok(stdout) = String::from_utf8(output.stdout) {
            // Look for virtualization indicators
            return stdout.contains("Hyper-V Requirements") 
                || stdout.contains("Virtualization Enabled In Firmware: Yes")
                || stdout.contains("A hypervisor has been detected");
        }
    }
    
    // If command fails, assume virtualization might be available
    true
}

#[cfg(target_os = "linux")]
fn check_virtualization_linux() -> bool {
    use std::fs;
    
    // Check /proc/cpuinfo for virtualization flags
    if let Ok(cpuinfo) = fs::read_to_string("/proc/cpuinfo") {
        return cpuinfo.contains("vmx") || cpuinfo.contains("svm");
    }
    
    false
}
