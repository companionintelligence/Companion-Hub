//! Decide which top-level navigations may replace the Hub window.
//!
//! The desktop shell is one webview. A click, a redirect, or `location.replace`
//! onto an installed app (FreeCut at `http://127.0.0.1:8400`, `freecut.ci.lan`,
//! `freecut-….ci.computer`) used to load that app in the Hub window, with no
//! way back. The capability `remote.urls` list cannot express "the Hub, but
//! not the apps": URLPattern `*` is one whole hostname label, so `*.ci.lan`
//! matches `hub.ci.lan` and `freecut.ci.lan` alike. This rule is the exclusion.
//! Hub hosts stay. Every other http(s) URL is handed to the system browser and
//! the webview navigation is cancelled.

use std::sync::OnceLock;

use regex::Regex;
use tauri::{Runtime, Url, plugin::TauriPlugin};
use tauri_plugin_opener::OpenerExt;

/// Vite dev server from `tauri.conf.json` `build.devUrl`. `tauri dev` loads the
/// UI here before bootstrap jumps to the Hub API port.
const DEV_FRONTEND_PORT: u16 = 5005;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("hub-webview-navigation")
        .on_navigation(|webview, url| {
            let current = webview.url().ok();
            let hub_api_port = crate::port_manager::read_api_port(&crate::hub_manager::hub_env_path());
            if stays_in_hub_webview(url, current.as_ref(), hub_api_port) {
                return true;
            }

            let where_ = url.host_str().unwrap_or("unknown-host");
            log::info!("opening {where_} in the system browser instead of the Hub window");
            if let Err(err) = webview.opener().open_url(url.as_str(), None::<&str>) {
                log::warn!("the system browser refused {where_}: {err}");
            }
            false
        })
        .build()
}

/// `true` when this navigation is the Hub UI and must stay in the window.
/// `false` when it is some other http(s) page and belongs in the system browser.
pub fn stays_in_hub_webview(target: &Url, current: Option<&Url>, hub_api_port: u16) -> bool {
    let scheme = target.scheme();
    if scheme != "http" && scheme != "https" {
        return true;
    }

    if let Some(current) = current {
        if origins_match(target, current) {
            return true;
        }
    }

    let Some(host) = target.host_str() else {
        return true;
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();

    if is_shell_internal_host(&host) || is_hub_hostname(&host) {
        return true;
    }

    if is_loopback_host(&host) {
        let port = target.port_or_known_default().unwrap_or(80);
        return port == hub_api_port || port == DEV_FRONTEND_PORT;
    }

    false
}

fn origins_match(target: &Url, current: &Url) -> bool {
    target.scheme() == current.scheme()
        && target.host() == current.host()
        && target.port_or_known_default() == current.port_or_known_default()
}

/// Hosts the webview itself uses for IPC and the asset protocol, not an app.
fn is_shell_internal_host(host: &str) -> bool {
    matches!(host, "ipc.localhost" | "tauri.localhost" | "asset.localhost")
}

/// The Hub's own hostname: the label `hub` (`hub.ci.lan`) or a public label
/// `hub-…` (`hub-laptop-acme.ci.computer`). An app label (`freecut`,
/// `freecut-hub-laptop-acme`) does not match.
fn is_hub_hostname(host: &str) -> bool {
    hub_host_pattern().is_match(host)
}

fn hub_host_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)^hub(-[^.]+)?(\.|$)").expect("hub host pattern"))
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "::1"
}

#[cfg(test)]
mod tests {
    use super::*;

    const API_PORT: u16 = 5002;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap_or_else(|err| panic!("parse {raw}: {err}"))
    }

    fn stays(raw: &str) -> bool {
        stays_in_hub_webview(&url(raw), None, API_PORT)
    }

    #[test]
    fn the_hub_window_keeps_its_own_pages() {
        assert!(stays("tauri://localhost/"));
        assert!(stays("http://ipc.localhost/invoke"));
        assert!(stays("http://127.0.0.1:5002/"));
        assert!(stays("http://127.0.0.1:5002/home"));
        assert!(stays("http://localhost:5002/apps"));
        assert!(stays("http://localhost:5005/"));
        assert!(stays("http://hub.ci.localhost/"));
        assert!(stays("http://hub.ci.lan/home"));
        assert!(stays("https://hub-laptop-acme.ci.computer/home"));
        assert!(stays("https://HUB.ci.lan/"));
    }

    #[test]
    fn an_installed_app_is_not_a_hub_host() {
        assert!(!stays("http://127.0.0.1:8400/"));
        assert!(!stays("http://localhost:8400/"));
        assert!(!stays("http://freecut.ci.localhost/"));
        assert!(!stays("http://freecut.ci.lan/"));
        assert!(!stays("https://freecut-laptop-acme.ci.computer/"));
        assert!(!stays("https://freecut-hub-laptop-acme.ci.computer/"));
        assert!(!stays("http://192.168.1.9:8400/"));
        assert!(!stays("https://github.com/walterlow/freecut"));
        assert!(!stays("https://discord.com/invite/freecut"));
    }

    #[test]
    fn a_page_the_hub_is_already_showing_may_move_within_itself() {
        let current = url("https://hub-laptop-acme.example.net/home");
        assert!(stays_in_hub_webview(
            &url("https://hub-laptop-acme.example.net/apps/freecut"),
            Some(&current),
            API_PORT
        ));
        assert!(!stays_in_hub_webview(
            &url("https://freecut-laptop-acme.example.net/"),
            Some(&current),
            API_PORT
        ));
    }

    #[test]
    fn a_name_that_merely_starts_with_hub_is_not_the_hub() {
        assert!(!hub_host_pattern().is_match("hubbing.com"));
        assert!(!hub_host_pattern().is_match("hubbub.ci.lan"));
    }
}
