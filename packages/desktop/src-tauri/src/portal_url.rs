//! Which Companion Portal (`CI_CLOUD_URL`) a desktop Hub talks to.
//!
//! A desktop bundle compiles its Portal in (`CI_HUB_CLOUD_URL`, else the default for
//! `CI_HUB_ENVIRONMENT`), and every launch rewrites `CI_CLOUD_URL` in the Hub env files from
//! it. An operator who needs a published bundle to use another Portal (QA against dev Portal,
//! for example) writes that Portal's origin to the override file at
//! [`portal_url_override_path`].
//!
//! The Portal URL decides where the Hub pairs, where users sign in, and where the device key is
//! sent, so the override is deliberately narrow:
//!
//! - It is read only from the desktop app's own config dir, which no container mounts. It is
//!   never read from the Hub env files: the primary one is mounted into the `ci-hub` container
//!   as `/data/.env` and the backend writes to it, so a line that reaches that file must not be
//!   able to choose the Portal.
//! - Only the resolved `CI_CLOUD_URL` is written to the env files, never the override itself.
//! - It must be a bare `https` origin. Plain `http` is accepted only for loopback hosts (the
//!   same set the backend bridges to `host.docker.internal`), for local Portal development.
//! - A value that fails validation is ignored and the compiled Portal is used, exactly as if
//!   there were no override file. The reason is logged on every launch until the file is fixed.

use std::path::{Path, PathBuf};

use crate::hub_env::{default_ci_cloud_url, unquote_env_value};

/// The desktop app's own directory under the platform config dir. It is the Tauri app
/// identifier, so this is the directory Tauri calls the app config dir. No compose file mounts it.
const DESKTOP_CONFIG_DIRNAME: &str = "computer.ci.app.hub";

/// Override file in [`DESKTOP_CONFIG_DIRNAME`]. Its first value line is the Portal origin.
const PORTAL_URL_OVERRIDE_FILENAME: &str = "portal-url-override";

/// Portal compiled into this binary: what every launch used before overrides existed.
pub(crate) fn compiled_ci_cloud_url() -> &'static str {
    option_env!("CI_HUB_CLOUD_URL").unwrap_or(default_ci_cloud_url())
}

/// Where this desktop reads its Portal URL override, when the platform has a config dir.
///
/// `None` under `cargo test`, so no test can pick up an override file on the developer's own
/// machine. Tests pass an explicit path to [`resolve_portal_url_at`] instead.
pub(crate) fn portal_url_override_path() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    dirs::config_dir().map(|config_dir| portal_url_override_path_in(&config_dir))
}

/// [`portal_url_override_path`] under a given platform config dir.
pub(crate) fn portal_url_override_path_in(config_dir: &Path) -> PathBuf {
    config_dir
        .join(DESKTOP_CONFIG_DIRNAME)
        .join(PORTAL_URL_OVERRIDE_FILENAME)
}

/// Outcome of resolving the Portal URL for one launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PortalUrlResolution {
    /// Value written to `CI_CLOUD_URL`.
    pub(crate) url: String,
    /// The override file that held a value, whether that value was used or refused.
    pub(crate) source: Option<PathBuf>,
    /// Why the override was refused. The compiled Portal is used instead.
    pub(crate) rejected: Option<String>,
}

impl PortalUrlResolution {
    /// This build's Portal, verbatim rather than normalized, so a Hub without an override
    /// renders byte-for-byte the env file that earlier builds rendered.
    fn compiled() -> Self {
        Self {
            url: compiled_ci_cloud_url().to_string(),
            source: None,
            rejected: None,
        }
    }
}

/// Resolve the Portal URL for a launch of this desktop.
pub(crate) fn launch_portal_url() -> PortalUrlResolution {
    resolve_portal_url_at(portal_url_override_path().as_deref())
}

/// Resolve the Portal URL from the override file at `path`. No path, a missing file, and a file
/// with no value line all mean there is no override.
pub(crate) fn resolve_portal_url_at(path: Option<&Path>) -> PortalUrlResolution {
    let Some(path) = path else {
        return PortalUrlResolution::compiled();
    };
    let validated = read_portal_url_override(path).and_then(|value| {
        value
            .map(|value| validate_portal_url_override(&value))
            .transpose()
    });
    match validated {
        Ok(None) => PortalUrlResolution::compiled(),
        Ok(Some(url)) => PortalUrlResolution {
            url,
            source: Some(path.to_path_buf()),
            rejected: None,
        },
        Err(reason) => PortalUrlResolution {
            source: Some(path.to_path_buf()),
            rejected: Some(reason),
            ..PortalUrlResolution::compiled()
        },
    }
}

/// The override value: the first line that is neither blank nor a `#` comment, without quotes.
/// `Ok(None)` when the file does not exist or holds no value.
fn read_portal_url_override(path: &Path) -> Result<Option<String>, String> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("the file could not be read ({error})")),
    };
    Ok(content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| unquote_env_value(line).trim().to_string())
        .filter(|value| !value.is_empty()))
}

/// Validate an override and return it as a normalized origin (`https://host[:port]`).
///
/// Everything that consumes `CI_CLOUD_URL` treats it as an origin: the backend appends
/// `/api/...`, and app OIDC injection uses it as the token issuer. A path, query, fragment, or
/// trailing dot would silently produce a different issuer or API base, so they are refused
/// rather than cut.
pub(crate) fn validate_portal_url_override(value: &str) -> Result<String, String> {
    let parsed = reqwest::Url::parse(value).map_err(|_| {
        "it is not an absolute URL (expected e.g. https://hub.companionintelligence.com)"
            .to_string()
    })?;

    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "it has no host".to_string())?;

    // `domain()` is `None` for IP addresses, which the parser has already normalized. The URL
    // parser accepts `$`, `{` and quotes in a domain, and docker compose interpolates `$` when it
    // reads CI_CLOUD_URL from the env file, so the container would get a different Portal. A
    // trailing dot never matches the Portal's token issuer.
    if let Some(domain) = parsed.domain() {
        let is_dns_name = domain.split('.').all(|label| {
            !label.is_empty()
                && label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        });
        if !is_dns_name {
            return Err(
                "its host is not a DNS name (letters, digits, hyphens, and dots, with no trailing dot)"
                    .to_string(),
            );
        }
    }

    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback_portal_host(host) => {}
        "http" => {
            return Err("it must use https; plain http is accepted only for localhost".to_string())
        }
        scheme => return Err(format!("it must use https, not {scheme}")),
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("it must not contain credentials".to_string());
    }

    if parsed.path() != "/" || parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("it must be a bare origin with no path, query, or fragment".to_string());
    }

    Ok(parsed.origin().ascii_serialization())
}

/// Loopback hosts, matching `isLoopbackPortalHost` in the backend's `portal-url.ts`.
fn is_loopback_portal_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.ends_with(".localhost")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV: &str = "https://hub.companionintelligence.com";

    fn override_file(content: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join(PORTAL_URL_OVERRIDE_FILENAME);
        std::fs::write(&path, content).expect("write override");
        (dir, path)
    }

    #[test]
    fn the_override_file_lives_in_the_desktop_config_dir() {
        assert_eq!(
            portal_url_override_path_in(Path::new("/config")),
            Path::new("/config/computer.ci.app.hub/portal-url-override")
        );
        assert_eq!(
            portal_url_override_path(),
            None,
            "tests must never read an override file from the developer's machine"
        );
    }

    #[test]
    fn without_an_override_the_compiled_portal_is_used() {
        let missing_dir = tempfile::tempdir().expect("tempdir");
        let missing = missing_dir.path().join(PORTAL_URL_OVERRIDE_FILENAME);
        assert_eq!(resolve_portal_url_at(None), PortalUrlResolution::compiled());
        assert_eq!(
            resolve_portal_url_at(Some(&missing)),
            PortalUrlResolution::compiled()
        );

        for content in [
            "",
            "\n\n",
            "   \r\n",
            "# https://hub.companionintelligence.com\n",
            "\"\"\n",
            "\" \"\n",
        ] {
            let (_dir, path) = override_file(content);
            let resolved = resolve_portal_url_at(Some(&path));
            assert_eq!(
                resolved,
                PortalUrlResolution::compiled(),
                "{content:?} holds no override"
            );
        }
    }

    #[test]
    fn the_first_value_line_of_the_file_is_the_override() {
        for content in [
            "https://hub.companionintelligence.com\n",
            "https://hub.companionintelligence.com/",
            "# dev Portal\r\n\r\n  https://hub.companionintelligence.com  \r\nhttps://ignored.example.test\r\n",
            "\"https://hub.companionintelligence.com\"\n",
            "'https://HUB.companionintelligence.com:443'\n",
        ] {
            let (_dir, path) = override_file(content);
            let resolved = resolve_portal_url_at(Some(&path));
            assert_eq!(resolved.url, DEV, "{content:?}");
            assert_eq!(resolved.rejected, None, "{content:?}");
            assert_eq!(resolved.source.as_deref(), Some(path.as_path()));
        }
    }

    #[test]
    fn an_unreadable_or_invalid_override_is_refused_and_the_compiled_portal_is_kept() {
        // A directory where the file should be cannot be read.
        let dir = tempfile::tempdir().expect("tempdir");
        let resolved = resolve_portal_url_at(Some(dir.path()));
        assert_eq!(resolved.url, compiled_ci_cloud_url());
        assert!(
            resolved
                .rejected
                .as_deref()
                .is_some_and(|reason| reason.contains("could not be read")),
            "{resolved:?}"
        );

        let (_dir, path) = override_file("http://portal.example.test\n");
        let resolved = resolve_portal_url_at(Some(&path));
        assert_eq!(resolved.url, compiled_ci_cloud_url());
        assert_eq!(resolved.source.as_deref(), Some(path.as_path()));
        assert!(resolved
            .rejected
            .as_deref()
            .is_some_and(|reason| reason.contains("must use https")));
    }

    #[test]
    fn a_valid_override_is_normalized_to_its_origin() {
        for (value, expected) in [
            ("https://hub.companionintelligence.com/", DEV),
            ("HTTPS://HUB.COMPANIONINTELLIGENCE.COM", DEV),
            ("https://hub.companionintelligence.com:443", DEV),
            (
                "https://portal.example.test:8443",
                "https://portal.example.test:8443",
            ),
            ("https://bücher.example", "https://xn--bcher-kva.example"),
            ("https://10.0.0.5", "https://10.0.0.5"),
        ] {
            assert_eq!(
                validate_portal_url_override(value).as_deref(),
                Ok(expected),
                "{value}"
            );
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
            assert_eq!(
                validate_portal_url_override(value).as_deref(),
                Ok(expected),
                "{value}"
            );
        }

        assert!(
            validate_portal_url_override("http://hub.companionintelligence.com")
                .is_err_and(|reason| reason.contains("must use https"))
        );
    }

    #[test]
    fn an_invalid_override_is_refused_with_a_reason() {
        for (value, reason_fragment) in [
            ("hub.companionintelligence.com", "not an absolute URL"),
            ("not a url", "not an absolute URL"),
            ("https://", "not an absolute URL"),
            ("ftp://hub.companionintelligence.com", "not ftp"),
            ("file:///etc/passwd", "has no host"),
            ("javascript:alert(1)", "has no host"),
            ("http://localhost.example.com", "must use https"),
            ("http://127.0.0.1.nip.io", "must use https"),
            (
                "https://user:secret@hub.companionintelligence.com",
                "credentials",
            ),
            ("https://hub.companionintelligence.com/api", "bare origin"),
            ("https://hub.companionintelligence.com/?x=1", "bare origin"),
            ("https://hub.companionintelligence.com/#top", "bare origin"),
            ("https://hub.companionintelligence.com.", "not a DNS name"),
            ("https://a${x}.example.test", "not a DNS name"),
            ("https://hub{portal}.example.test", "not a DNS name"),
        ] {
            let reason =
                validate_portal_url_override(value).expect_err(&format!("{value} must be refused"));
            assert!(
                reason.contains(reason_fragment),
                "{value}: expected a reason containing {reason_fragment:?}, got {reason:?}"
            );
        }
    }
}
