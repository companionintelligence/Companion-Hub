//! Which Companion Portal (`CI_CLOUD_URL`) a desktop Hub talks to.
//!
//! A desktop bundle compiles its Portal in (`CI_HUB_CLOUD_URL`, else the default for
//! `CI_HUB_ENVIRONMENT`), and every launch rewrites `CI_CLOUD_URL` in the Hub env files from
//! it. An operator who needs a published bundle to use another Portal (QA against dev Portal,
//! for example) sets [`PORTAL_URL_OVERRIDE_KEY`] in the Hub data dir env file instead.
//!
//! The Portal URL decides where the Hub pairs, where users sign in and where the device key is
//! sent, so the override is deliberately narrow:
//!
//! - It is read only from the env file in the Hub data dir, which only someone who controls
//!   the machine can edit. No Hub API writes that key: the backend's only `.env` writer is the
//!   stack updater, which upserts `CI_HUB_IMAGE` and `CI_HUB_VERSION` by name.
//! - It must be a bare `https` origin. Plain `http` is accepted only for loopback hosts (the
//!   same set the backend bridges to `host.docker.internal`), for local Portal development.
//! - A value that fails validation is ignored and the compiled Portal is used, exactly as if
//!   the key were absent. The reason is logged on every launch until the value is fixed.

use std::collections::HashMap;

use crate::hub_env::{default_ci_cloud_url, unquote_env_value};

/// Env file key an operator sets to point this desktop Hub at another Portal.
pub(crate) const PORTAL_URL_OVERRIDE_KEY: &str = "CI_HUB_CLOUD_URL_OVERRIDE";

/// Portal compiled into this binary: what every launch used before overrides existed.
pub(crate) fn compiled_ci_cloud_url() -> &'static str {
    option_env!("CI_HUB_CLOUD_URL").unwrap_or(default_ci_cloud_url())
}

/// Where the effective Portal URL came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PortalUrlSource {
    Compiled,
    Override,
}

/// Outcome of resolving the Portal URL for one launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PortalUrlResolution {
    /// Value written to `CI_CLOUD_URL`.
    pub(crate) url: String,
    pub(crate) source: PortalUrlSource,
    /// The override exactly as the operator wrote it (trimmed), carried forward into the
    /// regenerated env files so a launch never deletes it. `None` when the key is absent or blank.
    pub(crate) raw_override: Option<String>,
    /// Why a present override was refused. The compiled Portal is used instead.
    pub(crate) rejected: Option<String>,
}

/// Resolve the Portal URL from the Hub env values loaded for this launch.
pub(crate) fn resolve_portal_url_from_env(
    existing: &HashMap<String, String>,
) -> PortalUrlResolution {
    resolve_portal_url(
        existing.get(PORTAL_URL_OVERRIDE_KEY).map(String::as_str),
        compiled_ci_cloud_url(),
    )
}

/// Pure form of [`resolve_portal_url_from_env`], so the compiled value can be varied in tests.
///
/// Without a usable override the compiled value is returned verbatim, not normalized, so a
/// Hub that never sets the key renders byte-for-byte the env file it rendered before.
pub(crate) fn resolve_portal_url(
    override_value: Option<&str>,
    compiled: &str,
) -> PortalUrlResolution {
    let raw_override = override_value
        .map(str::trim)
        .filter(|value| !unquote_env_value(value).is_empty())
        .map(str::to_string);

    let Some(raw) = raw_override.as_deref() else {
        return PortalUrlResolution {
            url: compiled.to_string(),
            source: PortalUrlSource::Compiled,
            raw_override: None,
            rejected: None,
        };
    };

    match validate_portal_url_override(raw) {
        Ok(url) => PortalUrlResolution {
            url,
            source: PortalUrlSource::Override,
            raw_override,
            rejected: None,
        },
        Err(reason) => PortalUrlResolution {
            url: compiled.to_string(),
            source: PortalUrlSource::Compiled,
            raw_override,
            rejected: Some(reason),
        },
    }
}

/// Validate an override and return it as a normalized origin (`https://host[:port]`).
///
/// Everything that consumes `CI_CLOUD_URL` treats it as an origin: the backend appends
/// `/api/...`, and app OIDC injection uses it as the token issuer. A path, query or fragment
/// would silently produce a different issuer or API base, so they are refused rather than cut.
pub(crate) fn validate_portal_url_override(raw: &str) -> Result<String, String> {
    let value = unquote_env_value(raw);
    let parsed = reqwest::Url::parse(value).map_err(|_| {
        format!(
            "{PORTAL_URL_OVERRIDE_KEY} is not an absolute URL (expected e.g. https://hub.companionintelligence.com)"
        )
    })?;

    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| format!("{PORTAL_URL_OVERRIDE_KEY} has no host"))?;

    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback_portal_host(host) => {}
        "http" => {
            return Err(format!(
            "{PORTAL_URL_OVERRIDE_KEY} must use https; plain http is accepted only for localhost"
        ))
        }
        scheme => {
            return Err(format!(
                "{PORTAL_URL_OVERRIDE_KEY} must use https, not {scheme}"
            ))
        }
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!(
            "{PORTAL_URL_OVERRIDE_KEY} must not contain credentials"
        ));
    }

    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err(format!(
            "{PORTAL_URL_OVERRIDE_KEY} must be a bare origin with no path, query or fragment"
        ));
    }

    Ok(parsed.origin().ascii_serialization())
}

/// Loopback hosts, matching `isLoopbackPortalHost` in the backend's `portal-url.ts`.
fn is_loopback_portal_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.ends_with(".localhost")
}

/// Whether two `CI_CLOUD_URL` values name the same Portal, ignoring quoting, a trailing
/// slash and ASCII case.
pub(crate) fn same_portal_url(left: &str, right: &str) -> bool {
    fn normalize(value: &str) -> String {
        unquote_env_value(value)
            .trim()
            .trim_end_matches('/')
            .to_ascii_lowercase()
    }
    normalize(left) == normalize(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMPILED: &str = "https://hub.ci.computer";
    const DEV: &str = "https://hub.companionintelligence.com";

    #[test]
    fn without_an_override_the_compiled_portal_is_used_verbatim() {
        for absent in [None, Some(""), Some("   "), Some("\"\"")] {
            let resolved = resolve_portal_url(absent, COMPILED);
            assert_eq!(
                resolved,
                PortalUrlResolution {
                    url: COMPILED.to_string(),
                    source: PortalUrlSource::Compiled,
                    raw_override: None,
                    rejected: None,
                },
                "override {absent:?} must behave as if the key were absent"
            );
        }

        // Verbatim, not normalized: an unset override must not change a single byte of the
        // value earlier builds wrote, or every existing Hub would see a config change.
        let odd_compiled = "https://Hub.CI.computer/";
        assert_eq!(resolve_portal_url(None, odd_compiled).url, odd_compiled);
    }

    #[test]
    fn a_valid_override_replaces_the_compiled_portal() {
        let resolved =
            resolve_portal_url(Some(" https://hub.companionintelligence.com/ "), COMPILED);
        assert_eq!(resolved.url, DEV);
        assert_eq!(resolved.source, PortalUrlSource::Override);
        assert_eq!(resolved.rejected, None);
        assert_eq!(
            resolved.raw_override.as_deref(),
            Some("https://hub.companionintelligence.com/"),
            "the operator's spelling is what gets carried forward into the env files"
        );
    }

    #[test]
    fn a_quoted_override_is_accepted() {
        for quoted in [format!("\"{DEV}\""), format!("'{DEV}'")] {
            let resolved = resolve_portal_url(Some(&quoted), COMPILED);
            assert_eq!(resolved.url, DEV, "{quoted}");
            assert_eq!(resolved.source, PortalUrlSource::Override);
        }
    }

    #[test]
    fn plain_http_is_accepted_only_for_loopback_portals() {
        for (value, expected) in [
            ("http://localhost:8415", "http://localhost:8415"),
            ("http://127.0.0.1:8415/", "http://127.0.0.1:8415"),
            ("http://ci-portal.localhost", "http://ci-portal.localhost"),
            ("http://[::1]:8415", "http://[::1]:8415"),
        ] {
            let resolved = resolve_portal_url(Some(value), COMPILED);
            assert_eq!(resolved.url, expected, "{value}");
            assert_eq!(resolved.source, PortalUrlSource::Override, "{value}");
        }

        let resolved = resolve_portal_url(Some("http://hub.companionintelligence.com"), COMPILED);
        assert_eq!(resolved.url, COMPILED);
        assert!(resolved
            .rejected
            .as_deref()
            .is_some_and(|reason| reason.contains("must use https")));
    }

    #[test]
    fn an_invalid_override_is_refused_and_the_compiled_portal_is_kept() {
        for (value, reason_fragment) in [
            ("hub.companionintelligence.com", "not an absolute URL"),
            ("not a url", "not an absolute URL"),
            ("https://", "not an absolute URL"),
            ("ftp://hub.companionintelligence.com", "not ftp"),
            ("file:///etc/passwd", "has no host"),
            ("javascript:alert(1)", "has no host"),
            ("http://localhost.example.com", "must use https"),
            (
                "https://user:secret@hub.companionintelligence.com",
                "credentials",
            ),
            ("https://hub.companionintelligence.com/api", "bare origin"),
            ("https://hub.companionintelligence.com/?x=1", "bare origin"),
            ("https://hub.companionintelligence.com/#top", "bare origin"),
        ] {
            let resolved = resolve_portal_url(Some(value), COMPILED);
            assert_eq!(
                resolved.url, COMPILED,
                "{value} must fall back to the compiled Portal"
            );
            assert_eq!(resolved.source, PortalUrlSource::Compiled, "{value}");
            assert_eq!(
                resolved.raw_override.as_deref(),
                Some(value),
                "{value} must be kept in the env file so the operator can see and fix it"
            );
            let reason = resolved.rejected.unwrap_or_default();
            assert!(
                reason.contains(PORTAL_URL_OVERRIDE_KEY) && reason.contains(reason_fragment),
                "{value}: expected a reason naming the key and {reason_fragment:?}, got {reason:?}"
            );
        }
    }

    #[test]
    fn same_portal_url_ignores_spelling_differences_only() {
        assert!(same_portal_url(
            DEV,
            "https://hub.companionintelligence.com/"
        ));
        assert!(same_portal_url(
            DEV,
            "\"https://HUB.companionintelligence.com\""
        ));
        assert!(!same_portal_url(DEV, COMPILED));
        assert!(!same_portal_url(
            DEV,
            "http://hub.companionintelligence.com"
        ));
    }

    #[test]
    fn compiled_portal_matches_the_build_default() {
        assert_eq!(
            compiled_ci_cloud_url(),
            option_env!("CI_HUB_CLOUD_URL").unwrap_or(default_ci_cloud_url())
        );
    }
}
