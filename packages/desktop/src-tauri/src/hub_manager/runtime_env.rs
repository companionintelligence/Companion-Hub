//! Runtime .env rendering, compose profiles, VPN toggles and host device id.

use super::*;

/// Parse a .env file into a HashMap of key-value pairs.
pub(crate) fn parse_env_file(path: &Path) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                map.insert(key.trim().to_string(), value.trim().to_string());
            }
        }
    }
    map
}

pub(crate) fn has_tailscale_auth_key(env: &std::collections::HashMap<String, String>) -> bool {
    ["TAILSCALE_AUTHKEY", "HEADSCALE_PREAUTH_KEY"]
        .iter()
        .any(|key| {
            env.get(*key)
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false)
        })
}

/// True when the Tailscale state volume already has a login (browser/auth-key connect).
fn has_tailscale_persisted_state() -> bool {
    docker_command()
        .args([
            "run",
            "--rm",
            "-v",
            "hub_tailscale_state:/state:ro",
            "alpine:3.21",
            "sh",
            "-c",
            "test -s /state/tailscaled.state",
        ])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Pure decision for whether the Private VPN compose profile should be enabled.
pub(crate) fn private_vpn_should_run(
    user_disabled: bool,
    has_auth_key: bool,
    has_state: bool,
) -> bool {
    !user_disabled && (has_auth_key || has_state)
}

/// Returns `true` when the Tailscale sidecar (`hub-tailscale`) should run.
///
/// Enabled when the user has not opted out **and** there is either a non-empty
/// auth key or persisted Tailscale state. Starting without credentials causes
/// `containerboot` to NeedsLogin → kill → restart loop. Legacy `PRIVATE_VPN_ENABLED`
/// in old `.env` files is ignored.
pub(crate) fn private_vpn_enabled_from_map(
    env: &std::collections::HashMap<String, String>,
) -> bool {
    let user_disabled = matches!(
        env.get("PRIVATE_VPN_USER_DISABLED").map(|v| v.as_str()),
        Some("true")
    );
    private_vpn_should_run(
        user_disabled,
        has_tailscale_auth_key(env),
        has_tailscale_persisted_state(),
    )
}

/// Cached by hub `.env` file mtime so frequent [`get_hub_status`] polls do not re-read and parse the file.
pub(crate) fn is_private_vpn_enabled() -> bool {
    let path = hub_env_path();
    let mtime = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok());
    let mut guard = lock_recovering(&PRIVATE_VPN_ENV_CACHE);
    if let Some((cached_mtime, cached_val)) = guard.as_ref() {
        if *cached_mtime == mtime {
            return *cached_val;
        }
    }
    let val = private_vpn_enabled_from_map(&parse_env_file(&path));
    *guard = Some((mtime, val));
    val
}

/// Deduplicate comma-separated profile names while preserving first-seen order (stable across repeated merges).
fn dedupe_compose_profile_tokens(tokens: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    let mut out = Vec::new();
    for t in tokens {
        if seen.insert(t.clone()) {
            out.push(t);
        }
    }
    out
}

fn has_cloudflare_tunnel_token(existing: &std::collections::HashMap<String, String>) -> bool {
    let Some(root) = get_non_empty_env_value(existing, "ROOT_FOLDER_HOST") else {
        return false;
    };
    // Canonical: sibling ../tunnel/token (compose bind). Also accept legacy <root>/tunnel/token
    // so older installs keep the cloudflare profile until they migrate.
    tunnel_token_present_for_data_dir(&host_path_from_docker_path(&root))
}

/// Ensures `private-vpn` and `cloudflare` compose profiles when enabled, without dropping other profiles.
pub(crate) fn merge_compose_profiles(
    existing: &std::collections::HashMap<String, String>,
    vpn_on: bool,
) -> String {
    let raw = existing
        .get("COMPOSE_PROFILES")
        .map(|s| s.as_str())
        .unwrap_or("")
        .trim();
    let tokens: Vec<String> = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let mut parts = dedupe_compose_profile_tokens(tokens);

    if vpn_on {
        if !parts.iter().any(|p| p == "private-vpn") {
            parts.push("private-vpn".into());
        }
    } else {
        parts.retain(|p| p != "private-vpn");
    }

    if has_cloudflare_tunnel_token(existing) {
        if !parts.iter().any(|p| p == "cloudflare") {
            parts.push("cloudflare".into());
        }
    } else {
        parts.retain(|p| p != "cloudflare");
    }

    parts.join(",")
}

pub(crate) fn get_non_empty_env_value(
    existing: &std::collections::HashMap<String, String>,
    key: &str,
) -> Option<String> {
    existing
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

pub fn host_data_dir_from_env_path(env_path: &Path) -> Option<PathBuf> {
    let values = parse_env_file(env_path);
    get_non_empty_env_value(&values, "ROOT_FOLDER_HOST")
        .map(|value| host_path_from_docker_path(&value))
}

const INVALID_HOST_DEVICE_IDS: &[&str] = &[
    "not specified",
    "to be filled by o.e.m.",
    "default string",
    "system serial number",
    "chassis serial number",
    "none",
    "na",
    "n/a",
    "0",
];

pub(crate) fn is_usable_host_device_id(id: &str) -> bool {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if INVALID_HOST_DEVICE_IDS.contains(&lower.as_str()) {
        return false;
    }
    lower != "00000000-0000-0000-0000-000000000000"
}

pub(crate) fn extract_ioreg_platform_uuid(output: &str) -> Option<String> {
    for line in output.lines() {
        if !line.contains("IOPlatformUUID") {
            continue;
        }
        let Some(idx) = line.find("IOPlatformUUID") else {
            continue;
        };
        let rest = &line[idx + "IOPlatformUUID".len()..];
        let Some(eq_idx) = rest.find('=') else {
            continue;
        };
        let after_eq = rest[eq_idx + 1..].trim();
        let Some(after_quote) = after_eq.strip_prefix('"') else {
            continue;
        };
        let Some(end) = after_quote.find('"') else {
            continue;
        };
        let uuid = after_quote[..end].trim();
        if is_usable_host_device_id(uuid) {
            return Some(uuid.to_string());
        }
    }
    None
}

pub(crate) fn extract_system_profiler_serial(output: &str) -> Option<String> {
    for line in output.lines() {
        let rest = line
            .split("Serial Number (system):")
            .nth(1)
            .or_else(|| line.split("Serial Number:").nth(1));
        if let Some(rest) = rest {
            let serial = rest.trim();
            if is_usable_host_device_id(serial) {
                return Some(serial.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn read_host_device_id_impl() -> Option<String> {
    if let Ok(output) = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
    {
        if output.status.success() {
            if let Some(uuid) =
                extract_ioreg_platform_uuid(&String::from_utf8_lossy(&output.stdout))
            {
                return Some(uuid);
            }
        }
    }

    if let Ok(output) = Command::new("system_profiler")
        .args(["SPHardwareDataType"])
        .output()
    {
        if output.status.success() {
            return extract_system_profiler_serial(&String::from_utf8_lossy(&output.stdout));
        }
    }

    None
}

#[cfg(target_os = "linux")]
fn read_host_device_id_impl() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id")
        .ok()
        .and_then(|id| {
            let id = id.trim().to_string();
            if is_usable_host_device_id(&id) {
                Some(id)
            } else {
                None
            }
        })
}

#[cfg(target_os = "windows")]
fn read_host_device_id_impl() -> Option<String> {
    if let Ok(output) = Command::new("wmic")
        .args(["csproduct", "get", "uuid", "/value"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if let Some(uuid) = line.strip_prefix("UUID=") {
                    let uuid = uuid.trim();
                    if is_usable_host_device_id(uuid) {
                        return Some(uuid.to_string());
                    }
                }
            }
        }
    }

    if let Ok(output) = Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    {
        if output.status.success() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                if line.contains("MachineGuid") {
                    let guid = line.split_whitespace().last()?.trim();
                    if is_usable_host_device_id(guid) {
                        return Some(guid.to_string());
                    }
                }
            }
        }
    }

    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn read_host_device_id_impl() -> Option<String> {
    None
}

fn read_host_device_id() -> Option<String> {
    read_host_device_id_impl()
}

pub(crate) fn render_runtime_env_content(
    data_dir: &Path,
    existing: &std::collections::HashMap<String, String>,
) -> String {
    let root_folder_host = get_non_empty_env_value(existing, "ROOT_FOLDER_HOST")
        .map(|value| normalize_docker_host_path(&value))
        .unwrap_or_else(|| docker_bind_mount_path(data_dir));
    let jwt_secret =
        get_non_empty_env_value(existing, "JWT_SECRET").unwrap_or_else(|| generate_hex(64));
    let postgres_password =
        get_non_empty_env_value(existing, "POSTGRES_PASSWORD").unwrap_or_else(|| generate_hex(32));
    let rabbitmq_password = get_non_empty_env_value(existing, "RABBITMQ_PASSWORD")
        .filter(|value| value != "admin")
        .unwrap_or_else(|| generate_hex(32));
    // Tailscale sidecar: enable only with auth key or persisted state (see private_vpn_should_run).
    let vpn_on = private_vpn_enabled_from_map(existing);
    // When opted out, persist the sentinel; when enabled, omit it so the default applies.
    let private_vpn_user_disabled_line = if vpn_on {
        String::new()
    } else {
        "PRIVATE_VPN_USER_DISABLED=true\n".to_string()
    };
    let compose_profiles = merge_compose_profiles(existing, vpn_on);
    // Omit when empty: Compose treats unset COMPOSE_PROFILES like "", but a bare `COMPOSE_PROFILES=`
    // line is noisy and can unintentionally override a user-defined shell value with emptiness.
    let compose_profiles_line = if compose_profiles.is_empty() {
        String::new()
    } else {
        format!("COMPOSE_PROFILES={compose_profiles}\n")
    };

    // Inject a stable device ID from the host so the backend container always uses
    // the same host-level identity regardless of container restarts or recreation.
    let device_id_line = read_host_device_id()
        .map(|id| format!("DEVICE_ID={id}\n"))
        .unwrap_or_default();

    let domain = option_env!("CI_HUB_DOMAIN").unwrap_or(default_public_domain());
    let portal = resolve_portal_url_from_env(existing);
    log_portal_url_resolution(data_dir, existing, &portal);
    let cloud_url = portal.url.as_str();
    // Carried forward verbatim (even when refused) so a launch never erases what the operator
    // wrote. Omitted entirely when unset, which keeps the file identical to earlier builds.
    let portal_override_line = portal
        .raw_override
        .as_deref()
        .map(|raw| format!("{PORTAL_URL_OVERRIDE_KEY}={raw}\n"))
        .unwrap_or_default();
    let hub_image = resolve_runtime_hub_image(existing);
    // Make pin supersession observable in desktop.log. Most starts resolve to the same
    // reference already on disk and log nothing; a line here means a pin was dropped —
    // notably the stale, unpullable `ci-os-hub` references left by pre-#920 builds, which
    // are migrated to the public `ci-hub` repo on the next start.
    if let Some(previous_image) = existing.get("CI_HUB_IMAGE") {
        if previous_image != &hub_image {
            // Name which of the two outcomes happened, because they mean opposite things
            // when reading back a failed start: falling back to the build default means
            // the pin was rejected as unusable (foreign repo, stale ci-os-hub, or a tag
            // that is not a full version), whereas a normalized pin means the update was
            // honoured and only its spelling changed. Labelling both as the default sends
            // whoever is debugging looking for a discarded pin that never existed.
            let reason = if hub_image == default_hub_image() {
                "desktop build default"
            } else {
                "normalized pin"
            };
            let _ = append_desktop_log_for(
                data_dir,
                "hub.start",
                &format!(
                    "Superseding pinned stack image {previous_image} with {hub_image} ({reason})."
                ),
            );
        }
    }
    let hub_version = runtime_hub_version_for_image(&hub_image);
    let compose_file_host = docker_bind_mount_path(&data_dir.join(HUB_COMPOSE_FILENAME));
    let (docker_platform, target_arch) = if cfg!(target_arch = "aarch64") {
        ("linux/arm64", "arm64")
    } else {
        ("linux/amd64", "amd64")
    };
    let (container_uid, container_gid, docker_gid) = resolve_hub_container_identity();
    let docker_gid_line = format!("DOCKER_GID={docker_gid}\n");
    let sentry_dsn_line = get_non_empty_env_value(existing, "SENTRY_DSN")
        .map(|dsn| format!("SENTRY_DSN={dsn}\n"))
        .unwrap_or_default();
    let sentry_desktop_dsn_line = get_non_empty_env_value(existing, "SENTRY_DESKTOP_DSN")
        .or_else(|| option_env!("SENTRY_DESKTOP_DSN").map(|dsn| dsn.to_string()))
        .filter(|dsn| !dsn.trim().is_empty())
        .map(|dsn| format!("SENTRY_DESKTOP_DSN={dsn}\n"))
        .unwrap_or_default();
    let docker_socket_path = host_docker_socket_path();
    let docker_socket_path_line = format!(
        "DOCKER_SOCKET_PATH={}\n",
        normalize_docker_host_path(&docker_socket_path.to_string_lossy())
    );

    format!(
        "# Preserved (generated once, survive upgrades)\n\
         ROOT_FOLDER_HOST={root_folder_host}\n\
         JWT_SECRET={jwt_secret}\n\
         POSTGRES_PASSWORD={postgres_password}\n\
         RABBITMQ_PASSWORD={rabbitmq_password}\n\
         {portal_override_line}\
         \n\
         # Derived (recomputed every launch from the current binary)\n\
         INTERNAL_IP=0.0.0.0\n\
         DOMAIN={domain}\n\
         CI_CLOUD_URL={cloud_url}\n\
         CI_HUB_VERSION={hub_version}\n\
         CI_HUB_IMAGE={hub_image}\n\
         COMPOSE_FILE_HOST={compose_file_host}\n\
         DOCKER_PLATFORM={docker_platform}\n\
         TARGETARCH={target_arch}\n\
         {docker_socket_path_line}\
         {docker_gid_line}\
         CI_HUB_CONTAINER_UID={container_uid}\n\
         CI_HUB_CONTAINER_GID={container_gid}\n\
         {private_vpn_user_disabled_line}\
         {compose_profiles_line}\
         {device_id_line}\
         {sentry_desktop_dsn_line}\
         {sentry_dsn_line}",
        root_folder_host = root_folder_host,
        jwt_secret = jwt_secret,
        postgres_password = postgres_password,
        domain = domain,
        cloud_url = cloud_url,
        hub_version = hub_version,
        hub_image = hub_image,
        compose_file_host = compose_file_host,
        docker_socket_path_line = docker_socket_path_line,
        docker_platform = docker_platform,
        docker_gid_line = docker_gid_line,
        container_uid = container_uid,
        container_gid = container_gid,
        private_vpn_user_disabled_line = private_vpn_user_disabled_line,
        compose_profiles_line = compose_profiles_line,
        device_id_line = device_id_line,
        sentry_desktop_dsn_line = sentry_desktop_dsn_line,
        sentry_dsn_line = sentry_dsn_line,
    )
}

/// Portal URL the Hub in the default data dir uses, resolved the same way a launch resolves it.
pub(crate) fn effective_portal_url() -> String {
    let data_dir = get_hub_data_dir();
    let env_path = hub_env_path_for(&data_dir);
    resolve_portal_url_from_env(&load_runtime_env_values(&data_dir, &env_path)).url
}

/// Record the Portal decision in desktop.log, and warn when the Portal changes under a Hub
/// that still holds a registration issued by the previous one.
///
/// The backend keeps no record of which Portal issued its device key, tunnel token and
/// organization rows, so after a switch it keeps presenting them to the new Portal. The new
/// Portal answers check-in with 401 (unknown device key), which the backend counts toward
/// `degraded` rather than clearing the registration, and the tunnel keeps serving the old
/// Portal's hostname. The desktop is the one place that sees both URLs, so it says so here.
fn log_portal_url_resolution(
    data_dir: &Path,
    existing: &std::collections::HashMap<String, String>,
    portal: &PortalUrlResolution,
) {
    let compiled = compiled_ci_cloud_url();
    if let Some(reason) = portal.rejected.as_deref() {
        let message = format!(
            "Ignoring {PORTAL_URL_OVERRIDE_KEY} in the Hub env file: {reason}. Using this build's Portal {compiled}."
        );
        log::error!("{message}");
        let _ = append_desktop_log_for(data_dir, "hub.portal", &message);
    } else if portal.source == PortalUrlSource::Override {
        let message = format!(
            "Portal URL override active: CI_CLOUD_URL={} from {PORTAL_URL_OVERRIDE_KEY} (this build's Portal is {compiled}).",
            portal.url
        );
        log::warn!("{message}");
        let _ = append_desktop_log_for(data_dir, "hub.portal", &message);
    }

    let Some(previous) = get_non_empty_env_value(existing, "CI_CLOUD_URL") else {
        return;
    };
    if same_portal_url(&previous, &portal.url) || !hub_holds_portal_registration(data_dir, existing)
    {
        return;
    }
    let message = format!(
        "WARNING: Portal changed from {previous} to {url} while this Hub still holds a registration from a Portal (device key or tunnel token). \
         Registrations are issued per Portal, so {url} will reject the existing device key and the Hub will turn degraded. \
         Reset the Hub registration and pair again against {url}, or switch back to {previous}.",
        url = portal.url
    );
    log::warn!("{message}");
    let _ = append_desktop_log_for(data_dir, "hub.portal", &message);
}

/// Whether the data dir holds Portal-issued credentials: a device key in `state/settings.json`
/// (the file the backend reads) or a Cloudflare tunnel token.
pub(crate) fn hub_holds_portal_registration(
    data_dir: &Path,
    existing: &std::collections::HashMap<String, String>,
) -> bool {
    let host_data_dir = get_non_empty_env_value(existing, "ROOT_FOLDER_HOST")
        .map(|root| host_path_from_docker_path(&root))
        .unwrap_or_else(|| data_dir.to_path_buf());

    if tunnel_token_present_for_data_dir(&host_data_dir) {
        return true;
    }

    std::fs::read_to_string(host_data_dir.join("state").join("settings.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|settings| {
            settings
                .get("ciHubApiKey")
                .and_then(|key| key.as_str())
                .map(|key| !key.trim().is_empty())
        })
        .unwrap_or(false)
}

pub(crate) fn ensure_runtime_env_state(data_dir: &Path, env_path: &Path) -> Result<bool, String> {
    let existing = load_runtime_env_values(data_dir, env_path);
    let env_content = render_runtime_env_content(data_dir, &existing);
    let previous_content = std::fs::read_to_string(env_path).unwrap_or_default();
    let changed = strip_port_vars(&previous_content) != env_content;

    if changed {
        std::fs::write(env_path, &env_content).map_err(|e| {
            format!(
                "Failed to write runtime env file at {}: {}",
                env_path.display(),
                e
            )
        })?;
    }

    let compat_env_path = compat_hub_env_path_for(data_dir);
    if compat_env_path != env_path {
        let _ = std::fs::write(&compat_env_path, &env_content);
    }

    Ok(changed)
}

/// Generate a random hex string of the given byte length.
fn generate_hex(bytes: usize) -> String {
    (0..bytes)
        .map(|_| format!("{:02x}", rand::random::<u8>()))
        .collect()
}
