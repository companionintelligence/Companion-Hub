//! Companion Hub — mobile (iOS/Android) shell.
//!
//! Unlike the desktop app (`packages/desktop`), a phone cannot *run* a Hub:
//! there is no Docker, no system tray, no port management, no self-updater.
//! This crate is therefore a thin remote client. It embeds the same React
//! frontend (`packages/frontend/dist/client`) and points it at a remote Hub
//! appliance that the user selects from the cloud device picker.
//!
//! The only native responsibility kept from desktop is **deep-link capture**:
//! the Portal SSO flow finishes by redirecting to `cihub://auth?token=…`, and
//! pairing flows use `cihub://pair?code=…`. We capture those, stash them, and
//! emit the same `deep-link-auth` / `deep-link-pair` events the frontend
//! already listens for, so the existing login/pairing code works unchanged.
//!
//! **App Intents** (iOS Siri/Shortcuts/Spotlight/Action Button) reuse the very
//! same channel: the Swift `AppIntent`s open `cihub://intent/<action>` URLs
//! (e.g. `cihub://intent/connect`, `cihub://intent/open?hub=Apple%20Hub`). We
//! capture those, stash the action, and emit a `deep-link-intent` event the
//! frontend routes to the right screen — so an intent needs no extra IPC.

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PendingPairingCode(Mutex::new(None)))
        .manage(PendingPortalAuth(Mutex::new(None)))
        .manage(PendingIntent(Mutex::new(None)))
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .invoke_handler(tauri::generate_handler![
            consume_pending_pairing_code,
            consume_pending_portal_auth,
            consume_pending_intent,
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

            // The deep-link plugin may have already captured the launch URL before
            // our listener was registered (cold start) — drain it here too.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_deep_link_url(&app_handle, url.as_ref());
                }
            }

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

fn handle_deep_link_url(app: &tauri::AppHandle, url: &str) {
    if let Some(code) = extract_pairing_code(url) {
        queue_pairing_code(app, &code);
        return;
    }

    if let Some(payload) = extract_portal_auth(url) {
        queue_portal_auth(app, payload);
        return;
    }

    if let Some(action) = extract_intent(url) {
        queue_intent(app, &action);
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
    use super::{extract_intent, extract_pairing_code, extract_portal_auth, PortalAuthPayload};

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
