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

pub fn init_from_env(env_path: &Path, release: &str) {
    if SENTRY_GUARD.get().is_some() {
        return;
    }

    let dsn = read_env_value(env_path, "SENTRY_DSN")
        .or_else(|| std::env::var("SENTRY_DSN").ok())
        .filter(|value| !value.trim().is_empty());

    let Some(dsn) = dsn else {
        return;
    };

    let environment = std::env::var("SENTRY_ENV")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "production".to_string());

    let guard = sentry::init((
        dsn,
        sentry::ClientOptions {
            release: Some(format!("ci-hub-desktop-rust@{release}").into()),
            environment: Some(environment.into()),
            send_default_pii: false,
            ..Default::default()
        },
    ));

    if guard.is_enabled() {
        let _ = SENTRY_GUARD.set(guard);
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
