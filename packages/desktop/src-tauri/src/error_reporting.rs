use std::path::Path;
use std::sync::OnceLock;

static SENTRY_GUARD: OnceLock<sentry::ClientInitGuard> = OnceLock::new();

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

pub fn init_from_env(env_path: &Path, release: &str) {
    if SENTRY_GUARD.get().is_some() {
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
        send_default_pii: true,
        ..Default::default()
    });

    if guard.is_enabled() {
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

pub fn record_log_event(operation: &str, message: &str) {
    if SENTRY_GUARD.get().is_none() {
        return;
    }

    let level = if is_failure_message(message) {
        sentry::Level::Error
    } else {
        sentry::Level::Info
    };

    sentry::add_breadcrumb(sentry::Breadcrumb {
        category: Some(operation.to_string()),
        message: Some(truncate(message, 500)),
        level,
        ..Default::default()
    });

    if is_failure_message(message) {
        sentry::capture_message(
            &format!("{operation}: {}", truncate(message, 2000)),
            sentry::Level::Error,
        );
    }
}

pub fn capture_setup_failure(message: &str) {
    if SENTRY_GUARD.get().is_none() {
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
    use super::{parse_dsn, read_first_env_value};

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
}
