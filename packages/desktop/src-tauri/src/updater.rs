use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;

use sha2::{Digest, Sha256};

use crate::hub_manager::{self, PersistedLaunchMode};

const UPDATE_CHECK_URL: &str = "https://dl.ci.computer/latest.json";
const ALLOWED_DOWNLOAD_HOST: &str = "dl.ci.computer";
const UPDATE_LISTENER_ADDR: &str = "127.0.0.1:17400";
const UPDATE_LISTENER_TOKEN_FILENAME: &str = "update-listener.token";

#[derive(Debug, Clone, serde::Serialize)]
pub struct UpdateProgress {
    pub phase: String,
    pub message: String,
}

static UPDATE_PROGRESS: OnceLock<Mutex<Option<UpdateProgress>>> = OnceLock::new();
static HOST_UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Ensures only one host update runs at a time (listener retries, double-clicks, CLI + UI).
struct HostUpdateGuard;

impl HostUpdateGuard {
    fn acquire() -> Result<Self, String> {
        if HOST_UPDATE_IN_PROGRESS
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("Host update already in progress".to_string());
        }
        Ok(Self)
    }
}

impl Drop for HostUpdateGuard {
    fn drop(&mut self) {
        HOST_UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

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
    progress_store().lock().ok().and_then(|guard| guard.clone())
}

#[derive(Deserialize)]
struct LatestJson {
    version: String,
}

#[derive(Deserialize)]
struct ManifestJson {
    version: String,
    platforms: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostOs {
    Macos,
    Windows,
    Linux,
}

const ARTIFACT_KEYS: [&str; 6] = ["dmg", "exe", "msi", "deb", "rpm", "appimage"];

#[derive(Debug, Clone)]
struct ResolvedArtifact {
    url: String,
    size: Option<u64>,
    sha256: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub download_url: String,
    pub update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<String>,
}

pub fn is_trusted_download_url(url: &str) -> bool {
    if path_has_parent_traversal(url) {
        return false;
    }
    https_hostname(url).as_deref() == Some(ALLOWED_DOWNLOAD_HOST)
}

fn path_has_parent_traversal(url: &str) -> bool {
    raw_path_segments(url)
        .map(|segments| {
            segments
                .iter()
                .any(|segment| segment_decodes_to_parent_dir(segment))
        })
        .unwrap_or(false)
}

fn strip_ascii_case_prefix<'a>(input: &'a str, prefix: &str) -> Option<&'a str> {
    let (candidate, rest) = input.split_at_checked(prefix.len())?;
    if candidate.eq_ignore_ascii_case(prefix) {
        Some(rest)
    } else {
        None
    }
}

fn raw_path_segments(url: &str) -> Option<Vec<&str>> {
    let rest = strip_ascii_case_prefix(url, "https://")
        .or_else(|| strip_ascii_case_prefix(url, "http://"))?;
    let path_start = rest.find('/')?;
    let path = rest[path_start..].split(['?', '#']).next()?;
    Some(
        path.split('/')
            .filter(|segment| !segment.is_empty())
            .collect(),
    )
}

fn segment_decodes_to_parent_dir(segment: &str) -> bool {
    match decode_path_segment(segment) {
        Ok(decoded) => decoded.split('/').any(|part| part == ".."),
        Err(()) => true,
    }
}

fn decode_path_segment(segment: &str) -> Result<String, ()> {
    let mut decoded = segment.to_string();
    for _ in 0..3 {
        let next = percent_decode_once(&decoded)?;
        if next == decoded {
            break;
        }
        decoded = next;
    }
    Ok(decoded)
}

fn percent_decode_once(input: &str) -> Result<String, ()> {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return Err(());
                }
                let hi = hex_digit(bytes[i + 1])?;
                let lo = hex_digit(bytes[i + 2])?;
                out.push(char::from((hi << 4) | lo));
                i += 3;
            }
            b'+' => {
                out.push(' ');
                i += 1;
            }
            b => {
                out.push(char::from(b));
                i += 1;
            }
        }
    }
    Ok(out)
}

fn hex_digit(byte: u8) -> Result<u8, ()> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(()),
    }
}

/// Parse the hostname from an `https://` URL with an ASCII case-insensitive scheme match.
/// Returns None for non-HTTPS or malformed URLs.
fn https_hostname(url: &str) -> Option<String> {
    let rest = strip_ascii_case_prefix(url, "https://")?;
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
    format!(
        "https://dl.ci.computer/v{}/manifest.json",
        version.trim_start_matches('v')
    )
}

fn host_os() -> Option<HostOs> {
    if cfg!(target_os = "macos") {
        Some(HostOs::Macos)
    } else if cfg!(target_os = "windows") {
        Some(HostOs::Windows)
    } else if cfg!(target_os = "linux") {
        Some(HostOs::Linux)
    } else {
        None
    }
}

/// Manifest platform key matching desktop-release.yml (`darwin-aarch64`, `windows-x86_64`, etc.).
fn platform_manifest_key(os: HostOs, arch: &str) -> String {
    let arch_suffix = if arch == "aarch64" {
        "aarch64"
    } else {
        "x86_64"
    };
    match os {
        HostOs::Macos => format!("darwin-{arch_suffix}"),
        HostOs::Windows => format!("windows-{arch_suffix}"),
        HostOs::Linux => format!("linux-{arch_suffix}"),
    }
}

fn platform_key() -> Option<String> {
    let os = host_os()?;
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    };
    Some(platform_manifest_key(os, arch))
}

fn linux_package_preference_from_os_release(content: &str) -> &'static str {
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
    "appimage"
}

fn linux_package_preference() -> &'static str {
    linux_package_preference_from_os_release(
        &std::fs::read_to_string("/etc/os-release").unwrap_or_default(),
    )
}

fn parse_artifact(value: &serde_json::Value) -> Option<ResolvedArtifact> {
    let url = value.get("url")?.as_str()?.to_string();
    if !is_trusted_download_url(&url) {
        return None;
    }
    let size = value.get("size").and_then(|v| v.as_u64());
    let sha256 = value
        .get("sha256")
        .and_then(|v| v.as_str())
        .map(normalize_sha256);
    Some(ResolvedArtifact { url, size, sha256 })
}

fn artifact_for_platform_data(
    platform_data: &serde_json::Value,
    os: HostOs,
    package_preference: &str,
) -> Option<ResolvedArtifact> {
    let read =
        |key: &str| -> Option<ResolvedArtifact> { platform_data.get(key).and_then(parse_artifact) };

    match os {
        HostOs::Macos => read("dmg"),
        HostOs::Windows => read("exe").or_else(|| read("msi")),
        HostOs::Linux => match package_preference {
            "deb" => read("deb").or_else(|| read("appimage")),
            "rpm" => read("rpm").or_else(|| read("appimage")),
            _ => read("appimage")
                .or_else(|| read("deb"))
                .or_else(|| read("rpm")),
        },
    }
}

fn artifact_for_platform(platform_data: &serde_json::Value) -> Option<ResolvedArtifact> {
    artifact_for_platform_data(platform_data, host_os()?, linux_package_preference())
}

fn resolve_download_artifact(manifest: &ManifestJson) -> Option<ResolvedArtifact> {
    let key = platform_key()?;
    let platform_data = manifest.platforms.get(&key)?;
    artifact_for_platform(platform_data)
}

fn lookup_artifact_in_manifest(
    manifest: &ManifestJson,
    download_url: &str,
) -> Option<ResolvedArtifact> {
    for platform_data in manifest.platforms.values() {
        for key in ARTIFACT_KEYS {
            if let Some(artifact) = platform_data.get(key).and_then(parse_artifact) {
                if artifact.url == download_url {
                    return Some(artifact);
                }
            }
        }
    }
    None
}

pub(crate) fn artifact_expectations_for_url(
    client: &reqwest::blocking::Client,
    latest_version: &str,
    info: &DesktopUpdateInfo,
    download_url: &str,
) -> Result<(Option<u64>, Option<String>), String> {
    if download_url == info.download_url {
        return Ok((info.expected_size, info.expected_sha256.clone()));
    }
    let manifest = fetch_manifest(client, latest_version)?;
    let artifact = lookup_artifact_in_manifest(&manifest, download_url)
        .ok_or_else(|| "Download URL not found in release manifest for this version".to_string())?;
    Ok((artifact.size, artifact.sha256))
}

fn normalize_sha256(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("sha256:")
        .to_ascii_lowercase()
}

fn sha256_hex_file(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| format!("Failed to open download for hashing: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read download for hashing: {}", e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// Verify a downloaded installer against manifest expectations before execution.
fn verify_downloaded_artifact(
    path: &Path,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let actual_size = std::fs::metadata(path)
        .map_err(|e| format!("Failed to stat download: {}", e))?
        .len();

    if let Some(expected) = expected_size {
        if actual_size != expected {
            return Err(format!(
                "Download size mismatch (expected {expected} bytes, got {actual_size})"
            ));
        }
    }

    if let Some(expected_sha) = expected_sha256 {
        let expected = normalize_sha256(expected_sha);
        if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("Manifest SHA-256 checksum is invalid".to_string());
        }
        let actual = sha256_hex_file(path)?;
        if actual != expected {
            return Err("Download SHA-256 checksum mismatch — refusing to install".to_string());
        }
        return Ok(());
    }

    if expected_size.is_some() {
        // Legacy manifests (pre-sha256) — hostname pinning + size check only.
        return Ok(());
    }

    Err(
        "Manifest missing SHA-256 checksum and size — refusing to install untrusted artifact"
            .to_string(),
    )
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

fn fetch_manifest(
    client: &reqwest::blocking::Client,
    version: &str,
) -> Result<ManifestJson, String> {
    let url = manifest_url(version);
    if !is_trusted_download_url(&url) {
        return Err("Untrusted manifest URL".to_string());
    }
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
        .and_then(|manifest: ManifestJson| {
            let expected = version.trim_start_matches('v');
            let actual = manifest.version.trim_start_matches('v');
            if actual != expected {
                return Err(format!(
                    "Manifest version mismatch (expected {expected}, got {actual})"
                ));
            }
            Ok(manifest)
        })
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
        resolve_download_artifact(&manifest)
    } else {
        None
    };

    Ok(DesktopUpdateInfo {
        current_version: current_version.to_string(),
        latest_version,
        download_url: download_url
            .as_ref()
            .map(|a| a.url.clone())
            .unwrap_or_default(),
        update_available,
        expected_size: download_url.as_ref().and_then(|a| a.size),
        expected_sha256: download_url.and_then(|a| a.sha256),
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
        .args([
            "attach",
            "-nobrowse",
            "-plist",
            dmg_path.to_string_lossy().as_ref(),
        ])
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
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dir: {}", e))?;
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

#[cfg(target_os = "macos")]
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
            std::fs::set_permissions(&target, perms).map_err(|e| format!("chmod failed: {}", e))?;
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

pub fn perform_host_update(
    download_url: &str,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let _guard = HostUpdateGuard::acquire()?;
    perform_host_update_inner(download_url, expected_size, expected_sha256)
}

fn perform_host_update_inner(
    download_url: &str,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
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

    let suffix = download_url.rsplit('/').next().unwrap_or("update.bin");
    let temp_dir = std::env::temp_dir().join("companion-hub-update");
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("temp dir: {}", e))?;
    let dest = temp_dir.join(suffix);

    download_file(download_url, &dest)?;
    set_progress("verify", "Verifying download integrity…");
    verify_downloaded_artifact(&dest, expected_size, expected_sha256)?;
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
        let platform = platform_key().unwrap_or_else(|| "unknown".to_string());
        return Err(format!(
            "Update available but no download URL for this platform ({platform})"
        ));
    }
    println!("Updating from {} to {}…", current, info.latest_version);
    perform_host_update(
        &info.download_url,
        info.expected_size,
        info.expected_sha256.as_deref(),
    )?;
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
        match authorize_update_listener_request(&request) {
            Err(err) => ("401 Unauthorized", err),
            Ok(()) => match check_and_trigger_update_from_listener() {
                Ok(msg) => ("200 OK", msg),
                Err(err) => ("500 Internal Server Error", err),
            },
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

fn update_listener_token_path() -> PathBuf {
    hub_manager::get_hub_data_dir().join(UPDATE_LISTENER_TOKEN_FILENAME)
}

fn read_update_listener_token() -> Result<String, String> {
    std::fs::read_to_string(update_listener_token_path())
        .map(|token| token.trim().to_string())
        .map_err(|e| format!("Failed to read update listener token: {}", e))
}

fn ensure_update_listener_token() -> Result<String, String> {
    let path = update_listener_token_path();
    if path.exists() {
        return read_update_listener_token();
    }

    use rand::Rng;
    let token: String = rand::thread_rng()
        .sample_iter(rand::distributions::Alphanumeric)
        .take(48)
        .map(char::from)
        .collect();

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    std::fs::write(&path, format!("{token}\n"))
        .map_err(|e| format!("Failed to write update listener token: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to stat token file: {}", e))?
            .permissions();
        perms.set_mode(0o600);
        std::fs::set_permissions(&path, perms)
            .map_err(|e| format!("Failed to chmod token file: {}", e))?;
    }
    Ok(token)
}

fn extract_update_listener_token_from_request(request: &str) -> Option<String> {
    for line in request.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some(value) = trimmed
            .strip_prefix("Authorization:")
            .or_else(|| trimmed.strip_prefix("authorization:"))
        {
            let value = value.trim();
            if let Some(token) = value.strip_prefix("Bearer ") {
                return Some(token.trim().to_string());
            }
            if let Some(token) = value.strip_prefix("bearer ") {
                return Some(token.trim().to_string());
            }
        }
        if let Some(token) = trimmed
            .strip_prefix("X-Companion-Hub-Update-Token:")
            .or_else(|| trimmed.strip_prefix("x-companion-hub-update-token:"))
        {
            return Some(token.trim().to_string());
        }
    }
    None
}

fn tokens_match(provided: &str, expected: &str) -> bool {
    provided.as_bytes().len() == expected.as_bytes().len()
        && provided
            .as_bytes()
            .iter()
            .zip(expected.as_bytes())
            .fold(0u8, |acc, (left, right)| acc | (left ^ right))
            == 0
}

fn authorize_update_listener_request(request: &str) -> Result<(), String> {
    let expected = read_update_listener_token()?;
    let provided = extract_update_listener_token_from_request(request)
        .ok_or_else(|| "missing update listener token".to_string())?;
    if tokens_match(&provided, &expected) {
        Ok(())
    } else {
        Err("invalid update listener token".to_string())
    }
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
    let download_url = info.download_url.clone();
    let expected_size = info.expected_size;
    let expected_sha256 = info.expected_sha256.clone();
    let guard = HostUpdateGuard::acquire()?;
    std::thread::spawn(move || {
        let _guard = guard;
        if let Err(err) =
            perform_host_update_inner(&download_url, expected_size, expected_sha256.as_deref())
        {
            set_progress("error", &err);
        }
    });
    Ok("update started".to_string())
}

pub fn run_update_listener() {
    if ensure_update_listener_token().is_err() {
        return;
    }
    let listener = match TcpListener::bind(UPDATE_LISTENER_ADDR) {
        Ok(l) => l,
        Err(_) => return,
    };
    for stream in listener.incoming().flatten() {
        handle_update_http_request(stream);
    }
}

pub fn spawn_update_listener_daemon() {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(_) => return,
    };

    let mut cmd = Command::new(exe);
    cmd.arg("--update-listener")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const DETACHED_PROCESS: u32 = 0x00000008;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }

    let _ = cmd.spawn();
}

pub fn trigger_host_update_via_listener() -> Result<String, String> {
    let token = read_update_listener_token()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    let response = client
        .post(format!("http://{}/update", UPDATE_LISTENER_ADDR))
        .header("Authorization", format!("Bearer {token}"))
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
    fn trusted_url_accepts_uppercase_https_scheme() {
        assert!(is_trusted_download_url(
            "HTTPS://dl.ci.computer/v0.2.18/windows/x64/setup.exe"
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
        assert!(!is_trusted_download_url("https://evil.com/?dl.ci.computer"));
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
        assert!(!is_trusted_download_url(
            "HTTPS://dl.ci.computer/v0.2.18/../evil.exe"
        ));
    }

    #[test]
    fn trusted_url_rejects_percent_encoded_path_traversal() {
        assert!(!is_trusted_download_url(
            "https://dl.ci.computer/v0.2.18/%2e%2e/evil.exe"
        ));
        assert!(!is_trusted_download_url(
            "https://dl.ci.computer/v0.2.18/%2E%2E/evil.exe"
        ));
        assert!(!is_trusted_download_url(
            "https://dl.ci.computer/v0.2.18/%252e%252e/evil.exe"
        ));
    }

    #[test]
    fn update_listener_extracts_bearer_token() {
        let request = "POST /update HTTP/1.1\r\nAuthorization: Bearer secret-token\r\n\r\n";
        assert_eq!(
            extract_update_listener_token_from_request(request).as_deref(),
            Some("secret-token")
        );
    }

    #[test]
    fn update_listener_authorizes_valid_token() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let token_path = tempdir.path().join(UPDATE_LISTENER_TOKEN_FILENAME);
        std::fs::write(&token_path, "expected-token\n").expect("write token");

        let request = "POST /update HTTP/1.1\r\nAuthorization: Bearer expected-token\r\n\r\n";
        assert!(authorize_update_listener_request_with_path(&request, &token_path).is_ok());
    }

    #[test]
    fn update_listener_rejects_missing_token() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let token_path = tempdir.path().join(UPDATE_LISTENER_TOKEN_FILENAME);
        std::fs::write(&token_path, "expected-token\n").expect("write token");

        let request = "POST /update HTTP/1.1\r\n\r\n";
        assert!(authorize_update_listener_request_with_path(&request, &token_path).is_err());
    }

    #[test]
    fn update_listener_rejects_invalid_token() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let token_path = tempdir.path().join(UPDATE_LISTENER_TOKEN_FILENAME);
        std::fs::write(&token_path, "expected-token\n").expect("write token");

        let request = "POST /update HTTP/1.1\r\nAuthorization: Bearer wrong-token\r\n\r\n";
        assert!(authorize_update_listener_request_with_path(&request, &token_path).is_err());
    }

    fn authorize_update_listener_request_with_path(
        request: &str,
        token_path: &Path,
    ) -> Result<(), String> {
        let expected = std::fs::read_to_string(token_path)
            .map(|token| token.trim().to_string())
            .map_err(|e| format!("Failed to read update listener token: {}", e))?;
        let provided = extract_update_listener_token_from_request(request)
            .ok_or_else(|| "missing update listener token".to_string())?;
        if tokens_match(&provided, &expected) {
            Ok(())
        } else {
            Err("invalid update listener token".to_string())
        }
    }

    #[test]
    fn host_update_guard_rejects_concurrent_acquire() {
        let first = HostUpdateGuard::acquire().expect("first acquire");
        assert!(HostUpdateGuard::acquire().is_err());
        drop(first);
        assert!(HostUpdateGuard::acquire().is_ok());
    }

    #[test]
    fn verify_download_accepts_matching_sha256() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let path = tempdir.path().join("installer.bin");
        std::fs::write(&path, b"hello-update").expect("write");
        let digest = sha256_hex_file(&path).expect("hash");
        verify_downloaded_artifact(&path, Some(12), Some(&digest)).expect("verify");
    }

    #[test]
    fn verify_download_rejects_sha256_mismatch() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let path = tempdir.path().join("installer.bin");
        std::fs::write(&path, b"hello-update").expect("write");
        let err = verify_downloaded_artifact(
            &path,
            Some(12),
            Some("0000000000000000000000000000000000000000000000000000000000000000"),
        )
        .expect_err("mismatch");
        assert!(err.contains("SHA-256"));
    }

    #[test]
    fn verify_download_allows_legacy_size_only_manifests() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let path = tempdir.path().join("installer.bin");
        std::fs::write(&path, b"legacy").expect("write");
        verify_downloaded_artifact(&path, Some(6), None).expect("legacy verify");
    }

    #[test]
    fn semver_compare_gt_works() {
        assert!(semver_compare_gt("0.2.19", "0.2.18"));
        assert!(!semver_compare_gt("0.2.18", "0.2.19"));
        assert!(!semver_compare_gt("1.0.0", "1.0.0"));
    }

    #[test]
    fn platform_manifest_keys_match_release_matrix() {
        assert_eq!(
            platform_manifest_key(HostOs::Macos, "aarch64"),
            "darwin-aarch64"
        );
        assert_eq!(
            platform_manifest_key(HostOs::Macos, "x86_64"),
            "darwin-x86_64"
        );
        assert_eq!(
            platform_manifest_key(HostOs::Windows, "aarch64"),
            "windows-aarch64"
        );
        assert_eq!(
            platform_manifest_key(HostOs::Windows, "x86_64"),
            "windows-x86_64"
        );
        assert_eq!(
            platform_manifest_key(HostOs::Linux, "aarch64"),
            "linux-aarch64"
        );
        assert_eq!(
            platform_manifest_key(HostOs::Linux, "x86_64"),
            "linux-x86_64"
        );
    }

    #[test]
    fn linux_package_preference_detects_distro_families() {
        assert_eq!(
            linux_package_preference_from_os_release("ID=ubuntu\n"),
            "deb"
        );
        assert_eq!(
            linux_package_preference_from_os_release("ID=fedora\n"),
            "rpm"
        );
        assert_eq!(
            linux_package_preference_from_os_release("ID=arch\n"),
            "appimage"
        );
    }

    fn sample_artifact(url: &str) -> serde_json::Value {
        serde_json::json!({
            "url": url,
            "size": 123,
            "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        })
    }

    #[test]
    fn artifact_for_platform_selects_expected_installers() {
        let mac = serde_json::json!({ "dmg": sample_artifact("https://dl.ci.computer/v1/macos/arm/hub.dmg") });
        assert_eq!(
            artifact_for_platform_data(&mac, HostOs::Macos, "appimage")
                .expect("dmg")
                .url,
            "https://dl.ci.computer/v1/macos/arm/hub.dmg"
        );

        let win = serde_json::json!({
            "exe": sample_artifact("https://dl.ci.computer/v1/windows/x64/setup.exe"),
            "msi": sample_artifact("https://dl.ci.computer/v1/windows/x64/setup.msi"),
        });
        assert_eq!(
            artifact_for_platform_data(&win, HostOs::Windows, "appimage")
                .expect("exe")
                .url,
            "https://dl.ci.computer/v1/windows/x64/setup.exe"
        );

        let linux = serde_json::json!({
            "deb": sample_artifact("https://dl.ci.computer/v1/linux/deb/x64/hub.deb"),
            "rpm": sample_artifact("https://dl.ci.computer/v1/linux/rpm/x64/hub.rpm"),
            "appimage": sample_artifact("https://dl.ci.computer/v1/linux/appimage/x64/hub.AppImage"),
        });
        assert_eq!(
            artifact_for_platform_data(&linux, HostOs::Linux, "deb")
                .expect("deb")
                .url,
            "https://dl.ci.computer/v1/linux/deb/x64/hub.deb"
        );
        assert_eq!(
            artifact_for_platform_data(&linux, HostOs::Linux, "rpm")
                .expect("rpm")
                .url,
            "https://dl.ci.computer/v1/linux/rpm/x64/hub.rpm"
        );
        assert_eq!(
            artifact_for_platform_data(&linux, HostOs::Linux, "appimage")
                .expect("appimage")
                .url,
            "https://dl.ci.computer/v1/linux/appimage/x64/hub.AppImage"
        );
    }

    #[test]
    fn resolve_download_artifact_uses_current_platform_key() {
        let Some(key) = platform_key() else {
            return;
        };
        let mut platforms = std::collections::HashMap::new();
        platforms.insert(
            key.clone(),
            serde_json::json!({
                "dmg": sample_artifact("https://dl.ci.computer/v1/current/hub.dmg"),
                "exe": sample_artifact("https://dl.ci.computer/v1/current/setup.exe"),
                "deb": sample_artifact("https://dl.ci.computer/v1/current/hub.deb"),
                "appimage": sample_artifact("https://dl.ci.computer/v1/current/hub.AppImage"),
            }),
        );
        let manifest = ManifestJson {
            version: "1.0.0".to_string(),
            platforms,
        };
        let artifact = resolve_download_artifact(&manifest).expect("artifact for current platform");
        assert!(artifact.url.starts_with("https://dl.ci.computer/"));
    }
}
