//! iOS in-app Safari authentication sheet (`ASWebAuthenticationSession`).
//!
//! Android and desktop never call this — the frontend falls through to the
//! system opener. The command still exists everywhere so a stale JS bundle
//! gets a structured error instead of a missing-command reject.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthSessionError {
    Cancelled,
    Unavailable,
    /// Built by the iOS sheet callback. Host `cargo test` never constructs it.
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    Failed(String),
}

impl AuthSessionError {
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub fn failed(message: impl Into<String>) -> Self {
        Self::Failed(message.into())
    }
}

impl std::fmt::Display for AuthSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "Sign-in cancelled"),
            Self::Unavailable => write!(f, "Could not open the sign-in sheet."),
            Self::Failed(message) => write!(f, "{message}"),
        }
    }
}

impl Serialize for AuthSessionError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("message", &self.to_string())?;
        map.serialize_entry(
            "code",
            match self {
                Self::Cancelled => "CANCELLED",
                Self::Unavailable | Self::Failed(_) => "FAILED",
            },
        )?;
        map.end()
    }
}

#[cfg(not(target_os = "ios"))]
pub async fn start(_url: &str, _callback_scheme: &str) -> Result<String, AuthSessionError> {
    Err(AuthSessionError::Unavailable)
}

#[cfg(target_os = "ios")]
pub async fn start(url: &str, callback_scheme: &str) -> Result<String, AuthSessionError> {
    ios::start(url, callback_scheme).await
}

#[cfg(target_os = "ios")]
mod ios {
    use super::AuthSessionError;
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::sync::mpsc;
    use std::sync::Mutex;

    type AuthSessionCallback = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char);

    unsafe extern "C" {
        fn cihub_start_auth_session(
            url: *const c_char,
            callback_scheme: *const c_char,
            cb: AuthSessionCallback,
        );
    }

    static PENDING: Mutex<Option<mpsc::Sender<Result<String, AuthSessionError>>>> =
        Mutex::new(None);

    unsafe extern "C" fn on_auth_session_done(
        url: *const c_char,
        code: *const c_char,
        message: *const c_char,
    ) {
        let result = if !url.is_null() {
            Ok(CStr::from_ptr(url).to_string_lossy().into_owned())
        } else {
            let code = if code.is_null() {
                String::new()
            } else {
                CStr::from_ptr(code).to_string_lossy().into_owned()
            };
            let message = if message.is_null() {
                "Sign-in failed".to_string()
            } else {
                CStr::from_ptr(message).to_string_lossy().into_owned()
            };
            if code == "CANCELLED" {
                Err(AuthSessionError::Cancelled)
            } else {
                Err(AuthSessionError::Failed(message))
            }
        };

        if let Ok(mut pending) = PENDING.lock() {
            if let Some(tx) = pending.take() {
                let _ = tx.send(result);
            }
        }
    }

    pub async fn start(url: &str, callback_scheme: &str) -> Result<String, AuthSessionError> {
        let url_c =
            CString::new(url).map_err(|_| AuthSessionError::failed("Invalid sign-in URL"))?;
        let scheme_c = CString::new(callback_scheme)
            .map_err(|_| AuthSessionError::failed("Invalid callback scheme"))?;
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = PENDING
                .lock()
                .map_err(|_| AuthSessionError::failed("Sign-in sheet is unavailable"))?;
            *pending = Some(tx);
        }

        unsafe {
            cihub_start_auth_session(url_c.as_ptr(), scheme_c.as_ptr(), on_auth_session_done);
        }

        tauri::async_runtime::spawn_blocking(move || {
            rx.recv().unwrap_or_else(|_| {
                Err(AuthSessionError::failed(
                    "Sign-in sheet closed unexpectedly",
                ))
            })
        })
        .await
        .map_err(|_| AuthSessionError::failed("Sign-in sheet closed unexpectedly"))?
    }
}

#[cfg(test)]
mod tests {
    use super::AuthSessionError;

    #[test]
    fn cancelled_serializes_the_code_the_js_hook_checks() {
        let json = serde_json::to_value(AuthSessionError::Cancelled).expect("serialize");
        assert_eq!(json["code"], "CANCELLED");
        assert_eq!(json["message"], "Sign-in cancelled");
    }

    #[test]
    fn missing_sheet_is_unavailable_not_a_cancel() {
        let json = serde_json::to_value(AuthSessionError::Unavailable).expect("serialize");
        assert_eq!(json["code"], "FAILED");
        assert_eq!(json["message"], "Could not open the sign-in sheet.");
    }
}
