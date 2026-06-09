use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;

use crate::hub_manager::{self, PersistedLaunchMode};

const UPDATE_CHECK_URL: &str = "https://dl.ci.computer/latest.json";
const ALLOWED_DOWNLOAD_HOST: &str = "dl.ci.computer";
const UPDATE_LISTENER_ADDR: &str = "127.0.0.1:17400";

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateProgress {
    pub phase: String,
    pub message: String,
}

static UPDATE_PROGRESS: OnceLock<Mutex<Option<UpdateProgress>>> = OnceLock::new();

fn progress_store() -> &'static Mutex<Option<UpdateProgress>> {
    UPDATE_PROGRESS.get_or_init(|| Mutex::new(None))
}

fn set_progress(phase: &str, message: &str) {
    if let Ok(mut guard) = progress_store().lock() {
        *guard = Some(UpdateProgress {
            phase: phase.to_string(),
            message: message.to_string(),
        });
    }
}

pub fn get_update_progress() -> Option<UpdateProgress> {
    progress_store()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

#[derive(Deserialize)]
struct LatestJson {
    version: String,
}

#[derive(Deserialize)]
struct PlatformArtifact {
    url: String,
    size: u64,
}

#[derive(Deserialize)]
struct ManifestJson {
    version: String,
    platforms: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub download_url: String,
    pub update_available: bool,
}

pub fn is_trusted_download_url(url: &str) -> bool {
    if url.contains("..") {
        return false;
    }
    https_hostname(url).as_deref() == Some(ALLOWED_DOWNLOAD_HOST)
}

/// Parse the hostname from an `https://` URL (case-insensitive). Returns None for non-HTTPS or malformed URLs.
fn https_hostname(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    // Strip optional userinfo (`user:pass@`) — host is the segment after the last `@`.
    let host_port = authority.rsplit('@').next()?;
    let host = host_port.split(':').next()?.trim();
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

fn manifest_url(version: &str) -> String {
    format!("https://dl.ci.computer/v{}/manifest.json", version.trim_start_matches('v'))
}

fn platform_key() -> Option<String> {
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };

    if cfg!(target_os = "macos") {
        return Some(if arch == "aarch64" {
            "darwin-aarch64".to_string()
        } else {
            "darwin-x86_64".to_string()
        });
    }
    if cfg!(target_os = "windows") {
        return Some(if arch == "aarch64" {
            "windows-aarch64".to_string()
        } else {
            "windows-x86_64".to_string()
        });
    }
    if cfg!(target_os = "linux") {
        return Some(if arch == "aarch64" {
            "linux-aarch64".to_string()
        } else {
            "linux-x86_64".to_string()
        });
    }
    None
}

fn linux_package_preference() -> &'static str {
    if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
        let lower = content.to_lowercase();
        if lower.contains("id=debian")
            || lower.contains("id=ubuntu")
            || lower.contains("id=linuxmint")
            || lower.contains("id=pop")
        {
            return "deb";
        }
        if lower.contains("id=fedora")
            || lower.contains("id=rhel")
            || lower.contains("id=centos")
            || lower.contains("id=rocky")
            || lower.contains("id=almalinux")
        {
            return "rpm";
        }
    }
    "appimage"
}

fn artifact_url(platform_data: &serde_json::Value) -> Option<String> {
    let read_url = |key: &str| -> Option<String> {
        platform_data
            .get(key)
            .and_then(|v| v.get("url"))
            .and_then(|u| u.as_str())
            .map(str::to_string)
    };

    if cfg!(target_os = "macos") {
        return read_url("dmg");
    }
    if cfg!(target_os = "windows") {
        return read_url("exe").or_else(|| read_url("msi"));
    }
    if cfg!(target_os = "linux") {
        match linux_package_preference() {
            "deb" => return read_url("deb").or_else(|| read_url("appimage")),
            "rpm" => return read_url("rpm").or_else(|| read_url("appimage")),
            _ => return read_url("appimage").or_else(|| read_url("deb")).or_else(|| read_url("rpm")),
        }
    }
    None
}

pub fn resolve_download_url(manifest: &ManifestJson) -> Option<String> {
    let key = platform_key()?;
    let platform_data = manifest.platforms.get(&key)?;
    let url = artifact_url(platform_data)?;
    if is_trusted_download_url(&url) {
        Some(url)
    } else {
        None
    }
}

fn fetch_latest_version(client: &reqwest::blocking::Client) -> Result<String, String> {
    let response = client
        .get(UPDATE_CHECK_URL)
        .send()
        .map_err(|e| format!("Failed to fetch latest version: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("latest.json returned HTTP {}", response.status()));
    }
    let latest: LatestJson = response
        .json()
        .map_err(|e| format!("Failed to parse latest.json: {}", e))?;
    Ok(latest.version.trim_start_matches('v').to_string())
}

fn fetch_manifest(client: &reqwest::blocking::Client, version: &str) -> Result<ManifestJson, String> {
    let url = manifest_url(version);
    let response = client
        .get(&url)
        .send()
        .map_err(|e| format!("Failed to fetch manifest: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("manifest returned HTTP {}", response.status()));
    }
    response
        .json()
        .map_err(|e| format!("Failed to parse manifest: {}", e))
}

pub fn check_desktop_update(current_version: &str) -> Result<DesktopUpdateInfo, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let latest_version = fetch_latest_version(&client)?;
    let update_available = semver_compare_gt(&latest_version, current_version);

    let download_url = if update_available {
        let manifest = fetch_manifest(&client, &latest_version)?;
        resolve_download_url(&manifest).unwrap_or_default()
    } else {
        String::new()
    };

    Ok(DesktopUpdateInfo {
        current_version: current_version.to_string(),
        latest_version,
        download_url,
        update_available,
    })
}

fn semver_compare_gt(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .filter_map(|part| part.parse::<u64>().ok())
            .collect()
    };
    let l = parse(latest);
    let c = parse(current);
    for i in 0..l.len().max(c.len()) {
        let lv = *l.get(i).unwrap_or(&0);
        let cv = *c.get(i).unwrap_or(&0);
        if lv > cv {
            return true;
        }
        if lv < cv {
            return false;
        }
    }
    false
}

fn download_file(url: &str, dest: &Path) -> Result<(), String> {
    set_progress("download", "Downloading update…");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("Download failed: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("Download returned HTTP {}", response.status()));
    }
    let mut file =
        std::fs::File::create(dest).map_err(|e| format!("Failed to create temp file: {}", e))?;
    let mut buffer = [0u8; 8192];
    loop {
        let read = response
            .read(&mut buffer)
            .map_err(|e| format!("Download read error: {}", e))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|e| format!("Failed to write download: {}", e))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_macos_dmg(dmg_path: &Path) -> Result<(), String> {
    set_progress("install", "Installing update…");
    let attach = Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-plist", dmg_path.to_string_lossy().as_ref()])
        .output()
        .map_err(|e| format!("hdiutil attach failed: {}", e))?;
    if !attach.status.success() {
        return Err(format!(
            "hdiutil attach failed: {}",
            String::from_utf8_lossy(&attach.stderr)
        ));
    }

    let mount_point = find_dmg_mount_point(&String::from_utf8_lossy(&attach.stdout))
        .ok_or_else(|| "Could not determine DMG mount point".to_string())?;

    let app_bundle = find_app_in_dir(Path::new(&mount_point))?;
    let install_target = resolve_macos_install_target(&app_bundle)?;

    if install_target.exists() {
        std::fs::remove_dir_all(&install_target)
            .map_err(|e| format!("Failed to remove old app bundle: {}", e))?;
    }
    if let Some(parent) = install_target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dir: {}", e))?;
    }

    copy_dir_recursive(&app_bundle, &install_target)?;

    let _ = Command::new("hdiutil")
        .args(["detach", &mount_point])
        .output();

    Ok(())
}

#[cfg(target_os = "macos")]
fn find_dmg_mount_point(plist_output: &str) -> Option<String> {
    for line in plist_output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("<string>/Volumes/") {
            return Some(
                trimmed
                    .trim_start_matches("<string>")
                    .trim_end_matches("</string>")
                    .to_string(),
            );
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn find_app_in_dir(dir: &Path) -> Result<PathBuf, String> {
    for entry in std::fs::read_dir(dir).map_err(|e| format!("Failed to read mount: {}", e))? {
        let entry = entry.map_err(|e| format!("read_dir error: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("app") {
            return Ok(path);
        }
    }
    Err("No .app bundle found in DMG".to_string())
}

#[cfg(target_os = "macos")]
fn resolve_macos_install_target(source_app: &Path) -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.as_path();
        while let Some(parent) = cursor.parent() {
            if parent.extension().and_then(|s| s.to_str()) == Some("app") {
                return Ok(parent.to_path_buf());
            }
            cursor = parent;
        }
    }
    Ok(PathBuf::from("/Applications").join(
        source_app
            .file_name()
            .ok_or_else(|| "Invalid app name".to_string())?,
    ))
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| format!("mkdir failed: {}", e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir failed: {}", e))? {
        let entry = entry.map_err(|e| format!("read_dir entry: {}", e))?;
        let file_type = entry.file_type().map_err(|e| format!("file_type: {}", e))?;
        let target = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| format!("copy failed: {}", e))?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_windows_exe(installer: &Path) -> Result<(), String> {
    set_progress("install", "Installing update (may require elevation)…");
    let name = installer
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    let status = if name.ends_with(".msi") {
        Command::new("msiexec")
            .args(["/i", &installer.to_string_lossy(), "/qn", "/norestart"])
            .status()
    } else {
        Command::new(installer).args(["/S"]).status()
    }
    .map_err(|e| format!("Failed to launch installer: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Installer exited with {:?}", status.code()))
    }
}

#[cfg(target_os = "linux")]
fn install_linux_package(package: &Path) -> Result<(), String> {
    set_progress("install", "Installing update (may require elevation)…");
    let ext = package
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut try_commands: Vec<Vec<String>> = Vec::new();
    if ext == "deb" {
        try_commands.push(vec![
            "pkexec".into(),
            "dpkg".into(),
            "-i".into(),
            package.to_string_lossy().into_owned(),
        ]);
        try_commands.push(vec![
            "sudo".into(),
            "dpkg".into(),
            "-i".into(),
            package.to_string_lossy().into_owned(),
        ]);
    } else if ext == "rpm" {
        try_commands.push(vec![
            "pkexec".into(),
            "rpm".into(),
            "-U".into(),
            package.to_string_lossy().into_owned(),
        ]);
        try_commands.push(vec![
            "sudo".into(),
            "rpm".into(),
            "-U".into(),
            package.to_string_lossy().into_owned(),
        ]);
    } else if ext == "appimage" || package.to_string_lossy().ends_with(".AppImage") {
        let target = resolve_linux_appimage_target()?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {}", e))?;
        }
        std::fs::copy(package, &target).map_err(|e| format!("Failed to copy AppImage: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&target)
                .map_err(|e| format!("metadata: {}", e))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&target, perms)
                .map_err(|e| format!("chmod failed: {}", e))?;
        }
        return Ok(());
    }

    for args in try_commands {
        let bin = &args[0];
        let status = Command::new(bin)
            .args(&args[1..])
            .status()
            .map_err(|e| format!("Failed to run {}: {}", bin, e))?;
        if status.success() {
            return Ok(());
        }
    }
    Err("Package installation failed".to_string())
}

#[cfg(target_os = "linux")]
fn resolve_linux_appimage_target() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if exe.to_string_lossy().ends_with(".AppImage") {
            return Ok(exe);
        }
    }
    Ok(dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Applications")
        .join("Companion Hub.AppImage"))
}

fn install_artifact(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    #[cfg(target_os = "macos")]
    {
        if name.ends_with(".dmg") {
            return install_macos_dmg(path);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if name.ends_with(".exe") || name.ends_with(".msi") {
            return install_windows_exe(path);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if name.ends_with(".deb") || name.ends_with(".rpm") || name.ends_with(".appimage") {
            return install_linux_package(path);
        }
    }

    Err(format!("Unsupported installer format: {}", path.display()))
}

fn relaunch_hub(mode: PersistedLaunchMode) -> Result<(), String> {
    set_progress("relaunch", "Relaunching Companion Hub…");
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    let mut cmd = Command::new(&exe);
    if mode == PersistedLaunchMode::Detached {
        cmd.arg("--detached");
    }
    cmd.spawn()
        .map_err(|e| format!("Failed to relaunch: {}", e))?;
    Ok(())
}

pub fn perform_host_update(download_url: &str) -> Result<(), String> {
    if !is_trusted_download_url(download_url) {
        return Err("Untrusted download URL".to_string());
    }

    set_progress("prepare", "Preparing update…");
    let data_dir = hub_manager::get_hub_data_dir();
    let compose_path = data_dir.join(hub_manager::HUB_COMPOSE_FILENAME);
    let env_path = hub_manager::hub_env_path_for(&data_dir);
    let launch_mode = hub_manager::read_launch_mode(&data_dir);

    hub_manager::clear_user_stopped(&data_dir);
    // Ensure the post-install startup pulls images and recreates containers even if
    // compose/env filenames are unchanged (e.g. CI_HUB_IMAGE still uses :latest).
    hub_manager::invalidate_config_hash(&data_dir);

    set_progress("stop", "Stopping Hub stack…");
    hub_manager::stop_hub_for_update(&compose_path, &env_path)?;

    let suffix = download_url
        .rsplit('/')
        .next()
        .unwrap_or("update.bin");
    let temp_dir = std::env::temp_dir().join("companion-hub-update");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("temp dir: {}", e))?;
    let dest = temp_dir.join(suffix);

    download_file(download_url, &dest)?;
    install_artifact(&dest)?;

    set_progress("done", "Update installed — relaunching…");
    relaunch_hub(launch_mode)?;
    std::process::exit(0);
}

pub fn run_update_cli(check_only: bool) -> Result<i32, String> {
    let current = option_env!("CI_HUB_BUILD_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .trim_start_matches('v')
        .to_string();
    let info = check_desktop_update(&current)?;
    if check_only {
        return Ok(if info.update_available { 1 } else { 0 });
    }
    if !info.update_available {
        println!("Already on latest version ({})", current);
        return Ok(0);
    }
    if info.download_url.is_empty() {
        return Err("Update available but no download URL for this platform".to_string());
    }
    println!("Updating from {} to {}…", current, info.latest_version);
    perform_host_update(&info.download_url)?;
    Ok(0)
}

fn handle_update_http_request(mut stream: TcpStream) {
    let mut buffer = [0u8; 4096];
    let read = stream.read(&mut buffer).unwrap_or(0);
    if read == 0 {
        return;
    }
    let request = String::from_utf8_lossy(&buffer[..read]);
    let is_post_update = request.starts_with("POST /update");
    let (status, body) = if is_post_update {
        match check_and_trigger_update_from_listener() {
            Ok(msg) => ("200 OK", msg),
            Err(err) => ("500 Internal Server Error", err),
        }
    } else if request.starts_with("GET /health") {
        ("200 OK", "ok".to_string())
    } else {
        ("404 Not Found", "not found".to_string())
    };

    let response = format!(
        "HTTP/1.1 {}\r\nContent-Length: {}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n{}",
        status,
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn check_and_trigger_update_from_listener() -> Result<String, String> {
    let current = option_env!("CI_HUB_BUILD_VERSION")
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .trim_start_matches('v')
        .to_string();
    let info = check_desktop_update(&current)?;
    if !info.update_available {
        return Ok("already latest".to_string());
    }
    if info.download_url.is_empty() {
        return Err("no download url".to_string());
    }
    std::thread::spawn(move || {
        let _ = perform_host_update(&info.download_url);
    });
    Ok("update started".to_string())
}

pub fn spawn_update_listener() {
    std::thread::spawn(|| {
        let listener = match TcpListener::bind(UPDATE_LISTENER_ADDR) {
            Ok(l) => l,
            Err(_) => return,
        };
        for stream in listener.incoming().flatten() {
            handle_update_http_request(stream);
        }
    });
}

#[cfg(unix)]
pub fn spawn_update_listener_daemon() {
    unsafe {
        let pid = libc::fork();
        if pid == -1 {
            return;
        }
        if pid == 0 {
            libc::setsid();
            spawn_update_listener();
            loop {
                std::thread::sleep(Duration::from_secs(3600));
            }
        }
    }
}

#[cfg(not(unix))]
pub fn spawn_update_listener_daemon() {
    spawn_update_listener();
}

pub fn trigger_host_update_via_listener() -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    let response = client
        .post(format!("http://{}/update", UPDATE_LISTENER_ADDR))
        .send()
        .map_err(|e| format!("Host update listener unavailable: {}", e))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read listener response: {}", e))?;
    if status.is_success() {
        Ok(body)
    } else {
        Err(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_url_accepts_dl_ci_computer() {
        assert!(is_trusted_download_url(
            "https://dl.ci.computer/v0.2.18/windows/x64/setup.exe"
        ));
    }

    #[test]
    fn trusted_url_rejects_other_hosts() {
        assert!(!is_trusted_download_url("https://example.com/file.exe"));
    }

    #[test]
    fn trusted_url_rejects_subdomain_suffix_attack() {
        assert!(!is_trusted_download_url(
            "https://dl.ci.computer.evil.com/file.exe"
        ));
    }

    #[test]
    fn trusted_url_rejects_host_in_query_string() {
        assert!(!is_trusted_download_url(
            "https://evil.com/?dl.ci.computer"
        ));
    }

    #[test]
    fn trusted_url_rejects_non_https() {
        assert!(!is_trusted_download_url("http://dl.ci.computer/file.exe"));
    }

    #[test]
    fn trusted_url_rejects_path_traversal() {
        assert!(!is_trusted_download_url(
            "https://dl.ci.computer/v0.2.18/../evil.exe"
        ));
    }

    #[test]
    fn semver_compare_gt_works() {
        assert!(semver_compare_gt("0.2.19", "0.2.18"));
        assert!(!semver_compare_gt("0.2.18", "0.2.19"));
        assert!(!semver_compare_gt("1.0.0", "1.0.0"));
    }
}
