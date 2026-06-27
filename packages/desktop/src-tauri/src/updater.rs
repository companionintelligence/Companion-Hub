use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Deserialize;

use sha2::{Digest, Sha256};

use crate::hub_env::{default_update_cdn_base, default_update_cdn_host};
use crate::hub_manager::{self, PersistedLaunchMode};

const UPDATE_LISTENER_ADDR: &str = "127.0.0.1:17400";
const UPDATE_LISTENER_TOKEN_FILENAME: &str = "update-listener.token";
#[cfg(debug_assertions)]
const UPDATE_BASE_URL_ENV: &str = "CI_HUB_UPDATE_BASE_URL";

/// Flag appended when the updater relaunches the app after an install. When a
/// freshly-updated instance starts while the old instance is still running, the
/// single-instance plugin forwards its args to the old instance, which uses this
/// flag as the signal to restart itself onto the new binary.
pub const RELAUNCH_AFTER_UPDATE_FLAG: &str = "--relaunch-after-update";
const DETACHED_FLAG: &str = "--detached";

/// Where update metadata and artifacts come from.
///
/// Release builds use the CDN baked in at compile time via `CI_HUB_ENVIRONMENT`
/// (`https://dl.ci.computer` for production, `https://dl-dev.ci.computer` for dev).
/// Debug builds may override with `CI_HUB_UPDATE_BASE_URL` (e.g. `http://127.0.0.1:8765`).
#[derive(Debug, Clone)]
pub(crate) struct UpdateSource {
    base: String,
    host: String,
    allow_http: bool,
}

impl UpdateSource {
    /// Compile-time default CDN for this binary (see `hub_env::default_update_cdn_*`).
    fn default_cdn() -> Self {
        Self {
            base: default_update_cdn_base().to_string(),
            host: default_update_cdn_host().to_string(),
            allow_http: false,
        }
    }

    pub(crate) fn resolve() -> Self {
        #[cfg(debug_assertions)]
        if let Ok(base) = std::env::var(UPDATE_BASE_URL_ENV) {
            if let Some(source) = Self::from_base(&base) {
                return source;
            }
        }
        Self::default_cdn()
    }

    #[cfg(any(debug_assertions, test))]
    /// Parse an override base origin like `http://127.0.0.1:8765`. Plain http is
    /// only reachable through the debug-gated env override above.
    fn from_base(base: &str) -> Option<Self> {
        let trimmed = base.trim().trim_end_matches('/');
        let allow_http = strip_ascii_case_prefix(trimmed, "http://").is_some();
        if !allow_http && strip_ascii_case_prefix(trimmed, "https://").is_none() {
            return None;
        }
        let host = any_scheme_hostname(trimmed)?;
        Some(Self {
            base: trimmed.to_string(),
            host,
            allow_http,
        })
    }

    fn latest_url(&self) -> String {
        format!("{}/latest.json", self.base)
    }

    fn manifest_url(&self, version: &str) -> String {
        format!(
            "{}/v{}/manifest.json",
            self.base,
            version.trim_start_matches('v')
        )
    }

    fn is_trusted(&self, url: &str) -> bool {
        if path_has_parent_traversal(url) {
            return false;
        }
        if self.allow_http {
            // Debug/QA override: exact origin prefix match.
            let lower_url = url.to_ascii_lowercase();
            let lower_base = self.base.to_ascii_lowercase();
            return lower_url
                .strip_prefix(&lower_base)
                .map(|rest| rest.is_empty() || rest.starts_with('/'))
                .unwrap_or(false);
        }
        https_hostname(url).as_deref() == Some(self.host.as_str())
    }

    /// HTTP client that only follows redirects staying on the trusted host, so a
    /// redirect cannot silently move the download off the configured CDN origin.
    fn http_client(&self, timeout: Duration) -> Result<reqwest::blocking::Client, String> {
        let host = self.host.clone();
        reqwest::blocking::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                let same_host = attempt
                    .url()
                    .host_str()
                    .map(|h| h.eq_ignore_ascii_case(&host))
                    .unwrap_or(false);
                if same_host && attempt.previous().len() <= 5 {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))
    }
}

#[cfg(any(debug_assertions, test))]
fn any_scheme_hostname(url: &str) -> Option<String> {
    let rest = strip_ascii_case_prefix(url, "https://")
        .or_else(|| strip_ascii_case_prefix(url, "http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = host_port.split(':').next()?.trim();
    if host.is_empty() {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

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
    UpdateSource::resolve().is_trusted(url)
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

fn parse_artifact(value: &serde_json::Value, source: &UpdateSource) -> Option<ResolvedArtifact> {
    let url = value.get("url")?.as_str()?.to_string();
    if !source.is_trusted(&url) {
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
    source: &UpdateSource,
) -> Option<ResolvedArtifact> {
    let read = |key: &str| -> Option<ResolvedArtifact> {
        platform_data
            .get(key)
            .and_then(|v| parse_artifact(v, source))
    };

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

fn artifact_for_platform(
    platform_data: &serde_json::Value,
    source: &UpdateSource,
) -> Option<ResolvedArtifact> {
    artifact_for_platform_data(
        platform_data,
        host_os()?,
        linux_package_preference(),
        source,
    )
}

fn resolve_download_artifact(
    manifest: &ManifestJson,
    source: &UpdateSource,
) -> Option<ResolvedArtifact> {
    let key = platform_key()?;
    let platform_data = manifest.platforms.get(&key)?;
    artifact_for_platform(platform_data, source)
}

fn lookup_artifact_in_manifest(
    manifest: &ManifestJson,
    download_url: &str,
    source: &UpdateSource,
) -> Option<ResolvedArtifact> {
    for platform_data in manifest.platforms.values() {
        for key in ARTIFACT_KEYS {
            if let Some(artifact) = platform_data
                .get(key)
                .and_then(|v| parse_artifact(v, source))
            {
                if artifact.url == download_url {
                    return Some(artifact);
                }
            }
        }
    }
    None
}

pub(crate) fn artifact_expectations_for_url(
    latest_version: &str,
    info: &DesktopUpdateInfo,
    download_url: &str,
) -> Result<(Option<u64>, Option<String>), String> {
    if download_url == info.download_url {
        return Ok((info.expected_size, info.expected_sha256.clone()));
    }
    let source = UpdateSource::resolve();
    let client = source.http_client(Duration::from_secs(30))?;
    let manifest = fetch_manifest(&client, latest_version, &source)?;
    let artifact = lookup_artifact_in_manifest(&manifest, download_url, &source)
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

fn fetch_latest_version(
    client: &reqwest::blocking::Client,
    source: &UpdateSource,
) -> Result<String, String> {
    let response = client
        .get(source.latest_url())
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
    source: &UpdateSource,
) -> Result<ManifestJson, String> {
    let url = source.manifest_url(version);
    if !source.is_trusted(&url) {
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
    check_desktop_update_with_source(current_version, &UpdateSource::resolve())
}

fn check_desktop_update_with_source(
    current_version: &str,
    source: &UpdateSource,
) -> Result<DesktopUpdateInfo, String> {
    let client = source.http_client(Duration::from_secs(30))?;

    let latest_version = fetch_latest_version(&client, source)?;
    let update_available = semver_compare_gt(&latest_version, current_version);

    let download_url = if update_available {
        let manifest = fetch_manifest(&client, &latest_version, source)?;
        resolve_download_artifact(&manifest, source)
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
    // Numeric-prefix parse so a prerelease segment ("16-rc1") still contributes
    // its numeric part instead of silently dropping the whole segment.
    let parse = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|part| {
                let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
                digits.parse::<u64>().unwrap_or(0)
            })
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

fn download_file(url: &str, dest: &Path, source: &UpdateSource) -> Result<(), String> {
    set_progress("download", "Downloading update…");
    let client = source.http_client(Duration::from_secs(600))?;
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

/// What `install_artifact` left for the caller to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallOutcome {
    /// Artifact installed in place — the caller must relaunch the app.
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    Completed,
    /// A detached helper process finishes the install and relaunches after the
    /// current process exits (Windows: installers cannot replace running binaries).
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    DetachedInstallerWillRelaunch,
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

    copy_app_bundle(&app_bundle, &install_target)?;

    let _ = Command::new("hdiutil")
        .args(["detach", &mount_point])
        .output();

    Ok(())
}

#[cfg(target_os = "macos")]
fn copy_app_bundle(src: &Path, dest: &Path) -> Result<(), String> {
    // ditto preserves symlinks, permissions, and extended attributes — a manual
    // recursive copy can silently break the code signature of a notarized bundle.
    match Command::new("/usr/bin/ditto").arg(src).arg(dest).status() {
        Ok(status) if status.success() => Ok(()),
        _ => copy_dir_recursive(src, dest),
    }
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

/// Batch script that waits for the app to exit, runs the installer silently,
/// relaunches the app, and cleans up after itself. Running the installer
/// synchronously from the app itself does not work: a Windows installer cannot
/// replace a running binary, so Restart Manager closes the very process driving
/// the update and the relaunch step is never reached.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_update_script(installer: &Path, app_exe: &Path, relaunch_args: &[String]) -> String {
    let installer_str = installer.display().to_string();
    let exe_str = app_exe.display().to_string();
    let install_line = if installer_str.to_ascii_lowercase().ends_with(".msi") {
        format!("msiexec /i \"{installer_str}\" /qn /norestart")
    } else {
        format!("\"{installer_str}\" /S")
    };
    let args = relaunch_args
        .iter()
        .map(|a| format!(" {a}"))
        .collect::<String>();
    // `ping` as sleep: `timeout` requires an interactive console and fails in a
    // detached process. The final line is the canonical batch self-delete.
    format!(
        "@echo off\r\n\
         ping -n 3 127.0.0.1 >nul\r\n\
         {install_line}\r\n\
         start \"\" \"{exe_str}\"{args}\r\n\
         del \"{installer_str}\" >nul 2>&1\r\n\
         (goto) 2>nul & del \"%~f0\"\r\n"
    )
}

#[cfg(target_os = "windows")]
fn install_windows_exe(
    installer: &Path,
    launch_mode: PersistedLaunchMode,
) -> Result<InstallOutcome, String> {
    set_progress("install", "Handing off to installer — app will restart…");
    let app_exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    let script = windows_update_script(installer, &app_exe, &relaunch_args(launch_mode));
    let script_path = installer.with_file_name("companion-hub-update.cmd");
    std::fs::write(&script_path, script)
        .map_err(|e| format!("Failed to write update script: {}", e))?;
    spawn_detached_cmd(&script_path)?;
    Ok(InstallOutcome::DetachedInstallerWillRelaunch)
}

#[cfg(target_os = "windows")]
fn spawn_detached_cmd(script: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    Command::new("cmd")
        .arg("/C")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Failed to spawn update helper: {}", e))?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn install_linux_package(package: &Path) -> Result<InstallOutcome, String> {
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
        // Unlink first: writing into an ELF that is currently being executed
        // (the AppImage runtime keeps running) fails with ETXTBSY.
        if target.exists() {
            std::fs::remove_file(&target)
                .map_err(|e| format!("Failed to replace old AppImage: {}", e))?;
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
        return Ok(InstallOutcome::Completed);
    }

    for args in try_commands {
        let bin = &args[0];
        let status = Command::new(bin)
            .args(&args[1..])
            .status()
            .map_err(|e| format!("Failed to run {}: {}", bin, e))?;
        if status.success() {
            return Ok(InstallOutcome::Completed);
        }
    }
    Err("Package installation failed".to_string())
}

/// Under AppImage, `current_exe()` is the FUSE-mounted inner binary, never the
/// `.AppImage` file itself — the runtime exposes the real path via `$APPIMAGE`.
fn appimage_path_from_env() -> Option<PathBuf> {
    let value = std::env::var_os("APPIMAGE")?;
    if value.is_empty() {
        return None;
    }
    Some(PathBuf::from(value))
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn linux_appimage_target_from(
    appimage_env: Option<PathBuf>,
    exe: Option<PathBuf>,
    home: Option<PathBuf>,
) -> PathBuf {
    if let Some(appimage) = appimage_env {
        return appimage;
    }
    if let Some(exe) = exe {
        if exe.to_string_lossy().ends_with(".AppImage") {
            return exe;
        }
    }
    home.unwrap_or_else(|| PathBuf::from("."))
        .join("Applications")
        .join("Companion Hub.AppImage")
}

#[cfg(target_os = "linux")]
fn resolve_linux_appimage_target() -> Result<PathBuf, String> {
    Ok(linux_appimage_target_from(
        appimage_path_from_env(),
        std::env::current_exe().ok(),
        dirs::home_dir(),
    ))
}

fn install_artifact(
    path: &Path,
    launch_mode: PersistedLaunchMode,
) -> Result<InstallOutcome, String> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    #[cfg(not(target_os = "windows"))]
    let _ = launch_mode;

    #[cfg(target_os = "macos")]
    {
        if name.ends_with(".dmg") {
            install_macos_dmg(path)?;
            return Ok(InstallOutcome::Completed);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if name.ends_with(".exe") || name.ends_with(".msi") {
            return install_windows_exe(path, launch_mode);
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

fn relaunch_args(mode: PersistedLaunchMode) -> Vec<String> {
    let mut args = vec![RELAUNCH_AFTER_UPDATE_FLAG.to_string()];
    if mode == PersistedLaunchMode::Detached {
        args.push(DETACHED_FLAG.to_string());
    }
    args
}

/// Binary to respawn after an update: the `.AppImage` file when running from one
/// (the mounted inner path vanishes once this process exits), `current_exe` otherwise.
fn respawn_target() -> Result<PathBuf, String> {
    if let Some(appimage) = appimage_path_from_env() {
        return Ok(appimage);
    }
    std::env::current_exe().map_err(|e| format!("current_exe: {}", e))
}

#[cfg(unix)]
fn spawn_detached_respawn(exe: &Path, args: &[String], delay_secs: u64) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    // Delay through a detached shell so the new instance starts only after this
    // process has exited — otherwise the single-instance plugin hands the launch
    // back to the dying process and the relaunch is lost.
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(format!("sleep {delay_secs}; exec \"$0\" \"$@\""))
        .arg(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn()
        .map_err(|e| format!("Failed to relaunch: {}", e))?;
    Ok(())
}

#[cfg(windows)]
fn spawn_detached_respawn(exe: &Path, args: &[String], delay_secs: u64) -> Result<(), String> {
    use std::io::Write as _;
    let arg_str = args.iter().map(|a| format!(" {a}")).collect::<String>();
    let script = format!(
        "@echo off\r\n\
         ping -n {} 127.0.0.1 >nul\r\n\
         start \"\" \"{}\"{}\r\n\
         (goto) 2>nul & del \"%~f0\"\r\n",
        delay_secs + 1,
        exe.display(),
        arg_str
    );
    let mut file = tempfile::Builder::new()
        .prefix("companion-hub-respawn-")
        .suffix(".cmd")
        .tempfile()
        .map_err(|e| format!("Failed to create respawn script: {}", e))?;
    file.write_all(script.as_bytes())
        .map_err(|e| format!("Failed to write respawn script: {}", e))?;
    let (_, path) = file
        .keep()
        .map_err(|e| format!("Failed to persist respawn script: {}", e))?;
    spawn_detached_cmd(&path)
}

fn relaunch_hub(mode: PersistedLaunchMode) -> Result<(), String> {
    set_progress("relaunch", "Relaunching Companion Hub…");
    let exe = respawn_target()?;
    spawn_detached_respawn(&exe, &relaunch_args(mode), 1)
}

/// Restart the currently-running (old) instance after the binary on disk was
/// replaced behind its back. Called from the single-instance callback when a
/// freshly-updated instance signals with [`RELAUNCH_AFTER_UPDATE_FLAG`]; the
/// caller is responsible for exiting the app once this returns Ok.
pub fn prepare_self_restart_for_update() -> Result<(), String> {
    let mode = hub_manager::read_launch_mode(&hub_manager::get_hub_data_dir());
    let exe = respawn_target()?;
    // Keep the relaunch flag: if this (old) instance takes longer than the delay
    // to exit, the respawned instance re-triggers the handshake instead of being
    // silently swallowed by the single-instance plugin. The flag is inert in the
    // argv of a primary launch.
    spawn_detached_respawn(&exe, &relaunch_args(mode), 2)
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
    let source = UpdateSource::resolve();
    if !source.is_trusted(download_url) {
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
    // Private, unpredictable staging dir (0700): a fixed world-visible /tmp path
    // would let another local user pre-own it and swap the installer between
    // SHA-256 verification and the (possibly pkexec-elevated) install.
    let staging = tempfile::Builder::new()
        .prefix("companion-hub-update-")
        .tempdir()
        .map_err(|e| format!("temp dir: {}", e))?;
    let dest = staging.path().join(suffix);

    download_file(download_url, &dest, &source)?;
    set_progress("verify", "Verifying download integrity…");
    verify_downloaded_artifact(&dest, expected_size, expected_sha256)?;

    match install_artifact(&dest, launch_mode)? {
        InstallOutcome::Completed => {
            set_progress("done", "Update installed — relaunching…");
            relaunch_hub(launch_mode)?;
            drop(staging); // exit() below skips destructors
        }
        InstallOutcome::DetachedInstallerWillRelaunch => {
            // The detached helper needs the installer to outlive this process; it
            // deletes the file itself when done.
            set_progress("done", "Update installer running — app will restart…");
            let _ = staging.keep();
        }
    }
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
    use crate::hub_env::{default_update_cdn_base, default_update_cdn_host};

    fn cdn_url(path: &str) -> String {
        format!(
            "{}/{}",
            default_update_cdn_base(),
            path.trim_start_matches('/')
        )
    }

    #[test]
    fn trusted_url_accepts_configured_cdn_host() {
        assert!(is_trusted_download_url(&cdn_url("v0.2.18/windows/x64/setup.exe")));
    }

    #[test]
    fn trusted_url_accepts_uppercase_https_scheme() {
        assert!(is_trusted_download_url(
            &cdn_url("v0.2.18/windows/x64/setup.exe").replace("https://", "HTTPS://")
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
        assert!(!is_trusted_download_url(&format!(
            "http://{}/file.exe",
            default_update_cdn_host()
        )));
    }

    #[test]
    fn trusted_url_rejects_path_traversal() {
        assert!(!is_trusted_download_url(&format!(
            "https://{}/v0.2.18/../evil.exe",
            default_update_cdn_host()
        )));
        assert!(!is_trusted_download_url(&format!(
            "HTTPS://{}/v0.2.18/../evil.exe",
            default_update_cdn_host()
        )));
    }

    #[test]
    fn trusted_url_rejects_percent_encoded_path_traversal() {
        assert!(!is_trusted_download_url(&format!(
            "https://{}/v0.2.18/%2e%2e/evil.exe",
            default_update_cdn_host()
        )));
        assert!(!is_trusted_download_url(&format!(
            "https://{}/v0.2.18/%2E%2E/evil.exe",
            default_update_cdn_host()
        )));
        assert!(!is_trusted_download_url(&format!(
            "https://{}/v0.2.18/%252e%252e/evil.exe",
            default_update_cdn_host()
        )));
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
        let source = UpdateSource::default_cdn();
        let mac = serde_json::json!({ "dmg": sample_artifact(&cdn_url("v1/macos/arm/hub.dmg")) });
        assert_eq!(
            artifact_for_platform_data(&mac, HostOs::Macos, "appimage", &source)
                .expect("dmg")
                .url,
            cdn_url("v1/macos/arm/hub.dmg")
        );

        let win = serde_json::json!({
            "exe": sample_artifact(&cdn_url("v1/windows/x64/setup.exe")),
            "msi": sample_artifact(&cdn_url("v1/windows/x64/setup.msi")),
        });
        assert_eq!(
            artifact_for_platform_data(&win, HostOs::Windows, "appimage", &source)
                .expect("exe")
                .url,
            cdn_url("v1/windows/x64/setup.exe")
        );

        let linux = serde_json::json!({
            "deb": sample_artifact(&cdn_url("v1/linux/deb/x64/hub.deb")),
            "rpm": sample_artifact(&cdn_url("v1/linux/rpm/x64/hub.rpm")),
            "appimage": sample_artifact(&cdn_url("v1/linux/appimage/x64/hub.AppImage")),
        });
        assert_eq!(
            artifact_for_platform_data(&linux, HostOs::Linux, "deb", &source)
                .expect("deb")
                .url,
            cdn_url("v1/linux/deb/x64/hub.deb")
        );
        assert_eq!(
            artifact_for_platform_data(&linux, HostOs::Linux, "rpm", &source)
                .expect("rpm")
                .url,
            cdn_url("v1/linux/rpm/x64/hub.rpm")
        );
        assert_eq!(
            artifact_for_platform_data(&linux, HostOs::Linux, "appimage", &source)
                .expect("appimage")
                .url,
            cdn_url("v1/linux/appimage/x64/hub.AppImage")
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
                "dmg": sample_artifact(&cdn_url("v1/current/hub.dmg")),
                "exe": sample_artifact(&cdn_url("v1/current/setup.exe")),
                "deb": sample_artifact(&cdn_url("v1/current/hub.deb")),
                "appimage": sample_artifact(&cdn_url("v1/current/hub.AppImage")),
            }),
        );
        let manifest = ManifestJson {
            version: "1.0.0".to_string(),
            platforms,
        };
        let artifact = resolve_download_artifact(&manifest, &UpdateSource::default_cdn())
            .expect("artifact for current platform");
        assert!(artifact.url.starts_with(&format!("{}/", default_update_cdn_base())));
    }

    #[test]
    fn semver_compare_handles_prerelease_segments() {
        assert!(semver_compare_gt("0.3.0-beta.1", "0.2.18"));
        assert!(!semver_compare_gt("0.2.18-rc1", "0.2.18"));
        assert!(!semver_compare_gt("0.2.18", "0.3.0-beta.1"));
    }

    #[test]
    fn update_source_from_base_parses_override_origins() {
        let source = UpdateSource::from_base("http://127.0.0.1:8765/").expect("http override");
        assert!(source.allow_http);
        assert_eq!(source.host, "127.0.0.1");
        assert_eq!(source.latest_url(), "http://127.0.0.1:8765/latest.json");
        assert_eq!(
            source.manifest_url("v1.2.3"),
            "http://127.0.0.1:8765/v1.2.3/manifest.json"
        );

        assert!(UpdateSource::from_base("ftp://example.com").is_none());
        assert!(UpdateSource::from_base("not a url").is_none());
    }

    #[test]
    fn update_source_override_trusts_only_its_origin() {
        let source = UpdateSource::from_base("http://127.0.0.1:8765").expect("override");
        assert!(source.is_trusted("http://127.0.0.1:8765/v1/file.bin"));
        assert!(!source.is_trusted("http://127.0.0.1:9999/v1/file.bin"));
        assert!(!source.is_trusted("http://127.0.0.10:8765/v1/file.bin"));
        assert!(!source.is_trusted("http://127.0.0.1:8765/../escape.bin"));
        assert!(!source.is_trusted("https://evil.com/?http://127.0.0.1:8765"));
    }

    #[test]
    fn release_cdn_source_trusts_only_its_host() {
        let source = UpdateSource::default_cdn();
        assert!(source.is_trusted(&cdn_url("v0.2.18/macos/arm/hub.dmg")));
        assert!(!source.is_trusted(&format!(
            "http://{}/v0.2.18/macos/arm/hub.dmg",
            default_update_cdn_host()
        )));
        assert!(!source.is_trusted("https://dl.ci.computer.evil.com/file.exe"));
    }

    #[test]
    fn windows_update_script_builds_msi_and_nsis_variants() {
        let msi = windows_update_script(
            Path::new(r"C:\staging\Companion Hub_0.3.0_x64_en-US.msi"),
            Path::new(r"C:\Program Files\Companion Hub\companion-hub.exe"),
            &relaunch_args(PersistedLaunchMode::Detached),
        );
        assert!(msi.contains(
            r#"msiexec /i "C:\staging\Companion Hub_0.3.0_x64_en-US.msi" /qn /norestart"#
        ));
        assert!(msi.contains(r#"start "" "C:\Program Files\Companion Hub\companion-hub.exe" --relaunch-after-update --detached"#));
        assert!(msi.contains("ping -n 3"));
        assert!(msi.contains(r#"del "%~f0""#));

        let nsis = windows_update_script(
            Path::new(r"C:\staging\Companion Hub_0.3.0_x64-setup.exe"),
            Path::new(r"C:\Program Files\Companion Hub\companion-hub.exe"),
            &relaunch_args(PersistedLaunchMode::Desktop),
        );
        assert!(nsis.contains(r#""C:\staging\Companion Hub_0.3.0_x64-setup.exe" /S"#));
        assert!(!nsis.contains("--detached"));
    }

    #[test]
    fn relaunch_args_carry_update_flag_and_launch_mode() {
        assert_eq!(
            relaunch_args(PersistedLaunchMode::Desktop),
            vec![RELAUNCH_AFTER_UPDATE_FLAG.to_string()]
        );
        assert_eq!(
            relaunch_args(PersistedLaunchMode::Detached),
            vec![
                RELAUNCH_AFTER_UPDATE_FLAG.to_string(),
                DETACHED_FLAG.to_string()
            ]
        );
    }

    #[test]
    fn appimage_target_prefers_appimage_env_over_exe_heuristic() {
        // $APPIMAGE wins: under AppImage, current_exe is the FUSE-mounted inner
        // binary and never ends in .AppImage.
        assert_eq!(
            linux_appimage_target_from(
                Some(PathBuf::from("/home/u/Apps/Hub.AppImage")),
                Some(PathBuf::from("/tmp/.mount_hub123/usr/bin/companion-hub")),
                Some(PathBuf::from("/home/u")),
            ),
            PathBuf::from("/home/u/Apps/Hub.AppImage")
        );
        assert_eq!(
            linux_appimage_target_from(
                None,
                Some(PathBuf::from("/opt/Hub.AppImage")),
                Some(PathBuf::from("/home/u")),
            ),
            PathBuf::from("/opt/Hub.AppImage")
        );
        assert_eq!(
            linux_appimage_target_from(
                None,
                Some(PathBuf::from("/usr/bin/hub")),
                Some(PathBuf::from("/home/u"))
            ),
            PathBuf::from("/home/u/Applications/Companion Hub.AppImage")
        );
    }

    /// Minimal HTTP server for hermetic end-to-end coverage of the check →
    /// Hermetic local-HTTP-server end-to-end of check → manifest → download → verify.
    fn spawn_test_update_server(latest_version: &str, artifact: Vec<u8>) -> (String, String) {
        let sha = {
            let mut hasher = Sha256::new();
            hasher.update(&artifact);
            format!("{:x}", hasher.finalize())
        };
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let port = listener.local_addr().expect("addr").port();
        let base = format!("http://127.0.0.1:{port}");

        let key = platform_key().expect("platform key");
        let artifact_url = format!("{base}/v{latest_version}/artifact.bin");
        let artifact_entry = serde_json::json!({
            "url": artifact_url,
            "size": artifact.len(),
            "sha256": sha,
        });
        // Provide every artifact kind so the test passes regardless of host OS
        // and Linux distro package preference.
        let mut kinds = serde_json::Map::new();
        for kind in ARTIFACT_KEYS {
            kinds.insert(kind.to_string(), artifact_entry.clone());
        }
        let mut platforms = serde_json::Map::new();
        platforms.insert(key, serde_json::Value::Object(kinds));
        let manifest = serde_json::json!({
            "version": latest_version,
            "platforms": platforms,
        })
        .to_string();
        let latest = format!("{{\"version\":\"{latest_version}\"}}");
        let manifest_path = format!("/v{latest_version}/manifest.json");
        let artifact_path = format!("/v{latest_version}/artifact.bin");

        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut buffer = [0u8; 2048];
                let read = stream.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    continue;
                }
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body): (&str, Vec<u8>) = if path == "/latest.json" {
                    ("200 OK", latest.clone().into_bytes())
                } else if path == manifest_path {
                    ("200 OK", manifest.clone().into_bytes())
                } else if path == artifact_path {
                    ("200 OK", artifact.clone())
                } else {
                    ("404 Not Found", b"not found".to_vec())
                };
                let header = format!(
                    "HTTP/1.1 {}\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                    status,
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
            }
        });

        (base, sha)
    }

    #[test]
    fn end_to_end_check_download_verify_against_local_server() {
        let artifact = b"fake-installer-bytes-for-e2e".to_vec();
        let (base, sha) = spawn_test_update_server("9.9.9", artifact.clone());
        let source = UpdateSource::from_base(&base).expect("test source");

        // Check: newer version discovered, artifact resolved with expectations.
        let info = check_desktop_update_with_source("0.2.27", &source).expect("check");
        assert!(info.update_available);
        assert_eq!(info.latest_version, "9.9.9");
        assert!(info.download_url.starts_with(&base));
        assert_eq!(info.expected_size, Some(artifact.len() as u64));
        assert_eq!(info.expected_sha256.as_deref(), Some(sha.as_str()));

        // No update offered when already current.
        let current = check_desktop_update_with_source("9.9.9", &source).expect("check current");
        assert!(!current.update_available);

        // Download + integrity verification round-trip.
        let staging = tempfile::tempdir().expect("staging");
        let dest = staging.path().join("artifact.bin");
        download_file(&info.download_url, &dest, &source).expect("download");
        verify_downloaded_artifact(&dest, info.expected_size, info.expected_sha256.as_deref())
            .expect("verify");

        // Tampered artifact is rejected.
        std::fs::write(&dest, b"tampered-bytes-here-not-same").expect("tamper");
        assert!(verify_downloaded_artifact(
            &dest,
            info.expected_size,
            info.expected_sha256.as_deref()
        )
        .is_err());
    }
}
