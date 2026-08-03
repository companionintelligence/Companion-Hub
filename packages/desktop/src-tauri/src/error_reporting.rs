use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

static SENTRY_GUARD: OnceLock<sentry::ClientInitGuard> = OnceLock::new();
static CAPTURED_LOG_EVENTS: OnceLock<Mutex<std::collections::HashMap<String, CaptureRecord>>> =
    OnceLock::new();
/// `<data_dir>/state/settings.json` — the same file the backend reads, so the
/// desktop shell and the Hub always agree about consent.
static SETTINGS_PATH: OnceLock<PathBuf> = OnceLock::new();
static CONSENT_CACHE: OnceLock<Mutex<Option<ConsentCache>>> = OnceLock::new();
/// How long a disk read of the consent switch is trusted before it is re-read.
const CONSENT_CACHE_TTL: Duration = Duration::from_secs(1);
const LOG_EVENT_DEBOUNCE_WINDOW: Duration = Duration::from_secs(300);
/// After this many captures of the same message, back off to the repeat window
/// so retry loops (e.g. the tray watchdog re-running a failing `start_hub`
/// every few minutes for days) can't flood Sentry with identical events.
const REPEAT_CAPTURE_LIMIT: u32 = 3;
const REPEAT_CAPTURE_WINDOW: Duration = Duration::from_secs(6 * 60 * 60);

struct CaptureRecord {
    message: String,
    last_captured: Instant,
    count: u32,
}

fn read_env_value(env_path: &Path, key: &str) -> Option<String> {
    let content = std::fs::read_to_string(env_path).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let (name, value) = trimmed.split_once('=')?;
        if name.trim() == key {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn read_first_env_value(env_path: &Path, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(value) = read_env_value(env_path, key) {
            return Some(value);
        }
    }

    for key in keys {
        if let Ok(value) = std::env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

fn read_device_id(env_path: &Path) -> Option<String> {
    read_first_env_value(env_path, &["DEVICE_ID"])
}

fn normalize_portal_url(value: &str) -> Option<String> {
    let normalized = value.trim().trim_end_matches('/');
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.to_string())
    }
}

fn read_portal_url(env_path: &Path) -> Option<String> {
    read_first_env_value(env_path, &["CI_CLOUD_URL"]).and_then(|value| normalize_portal_url(&value))
}

fn read_deployment_version(env_path: &Path, release: &str) -> Option<String> {
    read_first_env_value(env_path, &["CI_HUB_VERSION"]).or_else(|| {
        let normalized = release.trim();
        if normalized.is_empty() {
            None
        } else {
            Some(normalized.to_string())
        }
    })
}

fn read_hub_image(env_path: &Path) -> Option<String> {
    read_first_env_value(env_path, &["CI_HUB_IMAGE"])
}

/// Extract `:tag` from an image ref like `ghcr.io/org/ci-hub:v0.2.5` (not digests).
fn hub_image_tag(image: &str) -> Option<&str> {
    // Only inspect the final path segment so `localhost:5000/ci-hub:tag` works and
    // `repo@sha256:…` digests are ignored.
    let name = image.rsplit_once('/').map(|(_, name)| name).unwrap_or(image);
    if name.contains('@') {
        return None;
    }
    let (_, tag) = name.rsplit_once(':')?;
    let tag = tag.trim();
    if tag.is_empty() {
        None
    } else {
        Some(tag)
    }
}

fn portal_environment_for_url(url: &str) -> &'static str {
    match reqwest::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| host.to_string()))
        .as_deref()
    {
        Some("hub.companionintelligence.com") => "dev",
        Some("hub.ci.computer") => "prod",
        _ => "custom",
    }
}

/// The user's error-reporting choice, read from the Hub's `settings.json`.
///
/// `Unset` = no preference recorded yet (fresh install / key absent), which
/// under the opt-out posture means enabled. `Unreadable` = we tried and failed,
/// which means disabled — reporting against a decision we could not read is the
/// worse failure.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum UserConsent {
    Granted,
    Denied,
    Unset,
    Unreadable,
}

struct ConsentCache {
    value: UserConsent,
    read_at: Instant,
}

const FALSEY: [&str; 5] = ["off", "false", "0", "no", "disabled"];
const TRUTHY: [&str; 5] = ["on", "true", "1", "yes", "enabled"];

/// Settings file backing the consent switch, for a given Hub data directory.
fn settings_path_for(data_dir: &Path) -> PathBuf {
    data_dir.join("state").join("settings.json")
}

fn read_user_consent_from(settings_path: &Path) -> UserConsent {
    let raw = match std::fs::read_to_string(settings_path) {
        Ok(raw) => raw,
        // No settings file yet = a fresh appliance, not a failed read.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return UserConsent::Unset,
        Err(_) => return UserConsent::Unreadable,
    };

    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => return UserConsent::Unreadable,
    };

    if !parsed.is_object() {
        return UserConsent::Unreadable;
    }

    match parsed.get("allowErrorMonitoring") {
        None | Some(serde_json::Value::Null) => UserConsent::Unset,
        Some(serde_json::Value::Bool(true)) => UserConsent::Granted,
        Some(serde_json::Value::Bool(false)) => UserConsent::Denied,
        // Hand-edited or written by something that ignores the schema. Do not
        // guess what the user meant.
        Some(_) => UserConsent::Unreadable,
    }
}

/// Current consent, memoised for [`CONSENT_CACHE_TTL`] so a retry loop cannot
/// turn into a file read per event.
fn current_user_consent(now: Instant) -> UserConsent {
    let Some(settings_path) = SETTINGS_PATH.get() else {
        // init_from_env always sets this before Sentry can produce an event.
        return UserConsent::Unreadable;
    };

    let cache = CONSENT_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = match cache.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    if let Some(entry) = guard.as_ref() {
        if now.duration_since(entry.read_at) < CONSENT_CACHE_TTL {
            return entry.value;
        }
    }

    let value = read_user_consent_from(settings_path);
    *guard = Some(ConsentCache {
        value,
        read_at: now,
    });
    value
}

/// The `before_send` gate. Re-evaluated per event, which is what lets a user
/// who turns the switch off in Settings stop desktop reporting without
/// restarting the app.
fn reporting_allowed() -> bool {
    matches!(
        current_user_consent(Instant::now()),
        UserConsent::Granted | UserConsent::Unset
    )
}

/// Env-level kill switches, honoured identically across the fleet. Static for
/// the lifetime of the process, so an opted-out run never initialises Sentry at
/// all rather than gating each event.
fn env_telemetry_block(env_path: &Path) -> Option<&'static str> {
    if let Some(value) = read_first_env_value(env_path, &["CI_LOCAL_ONLY"]) {
        if TRUTHY.contains(&value.trim().to_ascii_lowercase().as_str()) {
            return Some("local-only");
        }
    }

    if let Some(value) = read_first_env_value(env_path, &["CI_TELEMETRY"]) {
        if FALSEY.contains(&value.trim().to_ascii_lowercase().as_str()) {
            return Some("opt-out");
        }
    }

    None
}

pub fn init_from_env(env_path: &Path, data_dir: &Path, release: &str) {
    if SENTRY_GUARD.get().is_some() {
        return;
    }

    // Set before any capture can happen: `before_send` reads this to answer the
    // consent question, and a missing path fails closed.
    let _ = SETTINGS_PATH.set(settings_path_for(data_dir));

    // `CI_LOCAL_ONLY` / `CI_TELEMETRY` cannot change without a restart, so an
    // opted-out process should never construct a transport. The *user's* switch
    // is deliberately gated in `before_send` instead, so a mid-session flip
    // works in both directions.
    if env_telemetry_block(env_path).is_some() {
        return;
    }

    let dsn = read_first_env_value(env_path, &["SENTRY_DESKTOP_DSN", "SENTRY_DSN"]).or_else(|| {
        option_env!("SENTRY_DESKTOP_DSN")
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.to_string())
    });

    let Some(dsn) = dsn else {
        return;
    };

    let environment = read_first_env_value(env_path, &["SENTRY_ENV", "CI_HUB_ENVIRONMENT"])
        .or_else(|| {
            option_env!("CI_HUB_ENVIRONMENT")
                .filter(|value| !value.trim().is_empty())
                .map(|value| value.to_string())
        })
        .unwrap_or_else(|| "production".to_string());

    // Parse the DSN ourselves instead of handing the raw string to
    // `sentry::init`. The `(dsn, options)` tuple form parses internally with
    // `.expect("invalid value for DSN")`, so a malformed or placeholder DSN
    // makes `sentry::init` PANIC. That panic runs inside the Tauri setup
    // closure (and the headless bootstrap), aborting startup *before* the Hub
    // is launched — a bad DSN baked into a release would silently stop the Hub
    // from ever starting. Degrade gracefully: skip error reporting and let the
    // app continue. Error reporting must never take down the app it observes.
    let Some(parsed_dsn) = parse_dsn(&dsn) else {
        return;
    };

    let guard = sentry::init(sentry::ClientOptions {
        dsn: Some(parsed_dsn),
        release: Some(format!("ci-hub-desktop-rust@{release}").into()),
        environment: Some(environment.into()),
        // No PII, matching the rest of the fleet. The Sentry org has
        // `scrubIPAddresses` disabled, so leaving this on meant the Hub was the
        // one component storing users' real IP addresses. Device attribution
        // comes from the explicit `device_id` tag/user set below.
        send_default_pii: false,
        // Consent gate. Evaluated per event so turning "Allow error monitoring"
        // off in Settings stops the very next capture, with no app restart.
        before_send: Some(Arc::new(|event| {
            if reporting_allowed() {
                Some(event)
            } else {
                None
            }
        })),
        ..Default::default()
    });

    if guard.is_enabled() {
        sentry::configure_scope(|scope| {
            if let Some(device_id) = read_device_id(env_path) {
                scope.set_tag("device_id", device_id.clone());
                scope.set_user(Some(sentry::User {
                    id: Some(device_id),
                    ..Default::default()
                }));
            }
            if let Some(portal_url) = read_portal_url(env_path) {
                scope.set_tag("ci_portal_url", portal_url.clone());
                scope.set_tag(
                    "ci_portal_environment",
                    portal_environment_for_url(&portal_url),
                );
            }
            if let Some(deployment_version) = read_deployment_version(env_path, release) {
                scope.set_tag("deployment_version", deployment_version);
            }
            if let Some(hub_image) = read_hub_image(env_path) {
                if let Some(image_tag) = hub_image_tag(&hub_image) {
                    scope.set_tag("hub_image_tag", image_tag.to_string());
                }
                scope.set_tag("hub_image", hub_image);
            }
        });
        let _ = SENTRY_GUARD.set(guard);
    }
}

/// Parse a Sentry DSN string into a [`sentry::types::Dsn`], returning `None`
/// (instead of panicking like `sentry::init`'s tuple form) when the value is
/// empty or malformed.
fn parse_dsn(raw: &str) -> Option<sentry::types::Dsn> {
    match raw.trim().parse::<sentry::types::Dsn>() {
        Ok(dsn) => Some(dsn),
        Err(error) => {
            eprintln!("warning: ignoring malformed Sentry DSN: {error}");
            None
        }
    }
}

fn is_failure_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("failed")
        || lower.contains("error")
        || lower.contains("panic")
        || lower.contains("auto-start failed")
}

fn is_warning_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("warning")
        || lower.contains("warn:")
        || lower.contains("falling back")
        || lower.contains("fallback")
        || lower.contains("non-fatal")
        || lower.contains("retrying")
        || lower.contains("degraded")
        || lower.contains("stuck")
        || lower.contains("could not")
}

/// Successful operations whose command output happens to contain scary words
/// ("level=warning …" from docker compose, for example) must never become
/// Sentry events. Failure keywords win over success keywords, so wrapper
/// messages like "Watchdog start_hub failed: docker compose up -d succeeded
/// but Hub did not become ready" still classify as errors.
fn is_success_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("succeeded") || lower.contains("successful")
}

fn classify_log_level(message: &str) -> sentry::Level {
    if is_failure_message(message) {
        sentry::Level::Error
    } else if is_success_message(message) {
        sentry::Level::Info
    } else if is_warning_message(message) {
        sentry::Level::Warning
    } else {
        sentry::Level::Info
    }
}

fn is_benign_hub_start_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("recreate was requested, but no existing traefik container was present")
        || ((lower.contains("no such container") || lower.contains("no such object"))
            && lower.contains("traefik"))
        || is_benign_compose_optional_env_warning(&lower)
}

/// Docker Compose warns when optional VPN keys are unset even though the feature
/// is intentionally disabled until the user configures Tailscale.
fn is_benign_compose_optional_env_warning(lower: &str) -> bool {
    if !lower.contains("defaulting to a blank string") {
        return false;
    }

    lower.contains("tailscale_authkey") || lower.contains("headscale_preauth_key")
}

fn should_capture_log_event(operation: &str, message: &str) -> bool {
    if is_benign_hub_start_message(message) {
        return false;
    }

    let cache = CAPTURED_LOG_EVENTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()));
    let mut events = cache.lock().expect("captured log events mutex poisoned");
    should_capture_with(&mut events, operation, message, Instant::now())
}

/// Capture decision, factored out of the global cache for testability.
///
/// Suppresses:
/// - exact repeats within [`LOG_EVENT_DEBOUNCE_WINDOW`], backing off to
///   [`REPEAT_CAPTURE_WINDOW`] after [`REPEAT_CAPTURE_LIMIT`] captures;
/// - wrapper duplicates: callers like the tray watchdog re-log the same error
///   `start_hub`/`stop_hub` just reported ("Watchdog start_hub failed: {err}"),
///   which used to send every hub failure to Sentry two or three times. If a
///   recently captured message is contained in the new one (or vice versa),
///   the new one is only kept as a breadcrumb.
fn should_capture_with(
    events: &mut std::collections::HashMap<String, CaptureRecord>,
    operation: &str,
    message: &str,
    now: Instant,
) -> bool {
    let normalized_message = message.trim().to_ascii_lowercase();
    let key = format!("{}:{}", operation.trim().to_ascii_lowercase(), normalized_message);

    events.retain(|_, record| now.duration_since(record.last_captured) < REPEAT_CAPTURE_WINDOW);

    if let Some(record) = events.get_mut(&key) {
        let window = if record.count >= REPEAT_CAPTURE_LIMIT {
            REPEAT_CAPTURE_WINDOW
        } else {
            LOG_EVENT_DEBOUNCE_WINDOW
        };
        if now.duration_since(record.last_captured) < window {
            return false;
        }
        record.last_captured = now;
        record.count += 1;
        return true;
    }

    let is_wrapper_duplicate = events.values().any(|record| {
        now.duration_since(record.last_captured) < LOG_EVENT_DEBOUNCE_WINDOW
            && !record.message.is_empty()
            && (normalized_message.contains(&record.message)
                || record.message.contains(&normalized_message))
    });
    if is_wrapper_duplicate {
        return false;
    }

    events.insert(
        key,
        CaptureRecord {
            message: normalized_message,
            last_captured: now,
            count: 1,
        },
    );
    true
}

/// Normalize a message for Sentry grouping. Sentry groups `capture_message`
/// events by message text, so host-specific fragments (docker socket paths,
/// home directories, ports, PIDs, timestamps) used to fragment one root cause
/// — e.g. "cannot connect to the Docker daemon at unix:///Users/<name>/…" —
/// into a separate issue per machine. Paths and digits are stripped before
/// the text is used as the fingerprint.
fn grouping_fingerprint(message: &str) -> String {
    let without_paths = message
        .split_whitespace()
        .map(|token| {
            if token.contains('/') || token.contains('\\') {
                "<path>"
            } else {
                token
            }
        })
        .collect::<Vec<_>>()
        .join(" ");

    let mut normalized: String = without_paths
        .chars()
        .filter(|c| !c.is_ascii_digit())
        .collect::<String>()
        .to_ascii_lowercase();
    normalized.truncate(200);
    normalized
}

pub fn record_log_event(operation: &str, message: &str) {
    if SENTRY_GUARD.get().is_none() {
        return;
    }

    // `before_send` is the backstop; short-circuiting here also keeps the
    // capture-debounce state clean while the user has reporting turned off.
    if !reporting_allowed() {
        return;
    }

    let level = classify_log_level(message);

    sentry::add_breadcrumb(sentry::Breadcrumb {
        category: Some(operation.to_string()),
        message: Some(truncate(message, 500)),
        level,
        ..Default::default()
    });

    if level != sentry::Level::Info && should_capture_log_event(operation, message) {
        let fingerprint = grouping_fingerprint(message);
        sentry::with_scope(
            |scope| scope.set_fingerprint(Some(&[operation, fingerprint.as_str()])),
            || {
                sentry::capture_message(
                    &format!("{operation}: {}", truncate(message, 2000)),
                    level,
                );
            },
        );
    }
}

pub fn capture_setup_failure(message: &str) {
    if SENTRY_GUARD.get().is_none() {
        return;
    }

    if !reporting_allowed() {
        return;
    }

    sentry::capture_message(
        &format!("desktop setup failed: {message}"),
        sentry::Level::Fatal,
    );

    // The client guard lives in a `static OnceLock` and is never dropped, so a
    // fatal setup failure that precedes process exit would otherwise lose its
    // event. Flush the background transport explicitly before we return.
    flush(std::time::Duration::from_secs(2));
}

/// Best-effort flush of the Sentry background transport. No-op when Sentry is
/// not configured. Safe to call before an imminent process exit.
pub fn flush(timeout: std::time::Duration) {
    if let Some(client) = sentry::Hub::current().client() {
        client.flush(Some(timeout));
    }
}

fn truncate(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }
    format!(
        "{}… [truncated]",
        value.chars().take(max_len).collect::<String>()
    )
}

#[cfg(test)]
mod tests {
    use super::{
        classify_log_level, env_telemetry_block, grouping_fingerprint,
        is_benign_compose_optional_env_warning, is_benign_hub_start_message, normalize_portal_url,
        parse_dsn, portal_environment_for_url, read_user_consent_from, settings_path_for,
        hub_image_tag, read_deployment_version, read_device_id, read_first_env_value, read_hub_image,
        read_portal_url,
        should_capture_with, CaptureRecord, UserConsent, LOG_EVENT_DEBOUNCE_WINDOW,
        REPEAT_CAPTURE_LIMIT,
    };
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    /// Write a settings.json under a fresh temp data dir and return both paths.
    fn settings_fixture(contents: Option<&str>) -> (tempfile::TempDir, std::path::PathBuf) {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let path = settings_path_for(tempdir.path());
        if let Some(contents) = contents {
            std::fs::create_dir_all(path.parent().expect("state dir")).expect("mkdir state");
            std::fs::write(&path, contents).expect("write settings");
        }
        (tempdir, path)
    }

    #[test]
    fn consent_switch_is_read_from_hub_settings() {
        let (_dir, path) = settings_fixture(Some(r#"{"allowErrorMonitoring": true}"#));
        assert_eq!(read_user_consent_from(&path), UserConsent::Granted);

        let (_dir, path) = settings_fixture(Some(r#"{"allowErrorMonitoring": false}"#));
        assert_eq!(read_user_consent_from(&path), UserConsent::Denied);
    }

    #[test]
    fn absent_settings_or_key_takes_the_opt_out_default() {
        // Fresh appliance: no file at all.
        let (_dir, path) = settings_fixture(None);
        assert_eq!(read_user_consent_from(&path), UserConsent::Unset);

        // File exists but the user has never touched the switch.
        let (_dir, path) = settings_fixture(Some(r#"{"themeColor": "blue"}"#));
        assert_eq!(read_user_consent_from(&path), UserConsent::Unset);
    }

    #[test]
    fn malformed_settings_fail_closed() {
        for contents in [
            "{ not json",
            "[]",
            "\"a string\"",
            r#"{"allowErrorMonitoring": "yes"}"#,
            r#"{"allowErrorMonitoring": 1}"#,
        ] {
            let (_dir, path) = settings_fixture(Some(contents));
            assert_eq!(
                read_user_consent_from(&path),
                UserConsent::Unreadable,
                "expected {contents:?} to fail closed"
            );
        }
    }

    #[test]
    fn env_kill_switches_block_initialisation() {
        let tempdir = tempfile::tempdir().expect("tempdir");

        let local_only = tempdir.path().join("local-only.env");
        std::fs::write(&local_only, "CI_LOCAL_ONLY=true\n").expect("write env");
        assert_eq!(env_telemetry_block(&local_only), Some("local-only"));

        let opted_out = tempdir.path().join("opt-out.env");
        std::fs::write(&opted_out, "CI_TELEMETRY=off\n").expect("write env");
        assert_eq!(env_telemetry_block(&opted_out), Some("opt-out"));

        // Local-only wins over an otherwise-enabling CI_TELEMETRY.
        let both = tempdir.path().join("both.env");
        std::fs::write(&both, "CI_LOCAL_ONLY=1\nCI_TELEMETRY=on\n").expect("write env");
        assert_eq!(env_telemetry_block(&both), Some("local-only"));

        let neither = tempdir.path().join("neither.env");
        std::fs::write(&neither, "CI_TELEMETRY=on\n").expect("write env");
        assert_eq!(env_telemetry_block(&neither), None);

        // Absent switches leave the DSN in charge.
        let empty = tempdir.path().join("empty.env");
        std::fs::write(&empty, "SENTRY_DSN=https://public@example.invalid/1\n").expect("write env");
        assert_eq!(env_telemetry_block(&empty), None);
    }

    #[test]
    fn rejects_malformed_dsn_without_panicking() {
        assert!(parse_dsn("not-a-dsn").is_none());
        assert!(parse_dsn("").is_none());
        assert!(parse_dsn("   ").is_none());
        // Looks URL-ish but is missing the public key / project id.
        assert!(parse_dsn("https://example.ingest.sentry.io").is_none());
    }

    #[test]
    fn accepts_well_formed_dsn() {
        assert!(parse_dsn("https://public@o123.ingest.sentry.io/456").is_some());
        // Surrounding whitespace is tolerated.
        assert!(parse_dsn("  https://public@o123.ingest.sentry.io/456\n").is_some());
    }

    #[test]
    fn prefers_desktop_specific_env_key() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let env_path = tempdir.path().join("hub.env");
        std::fs::write(
            &env_path,
            "SENTRY_DSN=https://backend@example.invalid/1\nSENTRY_DESKTOP_DSN=https://desktop@example.invalid/2\n",
        )
        .expect("write env");

        let value = read_first_env_value(&env_path, &["SENTRY_DESKTOP_DSN", "SENTRY_DSN"]);
        assert_eq!(value.as_deref(), Some("https://desktop@example.invalid/2"));
    }

    #[test]
    fn reads_device_id_from_env_file() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let env_path = tempdir.path().join("hub.env");
        std::fs::write(&env_path, "DEVICE_ID=device-123\n").expect("write env");

        let value = read_device_id(&env_path);
        assert_eq!(value.as_deref(), Some("device-123"));
    }

    #[test]
    fn reads_normalized_portal_url_from_env_file() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let env_path = tempdir.path().join("hub.env");
        std::fs::write(&env_path, "CI_CLOUD_URL=https://hub.ci.computer/\n").expect("write env");

        let value = read_portal_url(&env_path);
        assert_eq!(value.as_deref(), Some("https://hub.ci.computer"));
    }

    #[test]
    fn classifies_known_portal_urls() {
        assert_eq!(
            portal_environment_for_url("https://hub.companionintelligence.com"),
            "dev"
        );
        assert_eq!(
            portal_environment_for_url("https://hub.ci.computer"),
            "prod"
        );
        assert_eq!(
            portal_environment_for_url("https://portal.example.com"),
            "custom"
        );
    }

    #[test]
    fn prefers_env_deployment_version_over_release_fallback() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let env_path = tempdir.path().join("hub.env");
        std::fs::write(&env_path, "CI_HUB_VERSION=v0.2.27\n").expect("write env");

        let value = read_deployment_version(&env_path, "v0.0.0");
        assert_eq!(value.as_deref(), Some("v0.2.27"));
    }

    #[test]
    fn reads_hub_image_and_parses_tag() {
        let tempdir = tempfile::tempdir().expect("tempdir");
        let env_path = tempdir.path().join("hub.env");
        std::fs::write(
            &env_path,
            "CI_HUB_IMAGE=ghcr.io/companionintelligence/ci-hub:v0.2.27\n",
        )
        .expect("write env");

        assert_eq!(
            read_hub_image(&env_path).as_deref(),
            Some("ghcr.io/companionintelligence/ci-hub:v0.2.27")
        );
        assert_eq!(
            hub_image_tag("ghcr.io/companionintelligence/ci-hub:v0.2.27"),
            Some("v0.2.27")
        );
        assert_eq!(hub_image_tag("ghcr.io/companionintelligence/ci-hub"), None);
        assert_eq!(
            hub_image_tag("ghcr.io/companionintelligence/ci-hub@sha256:abc"),
            None
        );
    }

    #[test]
    fn normalizes_portal_url() {
        assert_eq!(
            normalize_portal_url(" https://hub.ci.computer/ "),
            Some("https://hub.ci.computer".to_string())
        );
        assert_eq!(normalize_portal_url("   "), None);
    }

    #[test]
    fn classifies_recoverable_messages_as_warning() {
        assert_eq!(
            classify_log_level("Pre-start cleanup warning (non-fatal): test"),
            sentry::Level::Warning
        );
        assert_eq!(
            classify_log_level("Tailscale Services failed, falling back to path-based"),
            sentry::Level::Error
        );
        assert_eq!(
            classify_log_level("warning: could not chmod file"),
            sentry::Level::Warning
        );
        assert_eq!(classify_log_level("startup complete"), sentry::Level::Info);
    }

    #[test]
    fn suppresses_benign_traefik_absence_messages_from_sentry_capture() {
        assert!(is_benign_hub_start_message(
            "Removed existing Traefik container before recreate. Error response from daemon: No such container: traefik"
        ));
        assert!(is_benign_hub_start_message(
            "Traefik recreate was requested, but no existing Traefik container was present."
        ));
        assert!(!is_benign_hub_start_message(
            "Failed to remove the existing Traefik container before recreate. permission denied"
        ));
    }

    #[test]
    fn classifies_success_messages_as_info_even_with_embedded_warnings() {
        // docker compose prints `level=warning msg=…` on success; those used
        // to ship to Sentry as warning events.
        assert_eq!(
            classify_log_level(
                r#"docker compose pull succeeded. time="2026-07-30T10:22:43-07:00" level=warning msg="The \"FOO\" variable is not set.""#
            ),
            sentry::Level::Info
        );
        assert_eq!(
            classify_log_level("Stale container cleanup succeeded. level=warning msg=…"),
            sentry::Level::Info
        );
        // Failure keywords win over success keywords.
        assert_eq!(
            classify_log_level(
                "Watchdog start_hub failed: docker compose up -d succeeded but Hub did not become ready"
            ),
            sentry::Level::Error
        );
    }

    #[test]
    fn suppresses_wrapper_duplicates_of_recently_captured_errors() {
        let mut events: HashMap<String, CaptureRecord> = HashMap::new();
        let now = Instant::now();

        let inner = "Database bootstrap failed. open /home/ci/.local/share/companion-hub/docker-compose.prod.yml: no such file or directory";
        assert!(should_capture_with(&mut events, "hub.start", inner, now));

        // The watchdog re-logs the same error wrapped with prefix and suffix.
        let wrapped = format!("Watchdog start_hub failed: {inner} Open tray → View Logs for details.");
        assert!(!should_capture_with(
            &mut events,
            "tray.watchdog",
            &wrapped,
            now + Duration::from_secs(1)
        ));

        // A genuinely different error is still captured.
        assert!(should_capture_with(
            &mut events,
            "tray.watchdog",
            "Watchdog container restart failed: docker restart ci-os-hub failed: permission denied",
            now + Duration::from_secs(2)
        ));
    }

    #[test]
    fn backs_off_after_repeated_captures_of_the_same_failure() {
        let mut events: HashMap<String, CaptureRecord> = HashMap::new();
        let mut now = Instant::now();
        let message = "Traefik recreate preparation failed: cannot connect to the Docker daemon";

        // The first N captures pass with the normal debounce between them…
        for _ in 0..REPEAT_CAPTURE_LIMIT {
            assert!(should_capture_with(&mut events, "hub.start", message, now));
            now += LOG_EVENT_DEBOUNCE_WINDOW + Duration::from_secs(1);
        }

        // …after which the same failure is suppressed even past the debounce
        // window (the watchdog retry loop used to send 186 identical events).
        assert!(!should_capture_with(&mut events, "hub.start", message, now));
    }

    #[test]
    fn grouping_fingerprint_strips_host_specific_fragments() {
        let mac = "Failed to remove the existing Traefik container before recreate. Cannot connect to the Docker daemon at unix:///Users/bennett/.docker/run/docker.sock. Is the docker daemon running?";
        let linux = "Failed to remove the existing Traefik container before recreate. Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
        assert_eq!(grouping_fingerprint(mac), grouping_fingerprint(linux));

        let port_a = "ports are not available: exposing port TCP 0.0.0.0:8642";
        let port_b = "ports are not available: exposing port TCP 0.0.0.0:3000";
        assert_eq!(grouping_fingerprint(port_a), grouping_fingerprint(port_b));

        assert_ne!(
            grouping_fingerprint("Database bootstrap failed."),
            grouping_fingerprint("Traefik recreate preparation failed.")
        );
    }

    #[test]
    fn suppresses_benign_tailscale_authkey_compose_warning_from_sentry_capture() {
        assert!(is_benign_hub_start_message(
            r#"docker compose up -d succeeded. time="2026-06-28T11:57:10+05:00" level=warning msg="The \"TAILSCALE_AUTHKEY\" variable is not set. Defaulting to a blank string.""#
        ));
        assert!(is_benign_compose_optional_env_warning(
            r#"level=warning msg="the \"headscale_preauth_key\" variable is not set. defaulting to a blank string.""#
        ));
        assert!(!is_benign_compose_optional_env_warning(
            r#"level=warning msg="the \"api_port\" variable is not set. defaulting to a blank string.""#
        ));
    }
}
