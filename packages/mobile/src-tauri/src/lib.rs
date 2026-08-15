//! Companion Hub — mobile (iOS/Android) shell.
//!
//! Unlike the desktop app (`packages/desktop`), a phone cannot *run* a Hub:
//! there is no Docker, no system tray, no port management, no self-updater.
//! This crate is therefore a thin remote client. It embeds the same React
//! frontend (`packages/frontend/dist/client`) and points it at a remote Hub
//! appliance that the user selects from the cloud device picker.
//!
//! The only native responsibility kept from desktop is **deep-link capture**:
//! the Portal SSO flow finishes by redirecting to `cihub://auth?token=…`,
//! pairing flows use `cihub://pair?code=…`, and mobile OIDC PKCE returns via
//! `cihub://auth/callback?code=…`. We capture those, stash them, and emit
//! `deep-link-auth` / `deep-link-pair` / `deep-link-oidc` so the frontend can
//! finish the flow even when iOS relaunches the app (the desktop-only
//! `deep-link://new-url` event never fires on a phone).
//!
//! **App Intents** (iOS Siri/Shortcuts/Spotlight/Action Button) reuse the very
//! same channel: the Swift `AppIntent`s open `cihub://intent/<action>` URLs
//! (e.g. `cihub://intent/connect`, `cihub://intent/open?hub=Apple%20Hub`). We
//! capture those, stash the action, and emit a `deep-link-intent` event the
//! frontend routes to the right screen — so an intent needs no extra IPC.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// A pairing code captured from a `cihub://pair` deep link before the UI mounted.
struct PendingPairingCode(Mutex<Option<String>>);
/// A Portal SSO token captured from a `cihub://auth` deep link before the UI mounted.
struct PendingPortalAuth(Mutex<Option<PortalAuthPayload>>);
/// An App Intent action captured from a `cihub://intent/<action>` deep link
/// (Siri/Shortcuts/Spotlight) before the UI mounted.
struct PendingIntent(Mutex<Option<String>>);
/// An OIDC PKCE callback URL (`cihub://auth/callback?code=…&state=…`) captured
/// before the UI mounted — iOS often cold-starts the app from Safari.
struct PendingOidcCallback(Mutex<Option<String>>);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PortalAuthPayload {
    token: String,
}

/// Returns a pairing code from a deep link that arrived before the UI was ready.
#[tauri::command]
fn consume_pending_pairing_code(state: tauri::State<'_, PendingPairingCode>) -> Option<String> {
    state.0.lock().ok()?.take()
}

/// Returns the Portal SSO token from a deep link that arrived before the UI was ready.
#[tauri::command]
fn consume_pending_portal_auth(
    state: tauri::State<'_, PendingPortalAuth>,
) -> Option<PortalAuthPayload> {
    state.0.lock().ok()?.take()
}

/// Returns an App Intent action from a deep link that arrived before the UI was
/// ready (e.g. the app was cold-started by Siri/Shortcuts).
#[tauri::command]
fn consume_pending_intent(state: tauri::State<'_, PendingIntent>) -> Option<String> {
    state.0.lock().ok()?.take()
}

/// Returns the OIDC PKCE callback URL from a deep link that arrived before the
/// UI was ready (Safari → "Open with Companion Hub" often cold-starts us).
/// Peek, do not take: a `/connect` reload after the callback must still see it.
#[tauri::command]
fn consume_pending_oidc_callback(state: tauri::State<'_, PendingOidcCallback>) -> Option<String> {
    state.0.lock().ok()?.clone()
}

/// Drop a consumed OIDC callback after a successful (or failed) exchange.
#[tauri::command]
fn clear_pending_oidc_callback(state: tauri::State<'_, PendingOidcCallback>) {
    if let Ok(mut pending) = state.0.lock() {
        *pending = None;
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingPairingCode(Mutex::new(None)))
        .manage(PendingPortalAuth(Mutex::new(None)))
        .manage(PendingIntent(Mutex::new(None)))
        .manage(PendingOidcCallback(Mutex::new(None)))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            consume_pending_pairing_code,
            consume_pending_portal_auth,
            consume_pending_intent,
            consume_pending_oidc_callback,
            clear_pending_oidc_callback,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Some platforms deliver the launch URL as an argv entry on cold start.
            for arg in std::env::args().skip(1) {
                handle_deep_link_url(&app_handle, &arg);
            }

            let app_handle_for_listener = app_handle.clone();
            app.listen("deep-link://new-url", move |event| {
                handle_deep_link_payload(&app_handle_for_listener, event.payload());
            });

            // The canonical cross-platform handler. On **mobile** this is what
            // fires when a deep link arrives while the app is already running
            // (Android `onNewIntent` / iOS scene `openURL`) — the
            // `deep-link://new-url` event above only fires on desktop. Without
            // this, the Portal OIDC callback (`cihub://auth…`, which returns from
            // the system browser while the app is backgrounded) and App Intents
            // (`cihub://intent/*`) never reach the frontend once the app is open.
            let app_handle_for_open = app_handle.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link_url(&app_handle_for_open, url.as_str());
                }
            });

            // The deep-link plugin may have already captured the launch URL before
            // our handlers were registered (cold start) — drain it here too.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_deep_link_url(&app_handle, url.as_ref());
                }
            }

            // iOS may launch the webview on `cihub://`, `about:blank`, or the
            // mobile-dev `tauri://localhost` proxy (all paint as a black
            // WKWebView on iOS 26). Load the Vite / bundled frontend once the
            // window exists. Do not fire overlapping force-navigates: wry
            // `url_from_webview` unwraps a nil `WKWebView.URL` and aborts
            // (the Simulator "Reopen / Report" dialog).
            let handle = app_handle.clone();
            std::thread::spawn(move || {
                for delay_ms in [800_u64, 2000] {
                    std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    ensure_frontend_webview_on_main(&handle, false);
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Companion Hub Mobile");
}

fn queue_pairing_code(app: &tauri::AppHandle, code: &str) {
    if let Some(state) = app.try_state::<PendingPairingCode>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(code.to_string());
        }
    }
    let _ = app.emit("deep-link-pair", code);
}

fn queue_portal_auth(app: &tauri::AppHandle, payload: PortalAuthPayload) {
    if let Some(state) = app.try_state::<PendingPortalAuth>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(payload.clone());
        }
    }
    let _ = app.emit("deep-link-auth", payload);
}

fn queue_intent(app: &tauri::AppHandle, action: &str) {
    if let Some(state) = app.try_state::<PendingIntent>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(action.to_string());
        }
    }
    let _ = app.emit("deep-link-intent", action);
}

fn queue_oidc_callback(app: &tauri::AppHandle, url: &str) {
    if let Some(state) = app.try_state::<PendingOidcCallback>() {
        if let Ok(mut pending) = state.0.lock() {
            *pending = Some(url.to_string());
        }
    }
    // Dedicated mobile event — `deep-link://new-url` is desktop-only, so the
    // frontend's OIDC waiter would hang forever without this.
    let _ = app.emit("deep-link-oidc", url);
}

fn handle_deep_link_url(app: &tauri::AppHandle, url: &str) {
    // OIDC first: `cihub://auth/callback` also matches the `cihub://auth` prefix
    // used by the legacy token handoff, but must not be swallowed as portal-auth.
    if let Some(callback) = extract_oidc_callback(url) {
        eprintln!("[ci-hub-mobile] oidc callback captured");
        queue_oidc_callback(app, &callback);
        ensure_frontend_webview_on_main(app, false);
        return;
    }

    if let Some(code) = extract_pairing_code(url) {
        queue_pairing_code(app, &code);
        ensure_frontend_webview_on_main(app, false);
        return;
    }

    if let Some(payload) = extract_portal_auth(url) {
        queue_portal_auth(app, payload);
        ensure_frontend_webview_on_main(app, false);
        return;
    }

    if let Some(action) = extract_intent(url) {
        queue_intent(app, &action);
        ensure_frontend_webview_on_main(app, false);
    }
}

fn ensure_frontend_webview_on_main(app: &tauri::AppHandle, force: bool) {
    let handle = app.clone();
    if app
        .run_on_main_thread(move || {
            ensure_frontend_webview(&handle, force);
        })
        .is_err()
    {
        ensure_frontend_webview(app, force);
    }
}

fn webview_already_on_frontend(href: &str) -> bool {
    href.starts_with("http://localhost:")
        || href.starts_with("http://127.0.0.1:")
        || href.starts_with("http://lvh.me:")
        || href.starts_with("https://")
}

/// wry 0.55 `url_from_webview` does `webview.URL().unwrap()`. Never call
/// `window.url()` during startup — a nil URL aborts the process (SIGABRT).
static FRONTEND_NAVIGATED: AtomicBool = AtomicBool::new(false);

fn safe_navigate(window: &tauri::WebviewWindow, url: tauri::Url) -> Result<(), String> {
    match catch_unwind(AssertUnwindSafe(|| window.navigate(url))) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("wry panicked reading a nil WKWebView.URL".into()),
    }
}

/// WKWebView is black for `cihub://`, `about:blank`, and the mobile-dev
/// `tauri://localhost` proxy on iOS 26. Always load the real frontend over
/// HTTP — `window.url()` reports the logical Vite URL even when the document
/// is still the broken custom scheme, so we must not trust it.
fn ensure_frontend_webview(app: &tauri::AppHandle, force: bool) {
    let Some(start) = app_frontend_url(app) else {
        return;
    };
    let windows: Vec<_> = match app.get_webview_window("main") {
        Some(main) => vec![main],
        None => app.webview_windows().into_values().collect(),
    };
    if windows.is_empty() {
        eprintln!("[ci-hub-mobile] no webview yet; cannot load {start}");
        return;
    }
    for window in windows {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            let _ = window.set_background_color(Some(tauri::window::Color(0xf4, 0xf4, 0xf5, 0xff)));
        }));
        // Do not call `window.url()` — wry unwraps a nil WKWebView.URL on the
        // main run loop and the Simulator shows Apple's Reopen/Report dialog.
        if !force && FRONTEND_NAVIGATED.load(Ordering::SeqCst) {
            eprintln!("[ci-hub-mobile] keep webview on frontend (skip reload)");
            continue;
        }
        eprintln!("[ci-hub-mobile] navigate webview → {start}");
        match safe_navigate(&window, start.clone()) {
            Ok(()) => FRONTEND_NAVIGATED.store(true, Ordering::SeqCst),
            Err(error) => eprintln!("[ci-hub-mobile] navigate failed: {error}"),
        }
    }
}

fn app_frontend_url(_app: &tauri::AppHandle) -> Option<tauri::Url> {
    #[cfg(debug_assertions)]
    {
        // ios:dev must hit the Vite server. Falling through to tauri://localhost
        // is what left the Simulator on a black custom-scheme document.
        // `navigate()` is a raw WKWebView loadRequest — it is not rewritten to
        // `tauri://`. ATS only auto-allows cleartext HTTP to `localhost`
        // (`127.0.0.1` and public names like `lvh.me` are blocked).
        return tauri::Url::parse("http://localhost:5005/connect").ok();
    }

    #[cfg(not(debug_assertions))]
    {
        tauri::Url::parse("tauri://localhost/connect").ok()
    }
}

fn deep_link_urls_from_payload(payload: &str) -> Vec<String> {
    if let Ok(urls) = serde_json::from_str::<Vec<String>>(payload) {
        return urls;
    }

    let trimmed = payload.trim();
    if trimmed.starts_with('"') {
        if let Ok(url) = serde_json::from_str::<String>(trimmed) {
            return vec![url];
        }
    }

    if !trimmed.is_empty() {
        return vec![trimmed.to_string()];
    }

    Vec::new()
}

fn handle_deep_link_payload(app: &tauri::AppHandle, payload: &str) {
    for url in deep_link_urls_from_payload(payload) {
        handle_deep_link_url(app, &url);
    }
}

fn extract_pairing_code(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("cihub://pair") {
        return None;
    }
    if let Some(query) = trimmed.split('?').nth(1) {
        for param in query.split('&') {
            if let Some(code) = param.strip_prefix("code=") {
                let code = code.trim().to_uppercase();
                if code.len() == 6 && code.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return Some(code);
                }
            }
        }
    }
    if let Some(rest) = trimmed.strip_prefix("cihub://pair/") {
        let code = rest.split('?').next().unwrap_or("").trim().to_uppercase();
        if code.len() == 6 && code.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Some(code);
        }
    }
    None
}

fn extract_oidc_callback(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.starts_with("cihub://auth/callback") {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn extract_portal_auth(url: &str) -> Option<PortalAuthPayload> {
    let trimmed = url.trim();
    if !trimmed.starts_with("cihub://auth") {
        return None;
    }

    let query = trimmed.split('?').nth(1)?;
    for param in query.split('&') {
        if let Some(token) = param.strip_prefix("token=") {
            let token = token.trim();
            if !token.is_empty() {
                return Some(PortalAuthPayload {
                    token: token.to_string(),
                });
            }
        }
    }

    None
}

/// Pulls the action out of an App Intent deep link.
///
/// Accepts both the canonical path form `cihub://intent/<action>` (optionally
/// with a query, e.g. `cihub://intent/open?hub=Apple%20Hub`) and the legacy
/// host form `cihub://intent?action=<action>`. The returned string is the raw
/// action plus any query (`open?hub=Apple%20Hub`); the frontend parses it
/// further. URL-decoding of parameter values is left to the frontend.
fn extract_intent(url: &str) -> Option<String> {
    let trimmed = url.trim();

    if let Some(rest) = trimmed.strip_prefix("cihub://intent/") {
        let rest = rest.trim();
        // Strip a trailing slash on the bare-action form ("connect/").
        let normalized = if rest.contains('?') {
            rest.to_string()
        } else {
            rest.trim_end_matches('/').to_string()
        };
        if normalized.is_empty() {
            return None;
        }
        return Some(normalized);
    }

    // Host form: cihub://intent?action=connect
    if let Some(rest) = trimmed.strip_prefix("cihub://intent") {
        let query = rest.strip_prefix('?')?;
        for param in query.split('&') {
            if let Some(action) = param.strip_prefix("action=") {
                let action = action.trim();
                if !action.is_empty() {
                    return Some(action.to_string());
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{
        deep_link_urls_from_payload, extract_intent, extract_oidc_callback, extract_pairing_code,
        extract_portal_auth, webview_already_on_frontend, PortalAuthPayload,
    };

    #[test]
    fn frontend_href_accepts_vite_and_https_hubs() {
        assert!(webview_already_on_frontend("http://localhost:5005/connect"));
        assert!(webview_already_on_frontend("https://hub-core3-bc.companionintelligence.com/login"));
        assert!(!webview_already_on_frontend("tauri://localhost"));
        assert!(!webview_already_on_frontend("cihub://auth/callback"));
        assert!(!webview_already_on_frontend("about:blank"));
    }

    // --- deep_link_urls_from_payload -------------------------------------
    // Every deep link the plugin delivers passes through here first. The
    // payload shape varies by platform/version (JSON array, JSON-quoted
    // string, or bare URL), so all three must survive.

    #[test]
    fn payload_json_array_yields_every_url() {
        assert_eq!(
            deep_link_urls_from_payload(r#"["cihub://auth?token=a","cihub://pair?code=abc123"]"#),
            vec![
                "cihub://auth?token=a".to_string(),
                "cihub://pair?code=abc123".to_string()
            ]
        );
    }

    #[test]
    fn payload_json_quoted_string_is_unquoted() {
        // A JSON-encoded single string must be decoded, not passed through with
        // its quotes — otherwise the `cihub://` prefix checks all miss.
        assert_eq!(
            deep_link_urls_from_payload(r#""cihub://intent/connect""#),
            vec!["cihub://intent/connect".to_string()]
        );
    }

    #[test]
    fn payload_bare_url_is_passed_through() {
        assert_eq!(
            deep_link_urls_from_payload("cihub://intent/settings"),
            vec!["cihub://intent/settings".to_string()]
        );
    }

    #[test]
    fn payload_empty_or_blank_yields_nothing() {
        assert!(deep_link_urls_from_payload("").is_empty());
        assert!(deep_link_urls_from_payload("   ").is_empty());
        assert!(deep_link_urls_from_payload("[]").is_empty());
    }

    // --- extract_pairing_code validation ---------------------------------

    #[test]
    fn extract_pairing_code_enforces_six_alphanumerics() {
        // Wrong length or non-alphanumeric must not be queued as a pairing code.
        assert_eq!(extract_pairing_code("cihub://pair?code=abc12"), None); // 5
        assert_eq!(extract_pairing_code("cihub://pair?code=abc1234"), None); // 7
        assert_eq!(extract_pairing_code("cihub://pair?code=ab-123"), None); // punctuation
        assert_eq!(extract_pairing_code("cihub://pair?code="), None); // empty
        assert_eq!(extract_pairing_code("cihub://pair"), None); // no code at all
    }

    #[test]
    fn extract_pairing_code_reads_past_other_query_params() {
        assert_eq!(
            extract_pairing_code("cihub://pair?source=email&code=abc123"),
            Some("ABC123".to_string())
        );
    }

    #[test]
    fn extract_pairing_code_path_form_ignores_trailing_query() {
        assert_eq!(
            extract_pairing_code("cihub://pair/abc123?utm=x"),
            Some("ABC123".to_string())
        );
    }

    // --- extract_portal_auth validation ----------------------------------

    #[test]
    fn extract_portal_auth_rejects_missing_or_empty_token() {
        assert_eq!(extract_portal_auth("cihub://auth?token="), None);
        assert_eq!(extract_portal_auth("cihub://auth"), None); // no query
        assert_eq!(extract_portal_auth("cihub://auth?other=1"), None);
    }

    #[test]
    fn extract_portal_auth_reads_past_other_query_params() {
        assert_eq!(
            extract_portal_auth("cihub://auth?state=xyz&token=tok-123"),
            Some(PortalAuthPayload {
                token: "tok-123".to_string()
            })
        );
    }

    #[test]
    fn oidc_callback_is_claimed_as_oidc_not_portal_auth() {
        // iOS delivers `cihub://auth/callback` via on_open_url, not the
        // desktop-only `deep-link://new-url` event. Rust must stash + emit
        // `deep-link-oidc` — and must not swallow it as a portal-auth token.
        let cb = "cihub://auth/callback?code=authcode&state=abc";
        assert_eq!(extract_oidc_callback(cb), Some(cb.to_string()));
        assert_eq!(extract_portal_auth(cb), None);
        assert_eq!(extract_intent(cb), None);
        assert_eq!(extract_pairing_code(cb), None);
        assert_eq!(extract_oidc_callback("cihub://auth?token=tok-123"), None);
    }

    #[test]
    fn extract_pairing_code_from_query_param() {
        assert_eq!(
            extract_pairing_code("cihub://pair?code=abc123"),
            Some("ABC123".to_string())
        );
    }

    #[test]
    fn extract_pairing_code_from_path() {
        assert_eq!(
            extract_pairing_code("cihub://pair/abc123"),
            Some("ABC123".to_string())
        );
    }

    #[test]
    fn extract_portal_auth_token_from_query_param() {
        assert_eq!(
            extract_portal_auth("cihub://auth?token=mobile-token"),
            Some(PortalAuthPayload {
                token: "mobile-token".to_string()
            })
        );
    }

    #[test]
    fn ignore_non_auth_deep_links_for_portal_auth() {
        assert_eq!(extract_portal_auth("cihub://pair?code=abc123"), None);
    }

    #[test]
    fn extract_intent_bare_action() {
        assert_eq!(
            extract_intent("cihub://intent/connect"),
            Some("connect".to_string())
        );
        assert_eq!(
            extract_intent("cihub://intent/switch/"),
            Some("switch".to_string())
        );
    }

    #[test]
    fn extract_intent_keeps_query_for_parameterized_actions() {
        assert_eq!(
            extract_intent("cihub://intent/open?hub=Apple%20Hub"),
            Some("open?hub=Apple%20Hub".to_string())
        );
    }

    #[test]
    fn extract_intent_host_form() {
        assert_eq!(
            extract_intent("cihub://intent?action=settings"),
            Some("settings".to_string())
        );
    }

    #[test]
    fn extract_intent_rejects_empty_and_other_schemes() {
        assert_eq!(extract_intent("cihub://intent/"), None);
        assert_eq!(extract_intent("cihub://auth?token=x"), None);
        assert_eq!(extract_intent("cihub://pair?code=abc123"), None);
    }
}
