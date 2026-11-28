//! The Portal token request of the desktop's own sign-in, sent from here instead of the WebView.
//!
//! The desktop signs in with PKCE over a loopback redirect (`desktop-portal-sign-in.ts`), and the
//! last step POSTs the code to Portal's token endpoint. From the WebView that is a cross-origin
//! `fetch`, and Portal's API answers CORS for its own UI origin only, so the reply could never be
//! read from `http://127.0.0.1:5002`, `tauri://localhost` or any other origin the Hub UI runs on:
//! every desktop Portal sign-in failed with "token request failed before a response arrived"
//! (2026-11-17). A native app sends this request outside the browser (RFC 8252 §8.1 leaves the
//! token request to the app), so this command does, and Portal's CORS stays as tight as it is.
//!
//! It is not a general HTTP client for the page. It sends one request shape and nothing else:
//!
//! - to exactly `<this desktop's Portal>/api/auth/oauth2/token`, where the Portal is the one the
//!   desktop resolved for itself ([`portal_url::launch_portal_url`]: compiled in, or the override
//!   file in its own config dir, which no container mounts), never a URL the page chose;
//! - as `https`, or `http` only when that Portal is a loopback one for local Portal development;
//! - with a form body of OAuth token-grant fields only, `grant_type` `authorization_code` or
//!   `refresh_token`, which carries nothing the page did not already hold. A code exchange may also
//!   name the Hub it signs in to (`resource=urn:ci:device:<id>`), so Portal addresses the id_token
//!   to that Hub and no other Hub can turn it into a session;
//! - with no redirects followed, a timeout, and a cap on the reply it hands back.

use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::Url;
use serde::Serialize;

use crate::portal_url;

/// Portal's OAuth token endpoint, under its origin.
const TOKEN_PATH: &str = "/api/auth/oauth2/token";

/// The form fields a token grant sends (`exchangeAuthorizationCode`, `refreshTokens` in the
/// vendored `@companionintelligence/auth/token`). Anything else is refused.
const ALLOWED_FIELDS: &[&str] = &[
    "grant_type",
    "code",
    "redirect_uri",
    "client_id",
    "code_verifier",
    "refresh_token",
    "resource",
];

/// The only `resource` a code exchange may name: one appliance, as Portal's addressing contract writes it.
const RESOURCE_PREFIX: &str = "urn%3Aci%3Adevice%3A";

/// A token request body is a few hundred bytes; this only stops the page from sending a payload.
const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// A token response is a few KB of JSON. Anything longer is not one.
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// What the page's `fetch` stand-in turns into a `Response`.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct PortalTokenResponse {
    pub status: u16,
    pub body: String,
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

/// The token endpoint URL, when `endpoint` is exactly this desktop's Portal token endpoint and
/// `body` is a token grant; otherwise why not.
pub(crate) fn check_token_request(
    endpoint: &str,
    body: &str,
    portal_url: &str,
) -> Result<Url, String> {
    let portal =
        Url::parse(portal_url).map_err(|_| "this desktop's Portal URL is not valid".to_string())?;
    let url = Url::parse(endpoint).map_err(|_| "the token endpoint is not a URL".to_string())?;

    let portal_host = portal.host_str().unwrap_or_default().to_ascii_lowercase();
    let scheme_ok =
        url.scheme() == "https" || (url.scheme() == "http" && is_loopback_host(&portal_host));
    if !scheme_ok {
        return Err("the token endpoint must be https".to_string());
    }
    if url.origin() != portal.origin() {
        return Err("the token endpoint is not on this desktop's Portal".to_string());
    }
    if url.path() != TOKEN_PATH || url.query().is_some() || url.fragment().is_some() {
        return Err("the URL is not Portal's token endpoint".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the token endpoint must not carry credentials".to_string());
    }

    if body.is_empty() || body.len() > MAX_REQUEST_BYTES {
        return Err("the token request body is empty or too long".to_string());
    }
    let mut grant_type: Option<&str> = None;
    let mut resources = 0;
    for pair in body.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if !ALLOWED_FIELDS.contains(&key) {
            return Err(format!("the token request may not carry the field {key:?}"));
        }
        if key == "grant_type" {
            if grant_type.is_some() {
                return Err("the token request names its grant type twice".to_string());
            }
            grant_type = Some(value);
        }
        if key == "resource" {
            // One appliance, as URLSearchParams encodes it: the prefix, then a device id of plain
            // characters. Anything else is not something this command sends for the page.
            let id = value.strip_prefix(RESOURCE_PREFIX).unwrap_or("");
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
            {
                return Err("the token request may name only an appliance as resource".to_string());
            }
            resources += 1;
        }
    }
    if resources > 1 {
        return Err("the token request names more than one resource".to_string());
    }
    match grant_type {
        Some("authorization_code") => Ok(url),
        Some("refresh_token") if resources == 0 => Ok(url),
        Some("refresh_token") => Err("only a code exchange may name a resource".to_string()),
        _ => Err(
            "the token request must be an authorization_code or refresh_token grant".to_string(),
        ),
    }
}

async fn send_token_request(url: Url, body: String) -> Result<PortalTokenResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "could not start the token request".to_string())?;

    let mut response = client
        .post(url)
        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(ACCEPT, "application/json")
        .body(body)
        .send()
        .await
        // No detail: a transport error can quote the URL, and the page has nothing to do with it.
        .map_err(|_| "the token request got no response".to_string())?;

    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "the token response could not be read".to_string())?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("the token response is too long".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }

    Ok(PortalTokenResponse {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Send the desktop sign-in's token request to this desktop's Portal. See the module docs for
/// what is accepted.
#[tauri::command]
pub async fn portal_token_request_command(
    endpoint: String,
    body: String,
) -> Result<PortalTokenResponse, String> {
    let portal = portal_url::launch_portal_url().url;
    let url = check_token_request(&endpoint, &body, &portal)?;
    send_token_request(url, body).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORTAL: &str = "https://hub.companionintelligence.com";
    const ENDPOINT: &str = "https://hub.companionintelligence.com/api/auth/oauth2/token";
    const CODE_GRANT: &str =
        "grant_type=authorization_code&code=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback&client_id=ci-hub&code_verifier=xyz";

    #[test]
    fn accepts_the_code_exchange_and_the_refresh_on_this_portal() {
        assert!(check_token_request(ENDPOINT, CODE_GRANT, PORTAL).is_ok());
        assert!(check_token_request(
            ENDPOINT,
            "grant_type=refresh_token&refresh_token=r&client_id=ci-hub",
            PORTAL
        )
        .is_ok());
        // The compiled Portal may carry a trailing slash; the origin is what counts.
        assert!(check_token_request(
            ENDPOINT,
            CODE_GRANT,
            "https://hub.companionintelligence.com/"
        )
        .is_ok());
    }

    #[test]
    fn lets_a_code_exchange_name_one_appliance_and_nothing_else() {
        let addressed =
            format!("{CODE_GRANT}&resource=urn%3Aci%3Adevice%3A5f0e8c1a-3b2d_4e6f.9a7b");
        assert!(check_token_request(ENDPOINT, &addressed, PORTAL).is_ok());
        for body in [
            format!("{CODE_GRANT}&resource=https%3A%2F%2Fevil.example%2F"),
            format!("{CODE_GRANT}&resource=urn%3Aci%3Adevice%3A"),
            format!("{CODE_GRANT}&resource=urn%3Aci%3Adevice%3Aa%26b"),
            format!("{CODE_GRANT}&resource=urn%3Aci%3Adevice%3Aa&resource=urn%3Aci%3Adevice%3Ab"),
            "grant_type=refresh_token&refresh_token=r&resource=urn%3Aci%3Adevice%3Aa".to_string(),
        ] {
            assert!(
                check_token_request(ENDPOINT, &body, PORTAL).is_err(),
                "{body}"
            );
        }
    }

    #[test]
    fn refuses_any_endpoint_but_this_portals_token_endpoint() {
        for endpoint in [
            "https://evil.example/api/auth/oauth2/token",
            "https://hub.companionintelligence.com.evil.example/api/auth/oauth2/token",
            "https://hub.companionintelligence.com/api/auth/sign-in",
            "https://hub.companionintelligence.com/api/auth/oauth2/token?x=1",
            "https://hub.companionintelligence.com/api/auth/oauth2/token/../x",
            "https://user:pw@hub.companionintelligence.com/api/auth/oauth2/token",
            "http://hub.companionintelligence.com/api/auth/oauth2/token",
            "https://hub.companionintelligence.com:8443/api/auth/oauth2/token",
            "not a url",
        ] {
            assert!(
                check_token_request(endpoint, CODE_GRANT, PORTAL).is_err(),
                "{endpoint}"
            );
        }
    }

    #[test]
    fn accepts_plain_http_only_for_a_loopback_portal() {
        assert!(check_token_request(
            "http://localhost:8787/api/auth/oauth2/token",
            CODE_GRANT,
            "http://localhost:8787"
        )
        .is_ok());
        assert!(check_token_request(
            "http://127.0.0.1:8787/api/auth/oauth2/token",
            CODE_GRANT,
            "http://127.0.0.1:8787"
        )
        .is_ok());
    }

    #[test]
    fn refuses_a_body_that_is_not_a_token_grant() {
        for body in [
            "",
            "grant_type=client_credentials&client_id=ci-hub",
            "grant_type=password&username=a&password=b",
            "code=abc&client_id=ci-hub",
            "grant_type=authorization_code&grant_type=refresh_token",
            "grant_type=authorization_code&client_secret=s",
            "grant_type=authorization_code&scope=admin",
            &format!(
                "grant_type=authorization_code&code={}",
                "a".repeat(MAX_REQUEST_BYTES)
            ),
        ] {
            assert!(
                check_token_request(ENDPOINT, body, PORTAL).is_err(),
                "{body}"
            );
        }
    }
}
