//! `before_send` / `before_breadcrumb` payload scrubber for the desktop shell.
//!
//! The Rust shell had no scrubber at all, and it is the component with the
//! worst raw material: `record_log_event` forwards Hub/Docker/Compose output
//! straight into the Sentry issue *title*, and that text routinely contains
//! home directories with the OS account name — the repo's own test fixture is
//! `"Cannot connect to the Docker daemon at unix:///Users/<name>/.docker/…"`.
//! `grouping_fingerprint` already strips paths and digits, but only for the
//! fingerprint; the transmitted message kept them.
//!
//! Kept in lockstep with the two JS copies:
//!   - `packages/backend/src/core/error-reporting/sentry-scrubber.ts`
//!   - `packages/frontend/src/lib/sentry-scrubber.ts`
//! Duplicated rather than shared because they live in separate build graphs;
//! change all three together.

use std::sync::OnceLock;

use regex::Regex;
use sentry::protocol::{Breadcrumb, Event, Value};

const MAX_STRING_LENGTH: usize = 8000;

struct Patterns {
    /// Windows first: the macOS pattern also matches the `/Users/<name>` inside
    /// `C:/Users/<name>`, and replacing that leaves a stranded `C:~/…` with the
    /// drive letter still attached. The longest-prefix forms have to win.
    home_paths: Vec<Regex>,
    application_support: Regex,
    secrets: Vec<Regex>,
    sensitive_key: Regex,
    identity_key: Regex,
}

fn patterns() -> &'static Patterns {
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();

    PATTERNS.get_or_init(|| Patterns {
        home_paths: vec![
            Regex::new(r"[A-Za-z]:\\Users\\[^\\/\s]+").expect("windows backslash home pattern"),
            Regex::new(r"[A-Za-z]:/Users/[^/\s]+").expect("windows forward-slash home pattern"),
            Regex::new(r"/Users/[^/\s]+").expect("macos home pattern"),
            Regex::new(r"/home/[^/\s]+").expect("linux home pattern"),
        ],
        application_support: Regex::new(r"Library/Application Support/[^\s]+")
            .expect("application support pattern"),
        secrets: vec![
            Regex::new(r"(?i)Bearer\s+[A-Za-z0-9\-._~+/]+=*").expect("bearer pattern"),
            Regex::new(r#"(?i)(?:api[-_ ]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+"#)
                .expect("credential pattern"),
            Regex::new(r"(?i)tskey-[A-Za-z0-9-]+").expect("tailscale key pattern"),
            // Postgres/Redis/AMQP URLs carry credentials in the authority section.
            Regex::new(r"(?i)\b[a-z][a-z0-9+.-]*://[^\s:@/]+:[^\s@/]+@")
                .expect("url credential pattern"),
        ],
        sensitive_key: Regex::new(
            r"(?i)password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_]?key|signature",
        )
        .expect("sensitive key pattern"),
        // Anchored on purpose: `user-agent`, `user_id` and `owner_id` are
        // diagnostic signal worth keeping, and a naive `user|owner` eats all three.
        identity_key: Regex::new(r"(?i)(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-")
            .expect("identity key pattern"),
    })
}

fn is_sensitive_key(key: &str) -> bool {
    let patterns = patterns();
    patterns.sensitive_key.is_match(key) || patterns.identity_key.is_match(key)
}

/// Collapse home directories, redact credentials, and cap length.
pub fn scrub_string(value: &str) -> String {
    let patterns = patterns();
    let mut scrubbed = value.to_string();

    for pattern in &patterns.home_paths {
        scrubbed = pattern.replace_all(&scrubbed, "~").into_owned();
    }

    scrubbed = patterns
        .application_support
        .replace_all(&scrubbed, "…/Application Support/…")
        .into_owned();

    for pattern in &patterns.secrets {
        scrubbed = pattern.replace_all(&scrubbed, "[Filtered]").into_owned();
    }

    if scrubbed.chars().count() > MAX_STRING_LENGTH {
        let truncated: String = scrubbed.chars().take(MAX_STRING_LENGTH).collect();
        return format!("{truncated}… [truncated]");
    }

    scrubbed
}

/// Strip query and hash. Plain split rather than a URL parse: it leaves the
/// origin and path exactly as written and cannot fail.
pub fn scrub_url(url: &str) -> String {
    let end = url.find(['?', '#']).unwrap_or(url.len());
    url[..end].to_string()
}

/// Walk a JSON value, redacting sensitive KEYS and scrubbing every string.
fn scrub_value(value: &Value, depth: usize) -> Value {
    // Guard against deep structures — a runaway walk in before_send would stall
    // the reporting path on every captured error.
    if depth > 8 {
        return Value::String("[Truncated]".to_string());
    }

    match value {
        Value::String(text) => Value::String(scrub_string(text)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| scrub_value(item, depth + 1))
                .collect(),
        ),
        Value::Object(entries) => Value::Object(
            entries
                .iter()
                .map(|(key, nested)| {
                    let scrubbed = if is_sensitive_key(key) {
                        Value::String("[Filtered]".to_string())
                    } else {
                        scrub_value(nested, depth + 1)
                    };
                    (key.clone(), scrubbed)
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Breadcrumb `data` keys whose value is a URL.
const URL_VALUED_KEYS: [&str; 3] = ["url", "from", "to"];
/// Breadcrumb `data` keys that are a bare query string or fragment.
const QUERY_VALUED_KEYS: [&str; 2] = ["http.query", "http.fragment"];

/// Scrub one breadcrumb in place.
///
/// `data` entries go through the key check as well as the value scrub: a bare
/// `data.token` matches no secret pattern, so the key is the only signal.
pub fn scrub_breadcrumb(mut breadcrumb: Breadcrumb) -> Breadcrumb {
    if let Some(message) = &breadcrumb.message {
        breadcrumb.message = Some(scrub_string(message));
    }

    let scrubbed_data = breadcrumb
        .data
        .iter()
        .map(|(key, value)| {
            let scrubbed = if is_sensitive_key(key) {
                Value::String("[Filtered]".to_string())
            } else if QUERY_VALUED_KEYS.contains(&key.as_str()) {
                Value::String("[Filtered]".to_string())
            } else if URL_VALUED_KEYS.contains(&key.as_str()) {
                match value {
                    Value::String(text) => Value::String(scrub_url(text)),
                    other => scrub_value(other, 1),
                }
            } else {
                scrub_value(value, 1)
            };
            (key.clone(), scrubbed)
        })
        .collect();

    breadcrumb.data = scrubbed_data;
    breadcrumb
}

/// The `before_send` scrubber. Mutates and returns the event.
pub fn scrub_event(mut event: Event<'static>) -> Event<'static> {
    if let Some(message) = &event.message {
        event.message = Some(scrub_string(message));
    }

    if let Some(logentry) = &mut event.logentry {
        logentry.message = scrub_string(&logentry.message);
        logentry.params = logentry
            .params
            .iter()
            .map(|param| scrub_value(param, 0))
            .collect();
    }

    if let Some(culprit) = &event.culprit {
        event.culprit = Some(scrub_string(culprit));
    }

    if let Some(transaction) = &event.transaction {
        event.transaction = Some(scrub_string(transaction));
    }

    for exception in &mut event.exception.values {
        if let Some(value) = &exception.value {
            exception.value = Some(scrub_string(value));
        }

        if let Some(stacktrace) = &mut exception.stacktrace {
            for frame in &mut stacktrace.frames {
                if let Some(filename) = &frame.filename {
                    frame.filename = Some(scrub_string(filename));
                }
                if let Some(abs_path) = &frame.abs_path {
                    frame.abs_path = Some(scrub_string(abs_path));
                }
                if let Some(context_line) = &frame.context_line {
                    frame.context_line = Some(scrub_string(context_line));
                }
                frame.pre_context = frame.pre_context.iter().map(|l| scrub_string(l)).collect();
                frame.post_context = frame.post_context.iter().map(|l| scrub_string(l)).collect();
                frame.vars = frame
                    .vars
                    .iter()
                    .map(|(key, value)| {
                        let scrubbed = if is_sensitive_key(key) {
                            Value::String("[Filtered]".to_string())
                        } else {
                            scrub_value(value, 1)
                        };
                        (key.clone(), scrubbed)
                    })
                    .collect();
            }
        }
    }

    event.extra = event
        .extra
        .iter()
        .map(|(key, value)| {
            let scrubbed = if is_sensitive_key(key) {
                Value::String("[Filtered]".to_string())
            } else {
                scrub_value(value, 1)
            };
            (key.clone(), scrubbed)
        })
        .collect();

    // The `contexts` feature fills `options.server_name` from `hostname::get()`
    // at init, and sentry-core stamps it onto the event in `prepare_event` —
    // which runs immediately BEFORE this callback. Personal machines are
    // routinely named after their owner ("liams-macbook"), which is exactly the
    // identifier the `device_id` tag exists to replace.
    event.server_name = None;

    if let Some(user) = &mut event.user {
        // `user.id` is our device_id and is the identifier we intend to send.
        user.ip_address = None;
        user.email = None;
        user.username = None;
        user.other = user
            .other
            .iter()
            .filter(|(key, _)| !is_sensitive_key(key))
            .map(|(key, value)| (key.clone(), scrub_value(value, 1)))
            .collect();
    }

    if let Some(request) = &mut event.request {
        request.cookies = None;
        request.data = None;
        request.query_string = None;

        if let Some(url) = &request.url {
            if let Ok(parsed) = scrub_url(url.as_str()).parse() {
                request.url = Some(parsed);
            }
        }

        request.headers = request
            .headers
            .iter()
            .map(|(key, value)| {
                let scrubbed = if is_sensitive_key(key) {
                    "[Filtered]".to_string()
                } else if matches!(
                    key.to_ascii_lowercase().as_str(),
                    "referer" | "referrer" | "location"
                ) {
                    scrub_url(value)
                } else {
                    scrub_string(value)
                };
                (key.clone(), scrubbed)
            })
            .collect();
    }

    let scrubbed_breadcrumbs: Vec<Breadcrumb> = event
        .breadcrumbs
        .values
        .drain(..)
        .map(scrub_breadcrumb)
        .collect();
    event.breadcrumbs.values = scrubbed_breadcrumbs;

    event
}

#[cfg(test)]
mod tests {
    use super::{scrub_breadcrumb, scrub_event, scrub_string, scrub_url};
    use sentry::protocol::{Breadcrumb, Event, Value};

    #[test]
    fn collapses_home_directories_including_windows() {
        assert_eq!(
            scrub_string(
                "Cannot connect to the Docker daemon at unix:///Users/liam/.docker/run/docker.sock"
            ),
            "Cannot connect to the Docker daemon at unix://~/.docker/run/docker.sock"
        );
        assert_eq!(
            scrub_string("/home/ci/.local/share/companion-hub"),
            "~/.local/share/companion-hub"
        );
        // Windows must win over the macOS pattern, or a stranded `C:~/…` is left.
        assert_eq!(scrub_string(r"C:\Users\liam\AppData"), "~\\AppData");
        assert_eq!(scrub_string("C:/Users/liam/AppData"), "~/AppData");
    }

    #[test]
    fn redacts_credentials() {
        assert!(!scrub_string("Authorization: Bearer abc123DEF").contains("abc123DEF"));
        assert!(!scrub_string("api_key=SUPERSECRET").contains("SUPERSECRET"));
        assert!(!scrub_string("x-api-key: KEYVALUE123").contains("KEYVALUE123"));
        assert!(!scrub_string("tskey-auth-abc123").contains("abc123"));
        assert!(!scrub_string("postgres://user:hunter2@db:5432/hub").contains("hunter2"));
    }

    #[test]
    fn strips_query_and_fragment_from_urls() {
        assert_eq!(
            scrub_url("https://hub.local/api/apps?q=secret#frag"),
            "https://hub.local/api/apps"
        );
        assert_eq!(
            scrub_url("https://hub.local/api/apps"),
            "https://hub.local/api/apps"
        );
    }

    #[test]
    fn scrubs_the_event_title_operators_actually_see() {
        // The exact shape record_log_event sends, from this repo's own fixture.
        let mut event = Event::default();
        event.message = Some(
            "hub.start: Cannot connect to the Docker daemon at unix:///Users/bennett/.docker/run/docker.sock".to_string(),
        );

        let scrubbed = scrub_event(event);
        let message = scrubbed.message.expect("message");
        assert!(
            !message.contains("bennett"),
            "OS account name survived: {message}"
        );
        assert!(message.contains("~/.docker/run/docker.sock"));
    }

    #[test]
    fn drops_the_machine_hostname() {
        let mut event = Event::default();
        event.server_name = Some("liams-macbook-pro.local".into());

        assert!(scrub_event(event).server_name.is_none());
    }

    #[test]
    fn keeps_device_id_but_drops_other_user_identifiers() {
        let mut event = Event::default();
        event.user = Some(sentry::protocol::User {
            id: Some("device-abc".to_string()),
            email: Some("liam@example.com".to_string()),
            username: Some("liam".to_string()),
            ip_address: Some(sentry::protocol::IpAddress::Exact(
                "203.0.113.42".parse().unwrap(),
            )),
            ..Default::default()
        });

        let user = scrub_event(event).user.expect("user");
        assert_eq!(user.id.as_deref(), Some("device-abc"));
        assert!(user.email.is_none());
        assert!(user.username.is_none());
        assert!(user.ip_address.is_none());
    }

    #[test]
    fn filters_sensitive_breadcrumb_data_by_key_and_by_value() {
        let mut breadcrumb = Breadcrumb::default();
        breadcrumb.message = Some("fetch /Users/liam/x".to_string());
        breadcrumb.data.insert(
            "token".to_string(),
            Value::String("bare-secret-value".to_string()),
        );
        breadcrumb.data.insert(
            "http.query".to_string(),
            Value::String("?token=SUPERSECRET&api_key=KEY".to_string()),
        );
        breadcrumb.data.insert(
            "url".to_string(),
            Value::String("https://hub.local/api/apps?q=private".to_string()),
        );

        let scrubbed = scrub_breadcrumb(breadcrumb);

        // A bare credential value matches no secret pattern — the KEY is the
        // only signal, which is why data is key-checked and not just scrubbed.
        assert_eq!(
            scrubbed.data["token"],
            Value::String("[Filtered]".to_string())
        );
        assert_eq!(
            scrubbed.data["http.query"],
            Value::String("[Filtered]".to_string())
        );
        assert_eq!(
            scrubbed.data["url"],
            Value::String("https://hub.local/api/apps".to_string())
        );
        assert!(!scrubbed.message.expect("message").contains("liam"));
    }

    #[test]
    fn scrubs_stack_frames_and_extra() {
        let mut event = Event::default();
        event.extra.insert(
            "api_key".to_string(),
            Value::String("bare-value".to_string()),
        );
        event.extra.insert(
            "detail".to_string(),
            Value::String("/Users/liam/notes".to_string()),
        );

        let scrubbed = scrub_event(event);
        assert_eq!(
            scrubbed.extra["api_key"],
            Value::String("[Filtered]".to_string())
        );
        assert_eq!(
            scrubbed.extra["detail"],
            Value::String("~/notes".to_string())
        );
    }

    #[test]
    fn truncates_oversized_strings() {
        let long = "a".repeat(9000);
        let scrubbed = scrub_string(&long);
        assert!(scrubbed.ends_with("… [truncated]"));
        assert!(scrubbed.chars().count() < 9000);
    }
}
