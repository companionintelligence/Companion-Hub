use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::Deserialize;

use sha2::{Digest, Sha256};

use crate::app_binary;
use crate::hub_env::{default_update_cdn_base, default_update_cdn_host};
use crate::hub_manager::{self, PersistedLaunchMode};

/// Bind all interfaces so the Hub container can reach this listener via
/// `host.docker.internal:17400`. Loopback-only would drop that traffic on the
/// host gateway. `POST /update` (and `/health`) still require the bearer token.
const UPDATE_LISTENER_BIND_ADDR: &str = "0.0.0.0:17400";
const UPDATE_LISTENER_LOCAL_URL: &str = "http://127.0.0.1:17400";
/// How often the update listener checks whether an update replaced its program.
#[cfg(unix)]
const LISTENER_PROGRAM_CHECK_INTERVAL: Duration = Duration::from_secs(30);
pub(crate) const UPDATE_LISTENER_TOKEN_FILENAME: &str = "update-listener.token";
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
/// Held while the update listener answers a request whose headers have already arrived, so moving
/// onto a new program never cuts one off. Waiting for those bytes does not take it: a silent
/// socket would otherwise freeze the swap for as long as the read blocked.
static LISTENER_BUSY: Mutex<()> = Mutex::new(());
/// Shorter than the Hub's 1.5 s probe, so a socket that never speaks is gone before Settings
/// decides the desktop app is down.
const LISTENER_HEADER_DEADLINE: Duration = Duration::from_secs(1);
const LISTENER_MAX_HEADER_BYTES: usize = 4096;
/// One silent connection must not occupy every worker the Hub's health check needs.
const LISTENER_MAX_WORKERS: usize = 4;

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
    /// The installer format this computer takes: `deb`, `rpm` or `appimage` on Linux, `dmg` on
    /// macOS, `exe` on Windows. Its presence also tells the page that this app looks up its own
    /// installer when nothing is newer, so the page doesn't ask the Hub, which can't tell an
    /// Ubuntu from a Fedora.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_format: Option<String>,
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

fn host_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    }
}

fn platform_key() -> Option<String> {
    Some(platform_manifest_key(host_os()?, host_arch()))
}

/// `deb` for Debian, Ubuntu and the distros built on them, `rpm` for Fedora, RHEL and theirs,
/// `appimage` for the rest. It reads `ID` and then each word of `ID_LIKE`, quoted or not, as the
/// Docker installer's `is_distro` does: RHEL writes `ID="rhel"` and Rocky `ID_LIKE="rhel centos
/// fedora"`, which a match on the bare text `id=rhel` missed.
fn linux_package_preference_from_os_release(content: &str) -> &'static str {
    const DEB_FAMILY: [&str; 4] = ["debian", "ubuntu", "linuxmint", "pop"];
    const RPM_FAMILY: [&str; 5] = ["fedora", "rhel", "centos", "rocky", "almalinux"];
    let field = |key: &str| {
        content
            .lines()
            .filter_map(|line| line.trim().split_once('='))
            .find(|(name, _)| name.trim() == key)
            .map(|(_, value)| value.trim().trim_matches(['"', '\'']).to_ascii_lowercase())
            .unwrap_or_default()
    };
    let id = field("ID");
    let id_like = field("ID_LIKE");
    for name in std::iter::once(id.as_str()).chain(id_like.split_whitespace()) {
        if DEB_FAMILY.contains(&name) {
            return "deb";
        }
        if RPM_FAMILY.contains(&name) {
            return "rpm";
        }
    }
    "appimage"
}

fn linux_package_preference() -> &'static str {
    linux_package_preference_from(
        &std::fs::read_to_string("/etc/os-release").unwrap_or_default(),
        tool_on_path,
    )
}

/// The package format from `/etc/os-release`, and when that doesn't place the distro (an `ID`
/// it doesn't know and no `ID_LIKE`, as on Deepin, or no file at all), from the package tool
/// that is installed: `dpkg` first, then `rpm`. Only with neither does it stay `appimage`, which
/// releases don't build, so the Desktop app card points to the download page.
fn linux_package_preference_from(
    os_release: &str,
    has_tool: impl Fn(&str) -> bool,
) -> &'static str {
    match linux_package_preference_from_os_release(os_release) {
        "appimage" if has_tool("dpkg") => "deb",
        "appimage" if has_tool("rpm") => "rpm",
        preference => preference,
    }
}

/// Whether an executable named `name` is on `PATH` or in the usual system folders. An app
/// started from a desktop launcher can have a short `PATH`.
fn tool_on_path(name: &str) -> bool {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&path)
        .chain(["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(PathBuf::from))
        .any(|dir| dir.join(name).is_file())
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
        // Only the format this computer installs. Another one installs a second copy beside this
        // one, or not at all: releases build no AppImage, so a distro `/etc/os-release` doesn't
        // place (Arch, for one) used to get the `.deb`, offered with `apt` steps. With nothing in
        // its format, the Desktop app card points to the download page instead.
        HostOs::Linux => read(package_preference),
    }
}

/// This computer: its OS and, on Linux, the package format `/etc/os-release` points to.
fn current_host() -> Option<(HostOs, &'static str)> {
    host_os().map(|os| (os, linux_package_preference()))
}

/// The installer format the updater looks for first on `os`; see [`artifact_for_platform_data`].
fn host_package_format(os: HostOs, linux_preference: &'static str) -> &'static str {
    match os {
        HostOs::Macos => "dmg",
        HostOs::Windows => "exe",
        HostOs::Linux => linux_preference,
    }
}

/// The installer `manifest` lists for `host` (see [`current_host`]), in the format it takes.
fn resolve_download_artifact(
    manifest: &ManifestJson,
    source: &UpdateSource,
    host: Option<(HostOs, &'static str)>,
) -> Option<ResolvedArtifact> {
    let (os, linux_preference) = host?;
    let platform_data = manifest
        .platforms
        .get(&platform_manifest_key(os, host_arch()))?;
    artifact_for_platform_data(platform_data, os, linux_preference, source)
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
    Ok(crate::digest_hex::lower_hex(&hasher.finalize()))
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

/// Whether a newer version exists, and its installer. Callers that only act on an update (the
/// CLI, the update listener, the install command) use this one.
pub fn check_desktop_update(current_version: &str) -> Result<DesktopUpdateInfo, String> {
    check_desktop_update_with_source(current_version, &UpdateSource::resolve(), false)
}

/// [`check_desktop_update`] that also names this computer's installer when it already runs the
/// newest version, for the Desktop app card. It costs a manifest read the other callers skip.
pub fn check_desktop_update_naming_installer(
    current_version: &str,
) -> Result<DesktopUpdateInfo, String> {
    check_desktop_update_with_source(current_version, &UpdateSource::resolve(), true)
}

fn check_desktop_update_with_source(
    current_version: &str,
    source: &UpdateSource,
    name_current_installer: bool,
) -> Result<DesktopUpdateInfo, String> {
    check_desktop_update_for_host(
        current_version,
        source,
        current_host(),
        name_current_installer,
    )
}

/// [`check_desktop_update_with_source`] for a given computer (see [`current_host`]).
fn check_desktop_update_for_host(
    current_version: &str,
    source: &UpdateSource,
    host: Option<(HostOs, &'static str)>,
    name_current_installer: bool,
) -> Result<DesktopUpdateInfo, String> {
    let client = source.http_client(Duration::from_secs(30))?;

    let latest_version = fetch_latest_version(&client, source)?;
    let update_available = semver_compare_gt(&latest_version, current_version);

    let download_url = if update_available {
        let manifest = fetch_manifest(&client, &latest_version, source)?;
        resolve_download_artifact(&manifest, source, host)
    } else if name_current_installer && !semver_compare_gt(current_version, &latest_version) {
        // This computer already runs the newest version. Its installer is looked up anyway, so the
        // Desktop app card can offer it again in this computer's own format (the `.rpm` on Fedora).
        // The check doesn't depend on it: a failed read only leaves the installer out. A build ahead
        // of the download server gets none, since the newest release there would downgrade it.
        fetch_manifest(&client, &latest_version, source)
            .ok()
            .and_then(|manifest| resolve_download_artifact(&manifest, source, host))
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
        package_format: host
            .map(|(os, linux_preference)| host_package_format(os, linux_preference).to_string()),
    })
}

/// The releases on GitHub, which list every installer of each version.
const DESKTOP_RELEASES_PAGE: &str =
    "https://github.com/companionintelligence/Companion-Hub/releases";

/// The release page of `version`, for a computer it has no installer for in its own format.
/// Release tags are `v<version>` (Desktop Release's `tag` input). Without a version the releases
/// list it is. `/releases/latest` would skip pre-releases, which Desktop Release publishes by
/// default, so it could name an older version than the one offered.
fn desktop_release_page(version: &str) -> String {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty()
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return DESKTOP_RELEASES_PAGE.to_string();
    }
    format!("{DESKTOP_RELEASES_PAGE}/tag/v{version}")
}

/// Whether `latest` takes precedence over `current`, by semver 2.0.0 (§11); see
/// [`crate::hub_env::compare_semver`].
fn semver_compare_gt(latest: &str, current: &str) -> bool {
    crate::hub_env::compare_semver(latest, current) == std::cmp::Ordering::Greater
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

/// What `install_artifact` leaves for the caller to do. It depends only on the platform, and is
/// known before anything runs because it decides when the Hub stops (see [`run_host_update`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallOutcome {
    /// Artifact installed in place — the caller must relaunch the app.
    Completed,
    /// A detached helper process finishes the install and relaunches after the
    /// current process exits (Windows: installers cannot replace running binaries).
    DetachedInstallerWillRelaunch,
}

impl InstallOutcome {
    fn on_this_platform() -> Self {
        if cfg!(target_os = "windows") {
            Self::DetachedInstallerWillRelaunch
        } else {
            Self::Completed
        }
    }
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

/// The name the installer is staged under: the URL's last path segment, decoded, with anything but
/// ASCII letters, digits, `.`, `_` and `-` replaced by `_`.
///
/// The release has published every Windows installer as `Companion%20Hub_<version>_…`. Kept
/// encoded, that name went into the batch script below, where `%2` is the script's second argument:
/// the install line ran `Companion0Hub_…`, which does not exist, and the next line relaunched the old
/// version as if the update had worked.
fn staged_installer_name(download_url: &str) -> String {
    let path = download_url.split(['?', '#']).next().unwrap_or_default();
    let segment = path.rsplit('/').next().unwrap_or_default();
    let decoded = decode_path_segment(segment).unwrap_or_else(|()| segment.to_string());
    let name: String = decoded
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if name.trim_matches('.').is_empty() {
        "update.bin".to_string()
    } else {
        name
    }
}

/// Batch script that waits for the app to exit, runs the installer silently,
/// relaunches the app, and cleans up after itself. Running the installer
/// synchronously from the app itself does not work: a Windows installer cannot
/// replace a running binary, so Restart Manager closes the very process driving
/// the update and the relaunch step is never reached.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn windows_update_script(installer: &Path, app_exe: &Path, relaunch_args: &[String]) -> String {
    // `%` starts a variable in a batch file, quotes or not, and `%%` is a literal one. The staged
    // installer name no longer holds one (see `staged_installer_name`), but a user name can.
    let installer_str = installer.display().to_string().replace('%', "%%");
    let exe_str = app_exe.display().to_string().replace('%', "%%");
    let install_line = if installer_str.to_ascii_lowercase().ends_with(".msi") {
        format!("msiexec /i \"{installer_str}\" /qn /norestart")
    } else {
        format!("\"{installer_str}\" /S")
    };
    let args = relaunch_args
        .iter()
        .map(|a| format!(" {a}"))
        .collect::<String>();
    // The staging folder holds only the installer and this script, so it is empty once both are
    // deleted. `rmdir` without `/s` leaves it alone if anything else is in there.
    let remove_staging_dir = installer_str
        .rsplit_once('\\')
        .map(|(dir, _)| dir)
        .filter(|dir| !dir.is_empty())
        .map(|dir| format!(" & rmdir \"{dir}\" >nul 2>&1"))
        .unwrap_or_default();
    // The script is written as UTF-8, but cmd reads it in the console's OEM code page (437 or 850
    // on most machines), so a user name such as `José` in either path names a folder that does not
    // exist: the install line fails and the relaunch line starts nothing. `chcp 65001` switches
    // cmd to UTF-8 for the lines after it.
    // `ping` as sleep: `timeout` requires an interactive console and fails in a
    // detached process. The final line is the canonical batch self-delete.
    format!(
        "@echo off\r\n\
         chcp 65001 >nul\r\n\
         ping -n 3 127.0.0.1 >nul\r\n\
         {install_line}\r\n\
         start \"\" \"{exe_str}\"{args}\r\n\
         del \"{installer_str}\" >nul 2>&1\r\n\
         (goto) 2>nul & del \"%~f0\"{remove_staging_dir}\r\n"
    )
}

#[cfg(target_os = "windows")]
fn install_windows_exe(installer: &Path, launch_mode: PersistedLaunchMode) -> Result<(), String> {
    set_progress("install", "Handing off to installer — app will restart…");
    let app_exe = std::env::current_exe().map_err(|e| format!("current_exe: {}", e))?;
    let script = windows_update_script(installer, &app_exe, &relaunch_args(launch_mode));
    let script_path = installer.with_file_name("companion-hub-update.cmd");
    std::fs::write(&script_path, script)
        .map_err(|e| format!("Failed to write update script: {}", e))?;
    spawn_detached_cmd(&script_path)
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
        app_binary::appimage_path_from_env(),
        std::env::current_exe().ok(),
        dirs::home_dir(),
    ))
}

/// Installs in place, or on Windows starts the detached helper: see [`InstallOutcome`].
fn install_artifact(path: &Path, launch_mode: PersistedLaunchMode) -> Result<(), String> {
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
            return install_macos_dmg(path);
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

/// An update started from the open window comes back as a window, even when a
/// `--detached` start recorded headless while that window was open. A headless
/// update keeps the recorded mode.
fn relaunch_mode_for_update(
    recorded: PersistedLaunchMode,
    from_open_window: bool,
) -> PersistedLaunchMode {
    if from_open_window {
        PersistedLaunchMode::Desktop
    } else {
        recorded
    }
}

/// Binary to respawn after an update. Not `current_exe` as is: once an update has replaced the
/// file, Linux reports it as "… (deleted)", and starting that path fails.
fn respawn_target() -> Result<PathBuf, String> {
    app_binary::launch_path().ok_or_else(|| "Could not find the Companion Hub program".to_string())
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

/// Batch script that waits, starts `exe` again and deletes itself. The path gets the same care as in
/// [`windows_update_script`]: `%` doubled, and `chcp 65001` so a non-ASCII user name reads right.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_respawn_script(exe: &Path, args: &[String], delay_secs: u64) -> String {
    let arg_str = args.iter().map(|a| format!(" {a}")).collect::<String>();
    format!(
        "@echo off\r\n\
         chcp 65001 >nul\r\n\
         ping -n {} 127.0.0.1 >nul\r\n\
         start \"\" \"{}\"{}\r\n\
         (goto) 2>nul & del \"%~f0\"\r\n",
        delay_secs + 1,
        exe.display().to_string().replace('%', "%%"),
        arg_str
    )
}

#[cfg(windows)]
fn spawn_detached_respawn(exe: &Path, args: &[String], delay_secs: u64) -> Result<(), String> {
    use std::io::Write as _;
    let script = windows_respawn_script(exe, args, delay_secs);
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
    // This callback runs in the open window. Reading the file here used to turn
    // the restart headless after `--detached` had overwritten it.
    let mode = relaunch_mode_for_update(
        hub_manager::read_launch_mode(&hub_manager::get_hub_data_dir()),
        true,
    );
    let exe = respawn_target()?;
    // Keep the relaunch flag: if this (old) instance takes longer than the delay
    // to exit, the respawned instance re-triggers the handshake instead of being
    // silently swallowed by the single-instance plugin. The flag is inert in the
    // argv of a primary launch.
    spawn_detached_respawn(&exe, &relaunch_args(mode), 2)
}

/// Restart the open desktop app onto the version an update installed while it ran (its Restart
/// button, or a second launch). Always as the desktop app: the window asked, so a `--detached`
/// start recorded meanwhile must not turn the restart into a headless one. Refused while this
/// process installs an update, which relaunches by itself when done. The caller exits the app once
/// this returns Ok.
pub fn prepare_restart_onto_installed_app() -> Result<(), String> {
    if HOST_UPDATE_IN_PROGRESS.load(Ordering::SeqCst) {
        return Err(
            "An update is being installed; Companion Hub restarts when it is done".to_string(),
        );
    }
    let exe = respawn_target()?;
    spawn_detached_respawn(&exe, &relaunch_args(PersistedLaunchMode::Desktop), 2)
}

pub fn perform_host_update(
    download_url: &str,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let _guard = HostUpdateGuard::acquire()?;
    perform_host_update_inner(download_url, expected_size, expected_sha256, false)
}

/// Settings → Update, from the open window. Relaunches with a window whatever
/// the launch-mode file says.
pub fn perform_host_update_from_open_window(
    download_url: &str,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    let _guard = HostUpdateGuard::acquire()?;
    perform_host_update_inner(download_url, expected_size, expected_sha256, true)
}

/// The parts of a desktop app update that act on this computer. [`run_host_update`] decides their
/// order, and tests stand in for them to check it.
trait HostUpdateSteps {
    /// Downloads the installer and checks it against the release manifest's size and SHA-256.
    fn download_and_verify(&mut self) -> Result<(), String>;
    /// Installs in place, or starts the detached installer: see [`InstallOutcome`].
    fn install(&mut self) -> Result<(), String>;
    /// Stops the Hub for the app that starts next. Clears the user-stopped marker and the saved
    /// config hash first, so that app starts the Hub and recreates it from its own files.
    fn stop_hub(&mut self) -> Result<(), String>;
    fn start_hub(&mut self) -> Result<(), String>;
    /// Starts the installed app, which takes over from this process.
    fn relaunch(&mut self) -> Result<(), String>;
    fn log(&mut self, message: &str);
}

/// Runs a desktop app update without leaving the Hub stopped.
///
/// Replacing the app on disk leaves the Hub's containers running, so on Linux and macOS the Hub
/// keeps running through the download and the install. An install that fails, or that waits for a
/// password nobody types, leaves it as it was (#1760). Only an installed update stops the Hub, right
/// before the new version starts and recreates it. On Windows the installer runs once this process
/// exits, so the Hub stops right before that hand-off, and starts again if the hand-off fails.
fn run_host_update(
    steps: &mut impl HostUpdateSteps,
    outcome: InstallOutcome,
) -> Result<(), String> {
    match outcome {
        InstallOutcome::Completed => {
            steps
                .download_and_verify()
                .and_then(|()| steps.install())
                .map_err(|err| hub_kept_running(steps, err))?;
            // Installed, and the new version recreates the stack when it starts, so a stop that
            // fails doesn't hold the update back.
            if let Err(err) = steps.stop_hub() {
                steps.log(&format!(
                    "The Hub did not stop cleanly for the update; the new version recreates it: {err}"
                ));
            }
            steps.relaunch().map_err(|err| start_hub_again(steps, err))
        }
        InstallOutcome::DetachedInstallerWillRelaunch => {
            steps
                .download_and_verify()
                .map_err(|err| hub_kept_running(steps, err))?;
            steps
                .stop_hub()
                .and_then(|()| steps.install())
                .map_err(|err| start_hub_again(steps, err))
        }
    }
}

fn hub_kept_running(steps: &mut impl HostUpdateSteps, err: String) -> String {
    steps.log(&format!(
        "Desktop app update failed; the Hub keeps running: {err}"
    ));
    err
}

/// After the update failed with the Hub stopped: starts it again, and says so in the error.
fn start_hub_again(steps: &mut impl HostUpdateSteps, err: String) -> String {
    steps.log(&format!(
        "Desktop app update failed after the Hub was stopped; starting the Hub again: {err}"
    ));
    let err = err.trim_end_matches('.');
    match steps.start_hub() {
        Ok(()) => format!("{err}. The Hub was started again."),
        Err(start_err) => format!("{err}. Starting the Hub again failed too: {start_err}"),
    }
}

/// The update as it runs for real.
struct LiveHostUpdate<'a> {
    source: &'a UpdateSource,
    download_url: &'a str,
    expected_size: Option<u64>,
    expected_sha256: Option<&'a str>,
    installer: PathBuf,
    launch_mode: PersistedLaunchMode,
    compose_path: PathBuf,
    env_path: PathBuf,
    data_dir: PathBuf,
}

impl HostUpdateSteps for LiveHostUpdate<'_> {
    fn download_and_verify(&mut self) -> Result<(), String> {
        download_file(self.download_url, &self.installer, self.source)?;
        set_progress("verify", "Verifying download integrity…");
        verify_downloaded_artifact(&self.installer, self.expected_size, self.expected_sha256)
    }

    fn install(&mut self) -> Result<(), String> {
        install_artifact(&self.installer, self.launch_mode)
    }

    fn stop_hub(&mut self) -> Result<(), String> {
        hub_manager::clear_user_stopped(&self.data_dir);
        // Ensure the post-install startup pulls images and recreates containers even if
        // compose/env filenames are unchanged (e.g. CI_HUB_IMAGE still uses :latest).
        hub_manager::invalidate_config_hash(&self.data_dir);
        set_progress("stop", "Stopping Hub stack…");
        hub_manager::stop_hub_for_update(&self.compose_path, &self.env_path).map(|_| ())
    }

    fn start_hub(&mut self) -> Result<(), String> {
        hub_manager::start_hub(&self.compose_path, &self.env_path, &self.data_dir).map(|_| ())
    }

    fn relaunch(&mut self) -> Result<(), String> {
        set_progress("done", "Update installed — relaunching…");
        relaunch_hub(self.launch_mode)
    }

    fn log(&mut self, message: &str) {
        let _ = hub_manager::append_desktop_log_for(&self.data_dir, "hub.update", message);
    }
}

fn perform_host_update_inner(
    download_url: &str,
    expected_size: Option<u64>,
    expected_sha256: Option<&str>,
    from_open_window: bool,
) -> Result<(), String> {
    let source = UpdateSource::resolve();
    if !source.is_trusted(download_url) {
        return Err("Untrusted download URL".to_string());
    }

    set_progress("prepare", "Preparing update…");
    let data_dir = hub_manager::get_hub_data_dir();
    let suffix = staged_installer_name(download_url);
    // Private, unpredictable staging dir (0700): a fixed world-visible /tmp path
    // would let another local user pre-own it and swap the installer between
    // SHA-256 verification and the (possibly pkexec-elevated) install.
    let staging = tempfile::Builder::new()
        .prefix("companion-hub-update-")
        .tempdir()
        .map_err(|e| format!("temp dir: {}", e))?;
    let outcome = InstallOutcome::on_this_platform();
    let mut steps = LiveHostUpdate {
        source: &source,
        download_url,
        expected_size,
        expected_sha256,
        installer: staging.path().join(suffix),
        launch_mode: relaunch_mode_for_update(
            hub_manager::read_launch_mode(&data_dir),
            from_open_window,
        ),
        compose_path: data_dir.join(hub_manager::HUB_COMPOSE_FILENAME),
        env_path: hub_manager::hub_env_path_for(&data_dir),
        data_dir,
    };
    run_host_update(&mut steps, outcome)?;

    match outcome {
        InstallOutcome::Completed => drop(staging), // exit() below skips destructors
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
        let format = info.package_format.as_deref().unwrap_or("unknown");
        return Err(format!(
            "Update {} is available but has no {format} installer for this platform ({platform}). Download it from {}",
            info.latest_version,
            desktop_release_page(&info.latest_version)
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

/// Headers of one request, or nothing when the peer closed, stalled, or never finished them.
///
/// One `read` used to decide the request. A header that arrived in a second packet lost its
/// token, and a peer that sent nothing held the only thread until it hung up.
fn read_request_headers(stream: &mut TcpStream) -> std::io::Result<Option<String>> {
    stream.set_write_timeout(Some(LISTENER_HEADER_DEADLINE))?;
    let mut buf = vec![0u8; LISTENER_MAX_HEADER_BYTES];
    let mut filled = 0usize;
    let deadline = Instant::now() + LISTENER_HEADER_DEADLINE;
    while filled < LISTENER_MAX_HEADER_BYTES {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        stream.set_read_timeout(Some(remaining))?;
        match stream.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => {
                filled += n;
                if buf[..filled].windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error)
                if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut =>
            {
                break;
            }
            Err(error) => return Err(error),
        }
    }
    if filled == 0 || !buf[..filled].windows(4).any(|window| window == b"\r\n\r\n") {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&buf[..filled]).into_owned()))
}

fn respond_to_update_request(stream: &mut TcpStream, request: &str, data_dir: &Path) {
    let is_post_update = request.starts_with("POST /update");
    let (status, body) = if is_post_update {
        match authorize_update_listener_request(&request, data_dir) {
            Err(err) => ("401 Unauthorized", err),
            Ok(()) => match check_and_trigger_update_from_listener() {
                Ok(msg) => ("200 OK", msg),
                Err(err) => ("500 Internal Server Error", err),
            },
        }
    } else if request.starts_with("GET /health") {
        match authorize_update_listener_request(&request, data_dir) {
            Err(err) => ("401 Unauthorized", err),
            Ok(()) => ("200 OK", "ok".to_string()),
        }
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

/// Reads the headers first, then answers. The busy lock covers only the answer, so a socket that
/// has not spoken yet does not stop another request, or the swap onto a replaced program.
fn serve_one_update_connection(mut stream: TcpStream, data_dir: &Path) {
    let request = match read_request_headers(&mut stream) {
        Ok(Some(request)) => request,
        _ => return,
    };
    let _busy = LISTENER_BUSY.lock().unwrap_or_else(PoisonError::into_inner);
    respond_to_update_request(&mut stream, &request, data_dir);
}

/// Accepts until `listener` closes. Each connection is its own thread, up to
/// [`LISTENER_MAX_WORKERS`]. Past that the new socket is closed and the loop keeps accepting, so
/// one silent peer cannot sit in front of the Hub's health check.
fn accept_update_connections(listener: TcpListener, data_dir: PathBuf) {
    let workers = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming().flatten() {
        if workers.fetch_add(1, Ordering::SeqCst) >= LISTENER_MAX_WORKERS {
            workers.fetch_sub(1, Ordering::SeqCst);
            drop(stream);
            continue;
        }
        let workers = Arc::clone(&workers);
        let data_dir = data_dir.clone();
        std::thread::spawn(move || {
            struct Released(Arc<AtomicUsize>);
            impl Drop for Released {
                fn drop(&mut self) {
                    self.0.fetch_sub(1, Ordering::SeqCst);
                }
            }
            let _released = Released(workers);
            serve_one_update_connection(stream, &data_dir);
        });
    }
}

/// In `state/` because the Hub container mounts that folder (as `/data/state`) but not the data
/// dir's root, so this is the only place the backend can read the token from.
fn update_listener_token_path(data_dir: &Path) -> PathBuf {
    data_dir.join("state").join(UPDATE_LISTENER_TOKEN_FILENAME)
}

/// Reads a token file only when it is this user's own regular file and nobody else can read or
/// write it. `state/` is shared with the Hub container, and a permission repair can leave the
/// folder open to every local user, so a token file there may have been planted or read by
/// someone else. Opened without following a symlink or waiting on a FIFO (whose open blocks until
/// a writer comes, holding up the listener), and checked on the open file.
fn read_private_token_file(path: &Path) -> Result<String, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("Failed to read update listener token: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = file
            .metadata()
            .map_err(|e| format!("Failed to read update listener token: {}", e))?;
        let own_uid = unsafe { libc::geteuid() };
        if !metadata.is_file() || metadata.uid() != own_uid || metadata.mode() & 0o077 != 0 {
            return Err("update listener token is not private to this user".to_string());
        }
    }
    let mut token = String::new();
    file.read_to_string(&mut token)
        .map_err(|e| format!("Failed to read update listener token: {}", e))?;
    Ok(token.trim().to_string())
}

fn read_update_listener_token(data_dir: &Path) -> Result<String, String> {
    read_private_token_file(&update_listener_token_path(data_dir))
}

/// Writes the token owner-only and whole: a new file, created 0600, renamed over the old one, so
/// a reader never sees it empty or half written and nobody else can read it, even for a moment.
fn write_token_file(path: &Path, token: &str) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "update listener token path has no folder".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create state dir: {}", e))?;
    let mut file = tempfile::Builder::new()
        .prefix(".update-listener.token.")
        .tempfile_in(dir)
        .map_err(|e| format!("Failed to write update listener token: {}", e))?;
    file.write_all(format!("{token}\n").as_bytes())
        .map_err(|e| format!("Failed to write update listener token: {}", e))?;
    file.persist(path)
        .map_err(|e| format!("Failed to write update listener token: {}", e.error))?;
    Ok(())
}

/// A new token each time the listener starts. The Hub sends it to whatever answers on port
/// 17400, so a token that was read, planted, or caught while no listener ran stops working at the
/// next start.
fn issue_update_listener_token(data_dir: &Path) -> Result<String, String> {
    // rand 0.10: `thread_rng()` is `rng()`, the same OS-seeded CSPRNG, and `distributions` is `distr`.
    use rand::RngExt;
    let token: String = rand::rng()
        .sample_iter(rand::distr::Alphanumeric)
        .take(48)
        .map(char::from)
        .collect();
    write_token_file(&update_listener_token_path(data_dir), &token)?;
    keep_legacy_token_in_step(data_dir, &token);
    Ok(token)
}

/// Older builds keep the token at the data dir's root, and a listener one of them started holds
/// the port until it exits, even after an update, checking each request against that file. Where
/// the file exists it gets the new token too, so whichever listener answers accepts the Hub. It is
/// never created: a build that reads it writes its own.
fn keep_legacy_token_in_step(data_dir: &Path, token: &str) {
    let legacy_path = data_dir.join(UPDATE_LISTENER_TOKEN_FILENAME);
    if std::fs::symlink_metadata(&legacy_path).is_ok() {
        let _ = write_token_file(&legacy_path, token);
    }
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

fn authorize_update_listener_request(request: &str, data_dir: &Path) -> Result<(), String> {
    let expected = read_update_listener_token(data_dir)?;
    // An empty `X-Companion-Hub-Update-Token:` header reads as "", so an empty file would let
    // anyone who can reach the port through.
    if expected.is_empty() {
        return Err("update listener token is empty".to_string());
    }
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
        if let Err(err) = perform_host_update_inner(
            &download_url,
            expected_size,
            expected_sha256.as_deref(),
            false,
        ) {
            set_progress("error", &err);
        }
    });
    Ok("update started".to_string())
}

pub fn run_update_listener() {
    let data_dir = hub_manager::get_hub_data_dir();
    if issue_update_listener_token(&data_dir).is_err() {
        return;
    }
    let listener = match TcpListener::bind(UPDATE_LISTENER_BIND_ADDR) {
        Ok(l) => l,
        Err(_) => return,
    };
    #[cfg(unix)]
    move_onto_replaced_program_when_idle();
    accept_update_connections(listener, data_dir);
}

/// The listener outlives the app, so an update installed while it runs would leave it answering
/// the Hub with the old version's code, and judging updates against the old version, until
/// logout. Once an update replaces its program it starts the new one in its place: same process,
/// still detached, and the listening socket closes on exec so the new program can bind the port.
#[cfg(unix)]
fn move_onto_replaced_program_when_idle() {
    use std::os::unix::process::CommandExt;
    std::thread::spawn(|| {
        let running_version = app_binary::running_version();
        loop {
            std::thread::sleep(LISTENER_PROGRAM_CHECK_INTERVAL);
            if !app_binary::restart_state(&running_version).restart_required {
                continue;
            }
            let Some(program) = app_binary::launch_path() else {
                continue;
            };
            // Between requests only, and never while this listener's own install runs: that
            // replaces the program too, and relaunches the app when done.
            let _busy = LISTENER_BUSY.lock().unwrap_or_else(PoisonError::into_inner);
            if HOST_UPDATE_IN_PROGRESS.load(Ordering::SeqCst) {
                continue;
            }
            // Only returns if the new program could not be started; keep serving meanwhile.
            let _ = Command::new(program).arg("--update-listener").exec();
        }
    });
}

/// Stops this user's update listeners still running a program an update replaced, so the one
/// started next can take the port. Listeners from before [`move_onto_replaced_program_when_idle`]
/// never move on by themselves.
#[cfg(target_os = "linux")]
fn stop_stale_update_listeners() {
    let Some(program) = app_binary::launch_path() else {
        return;
    };
    let own_uid = unsafe { libc::geteuid() };
    let pids = app_binary::stale_update_listener_pids(
        Path::new("/proc"),
        &program,
        own_uid,
        std::process::id(),
    );
    for &pid in &pids {
        let _ = hub_manager::append_desktop_log(
            "updater.listener",
            &format!("Stopping update listener {pid}: an update replaced its program."),
        );
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
    // Give them a moment to exit and free the port.
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while pids
        .iter()
        .any(|pid| Path::new(&format!("/proc/{pid}")).exists())
        && std::time::Instant::now() < deadline
    {
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub fn spawn_update_listener_daemon() {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(_) => return,
    };
    #[cfg(target_os = "linux")]
    stop_stale_update_listeners();

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
    let token = read_update_listener_token(&hub_manager::get_hub_data_dir())?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client: {}", e))?;
    let response = client
        .post(format!("{}/update", UPDATE_LISTENER_LOCAL_URL))
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
        assert!(is_trusted_download_url(&cdn_url(
            "v0.2.18/windows/x64/setup.exe"
        )));
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
    fn update_listener_binds_all_interfaces() {
        assert_eq!(UPDATE_LISTENER_BIND_ADDR, "0.0.0.0:17400");
        assert!(UPDATE_LISTENER_LOCAL_URL.starts_with("http://127.0.0.1:"));
    }

    #[test]
    fn update_listener_extracts_bearer_token() {
        let request = "POST /update HTTP/1.1\r\nAuthorization: Bearer secret-token\r\n\r\n";
        assert_eq!(
            extract_update_listener_token_from_request(request).as_deref(),
            Some("secret-token")
        );
    }

    /// A data dir holding `token` where the desktop app keeps it. The path is spelled out, not
    /// taken from `update_listener_token_path`, because the backend reads this exact location.
    fn data_dir_with_state_token(token: &str) -> tempfile::TempDir {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let state_dir = data_dir.path().join("state");
        std::fs::create_dir_all(&state_dir).expect("mkdir state");
        let token_path = state_dir.join("update-listener.token");
        std::fs::write(&token_path, format!("{token}\n")).expect("write token");
        #[cfg(unix)]
        set_mode(&token_path, 0o600);
        data_dir
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).expect("stat").permissions().mode() & 0o777
    }

    fn spawn_test_update_listener(token: &str) -> (std::net::SocketAddr, tempfile::TempDir) {
        let data_dir = data_dir_with_state_token(token);
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test listener");
        let addr = listener.local_addr().expect("addr");
        let path = data_dir.path().to_path_buf();
        std::thread::spawn(move || accept_update_connections(listener, path));
        (addr, data_dir)
    }

    fn read_listener_response(stream: &mut TcpStream) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("timeout");
        let mut buf = Vec::new();
        let _ = stream.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    }

    #[test]
    fn silent_connection_does_not_stop_a_health_check() {
        let (addr, _data_dir) = spawn_test_update_listener("health-token");
        let _silent = TcpStream::connect(addr).expect("silent connect");
        std::thread::sleep(Duration::from_millis(50));
        let started = Instant::now();
        let mut health = TcpStream::connect(addr).expect("health connect");
        health
            .write_all(b"GET /health HTTP/1.1\r\nAuthorization: Bearer health-token\r\n\r\n")
            .expect("write health");
        let response = read_listener_response(&mut health);
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "health waited on the silent socket: {response}"
        );
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("\r\n\r\nok"));
    }

    #[test]
    fn split_headers_still_authorize() {
        let (addr, _data_dir) = spawn_test_update_listener("split-token");
        let mut health = TcpStream::connect(addr).expect("connect");
        std::thread::sleep(Duration::from_millis(50));
        health
            .write_all(b"GET /health HTTP/1.1\r\n")
            .expect("write request line");
        std::thread::sleep(Duration::from_millis(200));
        health
            .write_all(b"Authorization: Bearer split-token\r\n\r\n")
            .expect("write authorization");
        let response = read_listener_response(&mut health);
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    }

    #[test]
    fn unfinished_headers_are_dropped_without_a_refusal() {
        let (addr, _data_dir) = spawn_test_update_listener("drop-token");
        let mut stalled = TcpStream::connect(addr).expect("connect");
        stalled
            .set_read_timeout(Some(Duration::from_secs(3)))
            .expect("timeout");
        let started = Instant::now();
        let mut buf = Vec::new();
        let read = stalled.read_to_end(&mut buf);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "stalled socket was not dropped"
        );
        assert!(read.is_ok(), "stalled socket was not closed: {read:?}");
        let response = String::from_utf8_lossy(&buf);
        assert!(!response.contains("401"), "{response}");
    }

    #[test]
    fn update_listener_token_lives_in_the_state_folder_the_hub_mounts() {
        assert_eq!(
            update_listener_token_path(Path::new("/hub-data")),
            Path::new("/hub-data/state/update-listener.token")
        );
    }

    #[test]
    fn update_listener_issues_a_new_owner_only_token_in_state_on_each_start() {
        let data_dir = tempfile::tempdir().expect("tempdir");

        let first = issue_update_listener_token(data_dir.path()).expect("token");
        let second = issue_update_listener_token(data_dir.path()).expect("token");

        let state_dir = data_dir.path().join("state");
        let token_path = state_dir.join("update-listener.token");
        assert_eq!(first.len(), 48);
        assert_ne!(first, second);
        assert_eq!(
            std::fs::read_to_string(&token_path).expect("read token"),
            format!("{second}\n")
        );
        #[cfg(unix)]
        assert_eq!(mode_of(&token_path), 0o600);
        // The file it was written through was renamed into place, not left beside it.
        assert_eq!(
            std::fs::read_dir(&state_dir).expect("read state").count(),
            1
        );
        // No older build ran here, so there is no root file to keep in step.
        assert!(!data_dir.path().join("update-listener.token").exists());
    }

    #[test]
    fn update_listener_token_keeps_the_file_older_builds_check_in_step() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let legacy_path = data_dir.path().join("update-listener.token");
        std::fs::write(&legacy_path, "legacy-token\n").expect("write legacy token");

        let token = issue_update_listener_token(data_dir.path()).expect("token");

        // A listener an older build started checks each request against the root file.
        assert_eq!(
            std::fs::read_to_string(&legacy_path).expect("read legacy token"),
            format!("{token}\n")
        );
        #[cfg(unix)]
        assert_eq!(mode_of(&legacy_path), 0o600);
    }

    #[test]
    fn update_listener_rejects_an_empty_token_header_when_the_token_file_is_empty() {
        let data_dir = data_dir_with_state_token("");

        let request = "POST /update HTTP/1.1\r\nX-Companion-Hub-Update-Token:\r\n\r\n";
        assert_eq!(
            authorize_update_listener_request(request, data_dir.path()),
            Err("update listener token is empty".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn update_listener_rejects_a_token_file_other_users_can_read() {
        let data_dir = data_dir_with_state_token("expected-token");
        set_mode(
            &data_dir.path().join("state").join("update-listener.token"),
            0o644,
        );

        let request = "POST /update HTTP/1.1\r\nAuthorization: Bearer expected-token\r\n\r\n";
        assert_eq!(
            authorize_update_listener_request(request, data_dir.path()),
            Err("update listener token is not private to this user".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn update_listener_does_not_wait_on_a_fifo_in_place_of_the_token() {
        use std::os::unix::ffi::OsStrExt;
        let data_dir = tempfile::tempdir().expect("tempdir");
        let state_dir = data_dir.path().join("state");
        std::fs::create_dir_all(&state_dir).expect("mkdir state");
        let token_path = std::ffi::CString::new(
            state_dir
                .join("update-listener.token")
                .as_os_str()
                .as_bytes(),
        )
        .expect("token path");
        assert_eq!(unsafe { libc::mkfifo(token_path.as_ptr(), 0o600) }, 0);

        // Opening a FIFO for reading waits for a writer; on a thread, so a wait fails the test
        // instead of hanging it.
        let dir = data_dir.path().to_path_buf();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let request = "GET /health HTTP/1.1\r\nAuthorization: Bearer anything\r\n\r\n";
            let _ = sender.send(authorize_update_listener_request(request, &dir));
        });
        let result = receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("the listener waited on the FIFO");
        assert_eq!(
            result,
            Err("update listener token is not private to this user".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn update_listener_rejects_a_symlink_in_place_of_the_token() {
        let data_dir = tempfile::tempdir().expect("tempdir");
        let state_dir = data_dir.path().join("state");
        std::fs::create_dir_all(&state_dir).expect("mkdir state");
        let planted = data_dir.path().join("planted-token");
        std::fs::write(&planted, "planted-token\n").expect("write planted token");
        set_mode(&planted, 0o600);
        std::os::unix::fs::symlink(&planted, state_dir.join("update-listener.token"))
            .expect("symlink");

        let request = "POST /update HTTP/1.1\r\nAuthorization: Bearer planted-token\r\n\r\n";
        assert!(authorize_update_listener_request(request, data_dir.path()).is_err());
    }

    #[test]
    fn update_listener_authorizes_valid_token() {
        let data_dir = data_dir_with_state_token("expected-token");

        let request = "POST /update HTTP/1.1\r\nAuthorization: Bearer expected-token\r\n\r\n";
        assert_eq!(
            authorize_update_listener_request(request, data_dir.path()),
            Ok(())
        );
    }

    #[test]
    fn update_listener_rejects_missing_token() {
        let data_dir = data_dir_with_state_token("expected-token");

        let request = "POST /update HTTP/1.1\r\n\r\n";
        assert_eq!(
            authorize_update_listener_request(request, data_dir.path()),
            Err("missing update listener token".to_string())
        );
    }

    #[test]
    fn update_listener_rejects_invalid_token() {
        let data_dir = data_dir_with_state_token("expected-token");

        let request = "POST /update HTTP/1.1\r\nAuthorization: Bearer wrong-token\r\n\r\n";
        assert_eq!(
            authorize_update_listener_request(request, data_dir.path()),
            Err("invalid update listener token".to_string())
        );
    }

    #[test]
    fn host_update_guard_rejects_concurrent_acquire() {
        let first = HostUpdateGuard::acquire().expect("first acquire");
        assert!(HostUpdateGuard::acquire().is_err());
        drop(first);
        assert!(HostUpdateGuard::acquire().is_ok());
    }

    /// Stands in for a host update: records the steps that ran, and fails the ones in `failing`.
    #[derive(Default)]
    struct RecordedUpdate {
        failing: Vec<&'static str>,
        ran: Vec<&'static str>,
        logged: Vec<String>,
    }

    impl RecordedUpdate {
        fn failing(steps: &[&'static str]) -> Self {
            Self {
                failing: steps.to_vec(),
                ..Self::default()
            }
        }

        fn run(&mut self, step: &'static str) -> Result<(), String> {
            self.ran.push(step);
            if self.failing.contains(&step) {
                Err(format!("{step} failed"))
            } else {
                Ok(())
            }
        }
    }

    impl HostUpdateSteps for RecordedUpdate {
        fn download_and_verify(&mut self) -> Result<(), String> {
            self.run("download")
        }
        fn install(&mut self) -> Result<(), String> {
            self.run("install")
        }
        fn stop_hub(&mut self) -> Result<(), String> {
            self.run("stop")
        }
        fn start_hub(&mut self) -> Result<(), String> {
            self.run("start")
        }
        fn relaunch(&mut self) -> Result<(), String> {
            self.run("relaunch")
        }
        fn log(&mut self, message: &str) {
            self.logged.push(message.to_string());
        }
    }

    #[test]
    fn in_place_update_stops_the_hub_only_once_the_new_version_is_installed() {
        let mut update = RecordedUpdate::default();
        run_host_update(&mut update, InstallOutcome::Completed).expect("update");
        assert_eq!(update.ran, ["download", "install", "stop", "relaunch"]);
    }

    // #1760: handed an update overnight, the install waited for a password nobody typed, or failed
    // at once without a polkit agent, after the Hub had already been stopped.
    #[test]
    fn in_place_update_that_fails_to_install_leaves_the_hub_running() {
        for (failing, ran) in [
            ("download", &["download"][..]),
            ("install", &["download", "install"][..]),
        ] {
            let mut update = RecordedUpdate::failing(&[failing]);
            let err = run_host_update(&mut update, InstallOutcome::Completed).expect_err(failing);
            assert_eq!(err, format!("{failing} failed"));
            assert_eq!(update.ran, ran, "{failing}");
            assert_eq!(
                update.logged,
                [format!(
                    "Desktop app update failed; the Hub keeps running: {failing} failed"
                )]
            );
        }
    }

    #[test]
    fn in_place_update_relaunches_even_when_the_hub_does_not_stop_cleanly() {
        let mut update = RecordedUpdate::failing(&["stop"]);
        run_host_update(&mut update, InstallOutcome::Completed).expect("update");
        assert_eq!(update.ran, ["download", "install", "stop", "relaunch"]);
        assert_eq!(update.logged.len(), 1);
    }

    #[test]
    fn in_place_update_starts_the_hub_again_when_the_relaunch_fails() {
        let mut update = RecordedUpdate::failing(&["relaunch"]);
        let err = run_host_update(&mut update, InstallOutcome::Completed).expect_err("relaunch");
        assert_eq!(
            update.ran,
            ["download", "install", "stop", "relaunch", "start"]
        );
        assert_eq!(err, "relaunch failed. The Hub was started again.");
    }

    #[test]
    fn detached_installer_stops_the_hub_right_before_the_hand_off() {
        let mut update = RecordedUpdate::default();
        run_host_update(&mut update, InstallOutcome::DetachedInstallerWillRelaunch)
            .expect("update");
        assert_eq!(update.ran, ["download", "stop", "install"]);
    }

    #[test]
    fn detached_installer_download_that_fails_leaves_the_hub_running() {
        let mut update = RecordedUpdate::failing(&["download"]);
        run_host_update(&mut update, InstallOutcome::DetachedInstallerWillRelaunch)
            .expect_err("download");
        assert_eq!(update.ran, ["download"]);
    }

    #[test]
    fn detached_installer_starts_the_hub_again_when_anything_fails_after_the_stop() {
        for (failing, ran) in [
            ("stop", &["download", "stop", "start"][..]),
            ("install", &["download", "stop", "install", "start"][..]),
        ] {
            let mut update = RecordedUpdate::failing(&[failing]);
            let err = run_host_update(&mut update, InstallOutcome::DetachedInstallerWillRelaunch)
                .expect_err(failing);
            assert_eq!(update.ran, ran, "{failing}");
            assert_eq!(err, format!("{failing} failed. The Hub was started again."));
        }

        let mut update = RecordedUpdate::failing(&["install", "start"]);
        let err = run_host_update(&mut update, InstallOutcome::DetachedInstallerWillRelaunch)
            .expect_err("install");
        assert_eq!(
            err,
            "install failed. Starting the Hub again failed too: start failed"
        );
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
    fn linux_package_preference_asks_the_package_tool_when_os_release_is_inconclusive() {
        let tools =
            |installed: &'static [&'static str]| move |name: &str| installed.contains(&name);

        // Deepin: Debian-based, but its ID isn't one the updater knows and it sets no ID_LIKE.
        assert_eq!(
            linux_package_preference_from("ID=deepin\n", tools(&["dpkg"])),
            "deb"
        );
        // No /etc/os-release at all.
        assert_eq!(linux_package_preference_from("", tools(&["rpm"])), "rpm");
        // dpkg wins when both are there, as on a Debian with rpm installed for alien.
        assert_eq!(
            linux_package_preference_from("", tools(&["rpm", "dpkg"])),
            "deb"
        );
        // Neither: the download page.
        assert_eq!(
            linux_package_preference_from("ID=arch\n", tools(&[])),
            "appimage"
        );
        // A distro os-release places keeps its own format, whatever else is installed.
        assert_eq!(
            linux_package_preference_from("ID=fedora\n", tools(&["dpkg"])),
            "rpm"
        );
        assert_eq!(
            linux_package_preference_from("ID=ubuntu\n", tools(&["rpm"])),
            "deb"
        );
    }

    #[test]
    fn release_page_names_the_offered_version() {
        assert_eq!(
            desktop_release_page("0.3.7"),
            "https://github.com/companionintelligence/Companion-Hub/releases/tag/v0.3.7"
        );
        assert_eq!(
            desktop_release_page("v0.3.7-rc.1"),
            "https://github.com/companionintelligence/Companion-Hub/releases/tag/v0.3.7-rc.1"
        );
        assert_eq!(
            desktop_release_page(""),
            "https://github.com/companionintelligence/Companion-Hub/releases"
        );
        assert_eq!(
            desktop_release_page("0.3.7/../x"),
            "https://github.com/companionintelligence/Companion-Hub/releases"
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

    #[test]
    fn linux_package_preference_reads_quoted_ids_and_id_like() {
        // The ID and ID_LIKE lines these distros ship in /etc/os-release.
        let cases = [
            (
                "PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nVERSION_ID=\"24.04\"\nID=ubuntu\nID_LIKE=debian\n",
                "deb",
            ),
            ("NAME=\"Debian GNU/Linux\"\nVERSION_ID=\"12\"\nID=debian\n", "deb"),
            ("NAME=\"Linux Mint\"\nID=linuxmint\nID_LIKE=\"ubuntu debian\"\n", "deb"),
            ("NAME=\"Zorin OS\"\nID=zorin\nID_LIKE=ubuntu\n", "deb"),
            ("NAME=\"Kali GNU/Linux\"\nID=kali\nID_LIKE=debian\n", "deb"),
            ("NAME=\"Fedora Linux\"\nID=fedora\nVERSION_ID=40\nVARIANT_ID=workstation\n", "rpm"),
            (
                "NAME=\"Red Hat Enterprise Linux\"\nID=\"rhel\"\nID_LIKE=\"fedora\"\nVERSION_ID=\"9.4\"\nPLATFORM_ID=\"platform:el9\"\n",
                "rpm",
            ),
            ("NAME=\"Rocky Linux\"\nID=\"rocky\"\nID_LIKE=\"rhel centos fedora\"\n", "rpm"),
            ("NAME=\"AlmaLinux\"\nID=\"almalinux\"\nID_LIKE=\"rhel centos fedora\"\n", "rpm"),
            ("NAME=\"CentOS Stream\"\nID=\"centos\"\nID_LIKE=\"rhel fedora\"\n", "rpm"),
            ("NAME=\"Manjaro Linux\"\nID=manjaro\nID_LIKE=arch\n", "appimage"),
            (
                "NAME=\"openSUSE Tumbleweed\"\nID=\"opensuse-tumbleweed\"\nID_LIKE=\"opensuse suse\"\n",
                "appimage",
            ),
            ("", "appimage"),
        ];
        for (os_release, expected) in cases {
            assert_eq!(
                linux_package_preference_from_os_release(os_release),
                expected,
                "{os_release}"
            );
        }
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
    fn artifact_for_platform_offers_no_other_linux_format() {
        let source = UpdateSource::default_cdn();
        // What releases build: a .deb and a .rpm, no AppImage.
        let release = serde_json::json!({
            "deb": sample_artifact(&cdn_url("v1/linux/deb/x64/hub.deb")),
            "rpm": sample_artifact(&cdn_url("v1/linux/rpm/x64/hub.rpm")),
        });
        // A distro /etc/os-release doesn't place (Arch) used to get the .deb.
        assert!(artifact_for_platform_data(&release, HostOs::Linux, "appimage", &source).is_none());

        let rpm_only = serde_json::json!({
            "rpm": sample_artifact(&cdn_url("v1/linux/rpm/x64/hub.rpm")),
            "appimage": sample_artifact(&cdn_url("v1/linux/appimage/x64/hub.AppImage")),
        });
        assert!(artifact_for_platform_data(&rpm_only, HostOs::Linux, "deb", &source).is_none());
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
        let artifact =
            resolve_download_artifact(&manifest, &UpdateSource::default_cdn(), current_host())
                .expect("artifact for current platform");
        assert!(artifact
            .url
            .starts_with(&format!("{}/", default_update_cdn_base())));
    }

    #[test]
    fn semver_compare_handles_prerelease_segments() {
        assert!(semver_compare_gt("0.3.0-beta.1", "0.2.18"));
        assert!(!semver_compare_gt("0.2.18-rc1", "0.2.18"));
        assert!(!semver_compare_gt("0.2.18", "0.3.0-beta.1"));
    }

    #[test]
    fn semver_compare_ranks_a_prerelease_below_its_release() {
        // A release candidate is older than the release it leads to, so a computer on the release
        // isn't offered the candidate, and one on the candidate is offered the release.
        assert!(!semver_compare_gt("0.3.6-rc.1", "0.3.6"));
        assert!(semver_compare_gt("0.3.6", "0.3.6-rc.1"));
        assert!(semver_compare_gt("0.3.7-rc.1", "0.3.6"));
        assert!(!semver_compare_gt("0.3.6-rc.1", "0.3.6-rc.1"));
    }

    #[test]
    fn semver_compare_follows_the_spec_order_of_prereleases() {
        // The example in semver 2.0.0 section 11, lowest first.
        let ordered = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
        ];
        for (i, lower) in ordered.iter().enumerate() {
            for higher in &ordered[i + 1..] {
                assert!(semver_compare_gt(higher, lower), "{higher} > {lower}");
                assert!(!semver_compare_gt(lower, higher), "{lower} < {higher}");
            }
        }
    }

    #[test]
    fn semver_compare_ignores_build_metadata_and_a_leading_v() {
        assert!(!semver_compare_gt("1.0.0+build.2", "1.0.0+build.1"));
        assert!(!semver_compare_gt("v1.0.0", "1.0.0"));
        assert!(semver_compare_gt("v1.0.1", "1.0.0"));
        assert!(semver_compare_gt("1.0.0-rc.10", "1.0.0-rc.9"));
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

    // 0.3.4 to 0.3.5 on Windows: the installer was staged as `Companion%20Hub_0.3.5_x64-setup.exe`,
    // the script ran `Companion0Hub_…`, and the old version came back up.
    #[test]
    fn stages_the_installer_under_a_name_the_batch_script_cannot_misread() {
        assert_eq!(
            staged_installer_name(
                "https://dl.ci.computer/v0.3.5/windows/x64/Companion%20Hub_0.3.5_x64-setup.exe"
            ),
            "Companion_Hub_0.3.5_x64-setup.exe"
        );
        assert_eq!(
            staged_installer_name(
                "https://dl.ci.computer/v0.3.6/windows/x64/Companion.Hub_0.3.6_x64_en-US.msi?x=1#y"
            ),
            "Companion.Hub_0.3.6_x64_en-US.msi"
        );
        assert_eq!(
            staged_installer_name(
                "https://dl.ci.computer/v0.3.5/linux/deb/x64/Companion%20Hub_0.3.5_amd64.deb"
            ),
            "Companion_Hub_0.3.5_amd64.deb"
        );
        let traversal = staged_installer_name("https://dl.ci.computer/v1/a%2F..%2F..%5Cb%25c.exe");
        assert!(!traversal.contains(['/', '\\', '%']), "{traversal}");
        assert_eq!(
            staged_installer_name("https://dl.ci.computer/v1/"),
            "update.bin"
        );
        assert_eq!(
            staged_installer_name("https://dl.ci.computer/v1/.."),
            "update.bin"
        );
    }

    #[test]
    fn windows_update_script_keeps_a_percent_sign_literal() {
        let script = windows_update_script(
            Path::new(r"C:\Users\a%20b\AppData\Local\Temp\companion-hub-update-x\setup.exe"),
            Path::new(r"C:\Users\a%20b\AppData\Local\Companion Hub\companion-hub.exe"),
            &relaunch_args(PersistedLaunchMode::Desktop),
        );
        assert!(script.contains(
            r#""C:\Users\a%%20b\AppData\Local\Temp\companion-hub-update-x\setup.exe" /S"#
        ));
        assert!(script.contains(
            r#"start "" "C:\Users\a%%20b\AppData\Local\Companion Hub\companion-hub.exe""#
        ));
        assert!(script.contains(
            r#"del "C:\Users\a%%20b\AppData\Local\Temp\companion-hub-update-x\setup.exe""#
        ));
        assert!(script.contains(r#"del "%~f0""#));
    }

    // cmd reads a batch file in the OEM code page. Without `chcp 65001` first, the UTF-8 bytes of
    // `José` read as `JosÃ©` and neither the installer nor the relaunched app is found.
    #[test]
    fn windows_update_script_reads_a_non_ascii_user_name_as_utf8() {
        let script = windows_update_script(
            Path::new(r"C:\Users\José\AppData\Local\Temp\companion-hub-update-x\setup.exe"),
            Path::new(r"C:\Users\José\AppData\Local\Companion Hub\companion-hub.exe"),
            &relaunch_args(PersistedLaunchMode::Desktop),
        );
        assert!(script.starts_with("@echo off\r\nchcp 65001 >nul\r\n"));
        assert!(script.contains(
            r#"(goto) 2>nul & del "%~f0" & rmdir "C:\Users\José\AppData\Local\Temp\companion-hub-update-x" >nul 2>&1"#
        ));
    }

    #[test]
    fn windows_respawn_script_keeps_the_path_literal() {
        let script = windows_respawn_script(
            Path::new(r"C:\Users\José 100%\AppData\Local\Companion Hub\companion-hub.exe"),
            &relaunch_args(PersistedLaunchMode::Desktop),
            2,
        );
        assert!(script.starts_with("@echo off\r\nchcp 65001 >nul\r\nping -n 3 127.0.0.1 >nul\r\n"));
        assert!(script.contains(
            r#"start "" "C:\Users\José 100%%\AppData\Local\Companion Hub\companion-hub.exe" --relaunch-after-update"#
        ));
        assert!(script.contains(r#"del "%~f0""#));
    }

    #[test]
    fn update_from_an_open_window_relaunches_as_desktop_even_when_recorded_detached() {
        assert_eq!(
            relaunch_mode_for_update(PersistedLaunchMode::Detached, true),
            PersistedLaunchMode::Desktop
        );
        assert_eq!(
            relaunch_args(relaunch_mode_for_update(
                PersistedLaunchMode::Detached,
                true
            )),
            vec![RELAUNCH_AFTER_UPDATE_FLAG.to_string()]
        );
    }

    #[test]
    fn headless_update_keeps_the_recorded_mode() {
        assert_eq!(
            relaunch_mode_for_update(PersistedLaunchMode::Detached, false),
            PersistedLaunchMode::Detached
        );
        assert_eq!(
            relaunch_mode_for_update(PersistedLaunchMode::Desktop, false),
            PersistedLaunchMode::Desktop
        );
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
            crate::digest_hex::lower_hex(&hasher.finalize())
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

    /// Serves `latest.json` naming `latest_version`, and the manifest `manifest` builds from the
    /// server's base URL, when it builds one.
    fn serve_release(
        latest_version: &str,
        manifest: impl FnOnce(&str) -> Option<serde_json::Value>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let base = format!(
            "http://127.0.0.1:{}",
            listener.local_addr().expect("addr").port()
        );
        let latest = format!("{{\"version\":\"{latest_version}\"}}");
        let manifest_path = format!("/v{latest_version}/manifest.json");
        let manifest = manifest(&base).map(|m| m.to_string());
        std::thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buffer = [0u8; 2048];
                let read = stream.read(&mut buffer).unwrap_or(0);
                if read == 0 {
                    continue;
                }
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = match (path.as_str(), &manifest) {
                    ("/latest.json", _) => ("200 OK", latest.clone()),
                    (p, Some(m)) if p == manifest_path => ("200 OK", m.clone()),
                    _ => ("404 Not Found", "not found".to_string()),
                };
                let header = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        base
    }

    /// A Linux release that lists all three package formats, each at its own URL.
    fn linux_release(base: &str, version: &str) -> serde_json::Value {
        let entry = |path: &str| serde_json::json!({ "url": format!("{base}/v{version}/{path}"), "size": 1 });
        serde_json::json!({
            "version": version,
            "platforms": {
                platform_manifest_key(HostOs::Linux, host_arch()): {
                    "deb": entry("hub.deb"),
                    "rpm": entry("hub.rpm"),
                    "appimage": entry("hub.AppImage"),
                }
            }
        })
    }

    #[test]
    fn up_to_date_check_names_this_computers_own_installer() {
        let base = serve_release("1.2.3", |base| Some(linux_release(base, "1.2.3")));
        let source = UpdateSource::from_base(&base).expect("test source");

        // Fedora gets the .rpm and Ubuntu the .deb, even with nothing newer to install.
        let fedora =
            check_desktop_update_for_host("1.2.3", &source, Some((HostOs::Linux, "rpm")), true)
                .expect("check on Fedora");
        assert!(!fedora.update_available);
        assert!(
            fedora.download_url.ends_with("/v1.2.3/hub.rpm"),
            "{}",
            fedora.download_url
        );
        assert_eq!(fedora.package_format.as_deref(), Some("rpm"));

        let ubuntu =
            check_desktop_update_for_host("1.2.3", &source, Some((HostOs::Linux, "deb")), true)
                .expect("check on Ubuntu");
        assert!(
            ubuntu.download_url.ends_with("/v1.2.3/hub.deb"),
            "{}",
            ubuntu.download_url
        );
        assert_eq!(ubuntu.package_format.as_deref(), Some("deb"));
    }

    #[test]
    fn up_to_date_check_offers_nothing_older_and_survives_a_missing_manifest() {
        let base = serve_release("1.2.3", |base| Some(linux_release(base, "1.2.3")));
        let source = UpdateSource::from_base(&base).expect("test source");

        // A build ahead of the download server would be downgraded by its newest release.
        let ahead =
            check_desktop_update_for_host("1.3.0", &source, Some((HostOs::Linux, "rpm")), true)
                .expect("check ahead of the server");
        assert!(!ahead.update_available);
        assert!(ahead.download_url.is_empty());

        // Without a manifest the check still answers, only without an installer.
        let no_manifest =
            UpdateSource::from_base(&serve_release("1.2.3", |_| None)).expect("source");
        let current = check_desktop_update_for_host(
            "1.2.3",
            &no_manifest,
            Some((HostOs::Linux, "deb")),
            true,
        )
        .expect("check without a manifest");
        assert!(!current.update_available);
        assert!(current.download_url.is_empty());
        assert_eq!(current.package_format.as_deref(), Some("deb"));
    }

    #[test]
    fn up_to_date_check_offers_no_other_format() {
        // Like a real release: a .deb and an .rpm, no AppImage.
        let deb_and_rpm = |base: &str| {
            Some(serde_json::json!({
                "version": "1.2.3",
                "platforms": {
                    platform_manifest_key(HostOs::Linux, host_arch()): {
                        "deb": { "url": format!("{base}/v1.2.3/hub.deb"), "size": 1 },
                        "rpm": { "url": format!("{base}/v1.2.3/hub.rpm"), "size": 1 },
                    }
                }
            }))
        };
        let source = UpdateSource::from_base(&serve_release("1.2.3", deb_and_rpm)).expect("source");
        let arch = Some((HostOs::Linux, "appimage"));

        // Arch takes an AppImage, which the release lacks, so the .deb isn't offered in its place.
        let current = check_desktop_update_for_host("1.2.3", &source, arch, true)
            .expect("check on Arch, up to date");
        assert!(!current.update_available);
        assert!(current.download_url.is_empty(), "{}", current.download_url);
        assert_eq!(current.package_format.as_deref(), Some("appimage"));

        // Nor in an update: another format would install a second copy, or not at all. The
        // Desktop app card points to the download page instead.
        let update =
            check_desktop_update_for_host("1.0.0", &source, arch, true).expect("check on Arch");
        assert!(update.update_available);
        assert!(update.download_url.is_empty(), "{}", update.download_url);
        let fedora_update =
            check_desktop_update_for_host("1.0.0", &source, Some((HostOs::Linux, "rpm")), false)
                .expect("check on Fedora");
        assert!(
            fedora_update.download_url.ends_with("/v1.2.3/hub.rpm"),
            "{}",
            fedora_update.download_url
        );

        // Fedora still gets its .rpm.
        let fedora =
            check_desktop_update_for_host("1.2.3", &source, Some((HostOs::Linux, "rpm")), true)
                .expect("check on Fedora, up to date");
        assert!(
            fedora.download_url.ends_with("/v1.2.3/hub.rpm"),
            "{}",
            fedora.download_url
        );
    }

    #[test]
    fn end_to_end_check_download_verify_against_local_server() {
        let artifact = b"fake-installer-bytes-for-e2e".to_vec();
        let (base, sha) = spawn_test_update_server("9.9.9", artifact.clone());
        let source = UpdateSource::from_base(&base).expect("test source");

        // Check: newer version discovered, artifact resolved with expectations.
        let info = check_desktop_update_with_source("0.2.27", &source, false).expect("check");
        assert!(info.update_available);
        assert_eq!(info.latest_version, "9.9.9");
        assert!(info.download_url.starts_with(&base));
        assert_eq!(info.expected_size, Some(artifact.len() as u64));
        assert_eq!(info.expected_sha256.as_deref(), Some(sha.as_str()));

        // No update offered when already current, but this computer's installer is still named.
        let current =
            check_desktop_update_with_source("9.9.9", &source, true).expect("check current");
        assert!(!current.update_available);
        assert_eq!(current.download_url, info.download_url);
        assert_eq!(current.expected_sha256.as_deref(), Some(sha.as_str()));
        assert!(current.package_format.is_some());

        // The CLI, the update listener and the install command act only on an update, so their
        // check reads no manifest for the version already running.
        let current_only =
            check_desktop_update_with_source("9.9.9", &source, false).expect("check current only");
        assert!(!current_only.update_available);
        assert!(current_only.download_url.is_empty());

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
