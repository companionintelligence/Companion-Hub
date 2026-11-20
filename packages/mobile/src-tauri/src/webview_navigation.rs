//! Keep remote pages out of the app's window on a phone.
//!
//! The mobile UI is bundled (`tauri://localhost` on iOS, `http://tauri.localhost`
//! on Android) and talks to the Hub over HTTP; it never needs a remote page in its
//! own window. A link, a redirect or `location.assign` onto an installed app or any
//! other site used to load it in the window anyway, with no way back but closing
//! the app. Every such navigation is now handed to the system browser and the
//! webview stays where it was.
//!
//! Defence in depth beside `capabilities/default.json`, which no longer lets a
//! remote Hub-zone page use native commands: even a page that got into the window
//! would hold nothing.

use tauri::{plugin::TauriPlugin, Runtime, Url};
use tauri_plugin_opener::OpenerExt;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("app-webview-navigation")
        .on_navigation(|webview, url| {
            if stays_in_app_webview(url) {
                return true;
            }

            let where_ = url.host_str().unwrap_or("unknown-host");
            log::info!("opening {where_} in the system browser instead of the app window");
            if let Err(err) = webview.opener().open_url(url.as_str(), None::<&str>) {
                log::warn!("the system browser refused {where_}: {err}");
            }
            false
        })
        .build()
}

/// `true` when this navigation is the app's own UI and must stay in the window.
///
/// Anything not http(s) stays: `tauri:`, `about:blank`, `about:srcdoc`, `blob:`
/// and `data:` are the page's own documents, and a `cihub:` link is the app's
/// own deep link, which the OS routes back here. Over http(s) only the app's own
/// origins stay: `*.localhost` (`tauri.localhost`, and `ipc.localhost` for IPC
/// on Android) and the dev server hosts (`localhost`, `127.0.0.1`, `lvh.me`),
/// which on a phone are the phone itself.
pub fn stays_in_app_webview(target: &Url) -> bool {
    if !matches!(target.scheme(), "http" | "https") {
        return true;
    }

    match target.host_str() {
        Some(host) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            host == "localhost"
                || host.ends_with(".localhost")
                || host == "127.0.0.1"
                || host == "lvh.me"
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::stays_in_app_webview;
    use tauri::Url;

    fn stays(raw: &str) -> bool {
        stays_in_app_webview(&Url::parse(raw).expect("test URL parses"))
    }

    #[test]
    fn keeps_the_apps_own_pages() {
        assert!(stays("tauri://localhost/home"));
        assert!(stays("http://tauri.localhost/connect"));
        assert!(stays("https://tauri.localhost/login"));
        assert!(stays("http://ipc.localhost/plugin:store|get"));
        assert!(stays("about:blank"));
        assert!(stays("blob:http://tauri.localhost/1234"));
        assert!(stays("cihub://auth/callback?code=abc"));
    }

    #[test]
    fn keeps_the_dev_server() {
        assert!(stays("http://lvh.me:5005/"));
        assert!(stays("http://localhost:5005/login"));
        assert!(stays("http://127.0.0.1:5005/"));
    }

    #[test]
    fn sends_hubs_apps_and_every_other_site_to_the_browser() {
        assert!(!stays("https://hub-core3-team.ci.computer/home"));
        assert!(!stays("https://openclaw-core3-team.ci.computer/"));
        assert!(!stays("https://freecut.ci0.pw/"));
        assert!(!stays("https://example.com/"));
        assert!(!stays("http://192.168.1.20:8400/"));
    }

    #[test]
    fn is_not_fooled_by_a_look_alike_host() {
        assert!(!stays("https://localhost.attacker.example/"));
        assert!(!stays("https://lvh.me.attacker.example/"));
        assert!(!stays("https://tauri.localhost.attacker.example/"));
        assert!(!stays("https://127.0.0.1.attacker.example/"));
    }
}
